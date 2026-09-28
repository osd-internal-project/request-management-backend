import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestsService } from '../requests/requests.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { CrmConfigRepository } from './segment.repositories';
import {
  NegotiationRoundRepository,
  OpportunityRepository,
  TradeTermStandardRepository,
} from './sales.repositories';
import {
  CreateNegotiationRoundDto,
  ReplaceTradeTermsDto,
} from './dto/sales.dto';
import {
  evaluateTerms,
  nonStandardLines,
  type RecordedTerm,
} from './trade-terms';

interface DealForNegotiation {
  id: string;
  companyId: string;
  opportunityCode: string;
  title: string;
  stage: string;
  customerId: string | null;
  prospectName: string | null;
  amount: Prisma.Decimal | null;
  customer: { nameTh: string } | null;
}

/**
 * CD-79 — การต่อรองเงื่อนไขการค้า: each round records what was agreed, term
 * by term, against the company's standard terms (CRM settings). A term that
 * departs from its standard — or one the list does not know — is flagged, and
 * a round with any flag goes to Legal at once as a contract-review request of
 * the type CD-81 configured (user decision 28 ก.ย. 2569: create and submit).
 *
 * The round is saved first and Legal second: a request that cannot be
 * submitted (no type set, a required field the type wants, no receiver) must
 * not lose the negotiation. What went wrong is kept on the round and shown on
 * the deal, and a created-but-unsubmitted request stays as the salesperson's
 * draft to finish.
 */
@Injectable()
export class NegotiationsService {
  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly rounds: NegotiationRoundRepository,
    private readonly standards: TradeTermStandardRepository,
    private readonly configs: CrmConfigRepository,
    private readonly members: CompanyMemberRepository,
    private readonly requests: RequestsService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The deal's rounds, newest first, with the standards the form offers. */
  async list(id: string, actor: Principal) {
    const deal = await this.requireVisible(id, actor);
    const [rows, standards] = await Promise.all([
      this.rounds.findMany({
        where: { opportunityId: id },
        orderBy: { roundNo: 'desc' },
      }) as Promise<({ createdBy: string } & Record<string, unknown>)[]>,
      this.activeStandards(deal.companyId),
    ]);
    const names = await this.displayNames(rows.map((row) => row.createdBy));
    return {
      standards,
      rounds: rows.map((row) => ({
        ...row,
        createdByName: names.get(row.createdBy) ?? row.createdBy,
      })),
    };
  }

  async record(
    id: string,
    dto: CreateNegotiationRoundDto,
    actor: Principal,
    authorization: string,
  ) {
    const deal = await this.requireOpen(id, actor);
    const standards = await this.activeStandards(deal.companyId);
    const { terms, problems } = evaluateTerms(dto.terms, standards);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'terms', reason })),
      );
    }
    const nonStandardCount = terms.filter((term) => term.nonStandard).length;

    const round = await this.transactions.execute(async (prisma) => {
      const last = (await this.rounds.findFirst(
        {
          where: { opportunityId: id },
          orderBy: { roundNo: 'desc' },
          select: { roundNo: true },
        },
        { prisma },
      )) as { roundNo: number } | null;
      const roundNo = (last?.roundNo ?? 0) + 1;

      const created = (await this.rounds.create(
        {
          data: {
            companyId: deal.companyId,
            opportunityId: id,
            roundNo,
            occurredOn: new Date(`${dto.occurred_on.slice(0, 10)}T00:00:00Z`),
            summary: dto.summary?.trim() || null,
            terms: terms as unknown as Prisma.InputJsonValue,
            nonStandardCount,
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string; roundNo: number };

      await this.audit.record(
        {
          eventType: 'crm.opportunity.negotiation_logged',
          companyId: deal.companyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: id,
          after: {
            roundId: created.id,
            roundNo,
            nonStandardCount,
            terms: terms as unknown as Prisma.InputJsonValue,
          },
        },
        { prisma },
      );

      if (deal.customerId) {
        await this.timeline.publish(
          {
            companyId: deal.companyId,
            customerId: deal.customerId,
            refType: 'opportunity',
            refId: id,
            eventType: 'opportunity.negotiation_logged',
            summary:
              `${deal.opportunityCode}: ต่อรองรอบที่ ${roundNo}` +
              (nonStandardCount
                ? ` — นอกมาตรฐาน ${nonStandardCount} รายการ ส่งฝ่ายกฎหมาย`
                : ' — ตามเงื่อนไขมาตรฐาน'),
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );
      }
      return created;
    });

    if (!nonStandardCount) return this.findRound(round.id);

    const sent = await this.sendToLegal(
      deal,
      round.roundNo,
      dto,
      terms,
      actor,
      authorization,
    );
    await this.rounds.update({
      where: { id: round.id },
      data: {
        legalRequestId: sent.requestId,
        legalSendError: sent.error,
      },
    });
    return this.findRound(round.id);
  }

  /** For the CRM settings screen: every standard, inactive included. */
  async listStandards(actor: Principal) {
    return this.standards.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /**
   * Replaces the company's list as the screen shows it. A code no longer sent
   * is deactivated, never deleted: rounds recorded against it keep their own
   * copy of the standard, and the code stays reserved.
   */
  async replaceStandards(dto: ReplaceTradeTermsDto, actor: Principal) {
    const codes = dto.terms.map((term) => term.code);
    const duplicate = codes.find((code, i) => codes.indexOf(code) !== i);
    if (duplicate) {
      throw new AppError('VALIDATION_FAILED', `รหัสเงื่อนไขซ้ำ: ${duplicate}`, [
        { field: 'terms', reason: duplicate },
      ]);
    }
    const companyId = actor.activeCompanyId;

    return this.transactions.execute(async (prisma) => {
      const before = (await this.standards.findMany(
        { where: { companyId } },
        { prisma },
      )) as {
        code: string;
        name: string;
        standardValue: string;
        active: boolean;
      }[];

      for (const [index, term] of dto.terms.entries()) {
        await this.standards.upsert(
          {
            where: { companyId_code: { companyId, code: term.code } },
            create: {
              companyId,
              code: term.code,
              name: term.name.trim(),
              standardValue: term.standard_value.trim(),
              sortOrder: index,
              active: term.active ?? true,
              updatedBy: actor.userId,
            },
            update: {
              name: term.name.trim(),
              standardValue: term.standard_value.trim(),
              sortOrder: index,
              active: term.active ?? true,
              updatedBy: actor.userId,
            },
          },
          { prisma },
        );
      }
      await this.standards.updateMany(
        {
          where: { companyId, code: { notIn: codes }, active: true },
          data: { active: false, updatedBy: actor.userId },
        },
        { prisma },
      );

      const after = (await this.standards.findMany(
        {
          where: { companyId },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        },
        { prisma },
      )) as Record<string, unknown>[];

      await this.audit.record(
        {
          eventType: 'crm.trade_terms.replaced',
          companyId,
          ...auditActor(actor),
          resourceType: 'trade_term_standard',
          resourceId: companyId,
          before,
          after: after as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
      return after;
    });
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Create and submit the contract-review request. Every failure is caught
   * and returned as the reason — the round is already saved and must stay so.
   */
  private async sendToLegal(
    deal: DealForNegotiation,
    roundNo: number,
    dto: CreateNegotiationRoundDto,
    terms: RecordedTerm[],
    actor: Principal,
    authorization: string,
  ): Promise<{ requestId: string | null; error: string | null }> {
    const config = (await this.configs.findFirst({
      where: { companyId: deal.companyId },
      select: { contractRequestTypeCode: true },
    })) as { contractRequestTypeCode: string | null } | null;
    const typeCode = config?.contractRequestTypeCode;
    if (!typeCode) {
      return {
        requestId: null,
        error:
          'ยังไม่ได้ตั้งประเภทคำขอสัญญาในหน้าตั้งค่า CRM — ยังไม่ได้ส่งฝ่ายกฎหมาย',
      };
    }

    const lines = nonStandardLines(terms);
    let requestId: string;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'opportunity',
          ref_id: deal.opportunityCode,
          // Named for the demo CTR form; a company's own type ignores keys
          // its form does not have, and says at submit what it still needs.
          form_data: {
            contract_kind: 'ทำสัญญาใหม่',
            counterparty: deal.customer?.nameTh ?? deal.prospectName ?? '',
            ...(deal.amount !== null
              ? { contract_value: Number(deal.amount) }
              : {}),
            scope:
              `ตรวจเงื่อนไขนอกมาตรฐาน — ${deal.opportunityCode} ${deal.title} · ต่อรองรอบที่ ${roundNo} (${dto.occurred_on.slice(0, 10)})` +
              (dto.summary?.trim() ? `\n${dto.summary.trim()}` : ''),
            non_standard_terms: lines,
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
    } catch (error) {
      return {
        requestId: null,
        error: `สร้างคำขอส่งฝ่ายกฎหมายไม่ได้: ${messageOf(error)}`,
      };
    }

    try {
      await this.requests.submit(requestId, actor, authorization);
      return { requestId, error: null };
    } catch (error) {
      return {
        requestId,
        error: `สร้างร่างคำขอแล้วแต่ยื่นไม่ผ่าน: ${messageOf(error)} — เปิดร่างเพื่อกรอกให้ครบแล้วยื่น`,
      };
    }
  }

  private async findRound(id: string) {
    return this.rounds.findFirst({ where: { id } });
  }

  private activeStandards(companyId: string) {
    return this.standards.findMany({
      where: { companyId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { code: true, name: true, standardValue: true },
    }) as Promise<{ code: string; name: string; standardValue: string }[]>;
  }

  private async requireVisible(
    id: string,
    actor: Principal,
  ): Promise<DealForNegotiation> {
    const found = (await this.opportunities.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      select: {
        id: true,
        companyId: true,
        opportunityCode: true,
        title: true,
        stage: true,
        customerId: true,
        prospectName: true,
        amount: true,
        customer: { select: { nameTh: true } },
      },
    })) as DealForNegotiation | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    return found;
  }

  private async requireOpen(id: string, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    if (found.stage === 'won' || found.stage === 'lost') {
      throw new AppError(
        'CONFLICT',
        'โอกาสการขายนี้ปิดแล้ว — บันทึกการต่อรองไม่ได้',
      );
    }
    return found;
  }

  private async displayNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
