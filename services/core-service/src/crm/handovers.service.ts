import { Injectable, Logger } from '@nestjs/common';
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
import { OrgUnitRepository } from '../access/org-unit.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { HandoverTechnicalService } from './handover-technical.service';
import {
  HandoverChecklistItemRepository,
  SalesHandoverRepository,
} from './handover.repositories';
import {
  checklistGaps,
  mergeChecklist,
  type ChecklistTemplateItem,
  type HandoverHistoryEntry,
  type HandoverItem,
} from './handover-rules';
import { OpportunityRepository } from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';
import type {
  HandoverListQueryDto,
  ReplaceHandoverItemsDto,
  SaveHandoverDto,
} from './dto/sales.dto';

type HandoverStatus = 'draft' | 'submitted' | 'accepted' | 'returned';

interface DealForHandover {
  id: string;
  companyId: string;
  opportunityCode: string;
  title: string;
  stage: string;
  amount: Prisma.Decimal | null;
  customerId: string | null;
  prospectName: string | null;
  ownerUserId: string;
  customer: { nameTh: string } | null;
}

interface HandoverRow {
  id: string;
  companyId: string;
  opportunityId: string;
  status: HandoverStatus;
  toOrgUnitId: string | null;
  items: unknown;
  note: string | null;
  round: number;
  submittedBy: string | null;
  submittedAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  returnReason: string | null;
  history: unknown;
  solutionVersionId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const DEAL_SELECT = {
  id: true,
  companyId: true,
  opportunityCode: true,
  title: true,
  stage: true,
  amount: true,
  customerId: true,
  prospectName: true,
  ownerUserId: true,
  customer: { select: { nameTh: true } },
} as const;

/** A handover the salesperson may still change. */
const EDITABLE: readonly HandoverStatus[] = ['draft', 'returned'];

/**
 * CD-84 — ส่งมอบงานต่อ (user decisions 29 ก.ย. 2569):
 *
 * - a deal that is won (its sale order is open) gets a handover; opening the
 *   sale order and SAP are not held up by it;
 * - the checklist is the company's own list (CRM settings), in three groups
 *   — commercial facts, what the customer needs, what was promised. Every
 *   line must be ticked, and a line marked "needs detail" must say what;
 *   anything short of that cannot be sent;
 * - it goes to a team (the company default, changeable per deal), whose head
 *   is told; anyone in that team, or leading it, accepts it or returns it
 *   with a reason, and a returned one is fixed and sent again.
 *
 * The handover keeps its own copy of the list as it was answered, so an
 * admin editing the list later changes nothing already sent.
 */
@Injectable()
export class HandoversService {
  private readonly logger = new Logger(HandoversService.name);

  constructor(
    private readonly handovers: SalesHandoverRepository,
    private readonly checklist: HandoverChecklistItemRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly configs: CrmConfigRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly members: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly technical: HandoverTechnicalService,
  ) {}

  // --- the deal's side -----------------------------------------------------

  /** The deal's handover (or null), with the checklist the form shows. */
  async forDeal(opportunityId: string, actor: Principal) {
    const deal = await this.requireVisible(opportunityId, actor);
    const row = await this.findByDeal(opportunityId);
    const editable =
      deal.stage === 'won' && (!row || EDITABLE.includes(row.status));
    const items = editable
      ? mergeChecklist(
          await this.activeItems(deal.companyId),
          itemsOf(row?.items),
        )
      : itemsOf(row?.items);
    // CD-144 — what goes with it: fixed once sent, the latest approval before.
    const candidate = await this.technical.candidate(opportunityId);
    const sent = row && !EDITABLE.includes(row.status);
    return {
      dealWon: deal.stage === 'won',
      editable,
      defaultOrgUnitId: await this.defaultTeam(deal.companyId),
      items,
      handover: row ? (await this.decorate([row]))[0] : null,
      technical: await this.technical.packageOf(
        sent ? row.solutionVersionId : (candidate.version?.id ?? null),
      ),
      // A deal with Pre-Sales work goes only with an approved version.
      technicalMissing: !sent && candidate.hasSolution && !candidate.version,
    };
  }

  /** Save as a draft — unticked lines and all. */
  async save(opportunityId: string, dto: SaveHandoverDto, actor: Principal) {
    const deal = await this.requireWon(opportunityId, actor);
    const row = await this.findByDeal(opportunityId);
    this.assertEditable(row);
    const draft = await this.compose(deal, row, dto);

    await this.transactions.execute(async (prisma) => {
      await this.write(deal, row, draft, actor, prisma, {});
      await this.audit.record(
        {
          eventType: 'crm.handover.saved',
          companyId: deal.companyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: deal.id,
          after: {
            toOrgUnitId: draft.toOrgUnitId,
            items: draft.items as unknown as Prisma.InputJsonValue,
          },
        },
        { prisma },
      );
    });
    return this.forDeal(opportunityId, actor);
  }

  /** Send to the team. Refused, naming every gap, while anything is missing. */
  async submit(opportunityId: string, dto: SaveHandoverDto, actor: Principal) {
    const deal = await this.requireWon(opportunityId, actor);
    const row = await this.findByDeal(opportunityId);
    this.assertEditable(row);
    const draft = await this.compose(deal, row, dto);

    const gaps = checklistGaps(draft.items);
    if (!draft.toOrgUnitId) gaps.unshift('ต้องเลือกทีมที่รับงานต่อ');
    // CD-144 — the technical package: the deal's latest approved Solution.
    const candidate = await this.technical.candidate(opportunityId);
    if (candidate.hasSolution && !candidate.version) {
      gaps.push(
        'ดีลนี้มี Solution แต่ยังไม่มีเวอร์ชันที่อนุมัติ — ขออนุมัติ Solution ก่อนส่งมอบ',
      );
    }
    if (gaps.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ส่งมอบไม่ได้ — ยังไม่ครบ ${gaps.length} รายการ`,
        gaps.map((reason) => ({ field: 'items', reason })),
      );
    }

    const round = (row?.round ?? 0) + 1;
    const now = new Date();
    const saved = await this.transactions.execute(async (prisma) => {
      const written = await this.write(deal, row, draft, actor, prisma, {
        status: 'submitted',
        round,
        submittedBy: actor.userId,
        submittedAt: now,
        solutionVersionId: candidate.version?.id ?? null,
        decidedBy: null,
        decidedAt: null,
        history: [
          ...historyOf(row?.history),
          entry('submitted', actor, round, now, null),
        ] as unknown,
      });
      await this.audit.record(
        {
          eventType: 'crm.handover.submitted',
          companyId: deal.companyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: deal.id,
          after: {
            handoverId: written.id,
            round,
            toOrgUnitId: draft.toOrgUnitId,
            items: draft.items as unknown as Prisma.InputJsonValue,
            solutionVersionId: candidate.version?.id ?? null,
          },
        },
        { prisma },
      );
      await this.publishTimeline(
        deal,
        `${deal.opportunityCode}: ส่งมอบงานให้ทีม ${await this.unitName(draft.toOrgUnitId)}` +
          (round > 1 ? ` (ส่งครั้งที่ ${round})` : ''),
        'opportunity.handover_submitted',
        actor,
        prisma,
      );
      return written;
    });

    await this.tell(
      [await this.headOf(draft.toOrgUnitId!, actor.userId)],
      'submitted',
      saved.id,
      deal,
      draft.toOrgUnitId,
      actor,
    );
    return this.forDeal(opportunityId, actor);
  }

  // --- the receiving team's side -------------------------------------------

  /**
   * `incoming` — sent to a team I am in or lead; `sent` — ones I sent or on
   * my own deals. Drafts are the salesperson's own business and never listed.
   */
  async list(actor: Principal, query: HandoverListQueryDto) {
    const status = query.status
      ? { status: query.status }
      : { status: { not: 'draft' as const } };
    const where =
      query.box === 'sent'
        ? {
            companyId: actor.activeCompanyId,
            ...status,
            OR: [
              { submittedBy: actor.userId },
              { opportunity: { ownerUserId: actor.userId } },
            ],
          }
        : {
            companyId: actor.activeCompanyId,
            ...status,
            toOrgUnitId: { in: [...receiverUnits(actor)] },
          };
    const rows = (await this.handovers.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })) as HandoverRow[];
    return this.decorate(rows, actor);
  }

  /** One handover — to its team, or to whoever can see the deal. */
  async findOne(id: string, actor: Principal) {
    const row = await this.requireReadable(id, actor);
    return {
      ...(await this.decorate([row], actor))[0],
      // CD-144 — the technical package the team receives with it.
      technical: await this.technical.packageOf(row.solutionVersionId),
    };
  }

  /** CD-144 — a design file of the handover's package, to whoever may read it. */
  async technicalFile(id: string, fileId: string, actor: Principal) {
    const row = await this.requireReadable(id, actor);
    const file = await this.technical.fileOf(row.solutionVersionId, fileId);
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return file;
  }

  async accept(id: string, actor: Principal) {
    return this.decide(id, actor, 'accepted', null);
  }

  async returnToSales(id: string, reason: string, actor: Principal) {
    const why = reason.trim();
    if (!why) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่ตีกลับ', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    return this.decide(id, actor, 'returned', why);
  }

  // --- CRM settings ----------------------------------------------------------

  /** Every line, inactive included — the settings screen shows them all. */
  async listItems(actor: Principal) {
    return this.checklist.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  /**
   * Replaces the company's list as the screen shows it. A code no longer
   * sent is deactivated, never deleted: handovers keep their own copy.
   */
  async replaceItems(dto: ReplaceHandoverItemsDto, actor: Principal) {
    const codes = dto.items.map((item) => item.code);
    const duplicate = codes.find((code, i) => codes.indexOf(code) !== i);
    if (duplicate) {
      throw new AppError('VALIDATION_FAILED', `รหัสรายการซ้ำ: ${duplicate}`, [
        { field: 'items', reason: duplicate },
      ]);
    }
    const companyId = actor.activeCompanyId;

    return this.transactions.execute(async (prisma) => {
      const before = (await this.checklist.findMany(
        { where: { companyId } },
        { prisma },
      )) as unknown as Prisma.InputJsonValue;

      for (const [index, item] of dto.items.entries()) {
        const fields = {
          category: item.category,
          label: item.label.trim(),
          requiresDetail: item.requires_detail ?? false,
          sortOrder: index,
          active: item.active ?? true,
          updatedBy: actor.userId,
        };
        await this.checklist.upsert(
          {
            where: { companyId_code: { companyId, code: item.code } },
            create: { companyId, code: item.code, ...fields },
            update: fields,
          },
          { prisma },
        );
      }
      await this.checklist.updateMany(
        {
          where: { companyId, code: { notIn: codes }, active: true },
          data: { active: false, updatedBy: actor.userId },
        },
        { prisma },
      );

      const after = (await this.checklist.findMany(
        {
          where: { companyId },
          orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        },
        { prisma },
      )) as Record<string, unknown>[];

      await this.audit.record(
        {
          eventType: 'crm.handover_items.replaced',
          companyId,
          ...auditActor(actor),
          resourceType: 'handover_checklist_item',
          resourceId: companyId,
          before,
          after: after as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
      return after;
    });
  }

  // --- helpers ---------------------------------------------------------------

  private async decide(
    id: string,
    actor: Principal,
    outcome: 'accepted' | 'returned',
    reason: string | null,
  ) {
    const row = await this.requireReadable(id, actor);
    if (!row.toOrgUnitId || !receiverUnits(actor).has(row.toOrgUnitId)) {
      throw new AppError(
        'FORBIDDEN',
        'รับหรือตีกลับได้เฉพาะคนในทีมที่ได้รับงานนี้',
      );
    }
    if (row.status !== 'submitted') {
      throw new AppError('CONFLICT', 'งานส่งมอบนี้ไม่ได้รอรับอยู่');
    }
    const deal = (await this.opportunities.findFirst({
      where: { id: row.opportunityId },
      select: DEAL_SELECT,
    })) as unknown as DealForHandover;
    const now = new Date();

    await this.transactions.execute(async (prisma) => {
      // Guarded: two people in the team acting at once — one wins.
      const claimed = await this.handovers.updateMany(
        {
          where: { id, status: 'submitted' },
          data: {
            status: outcome,
            decidedBy: actor.userId,
            decidedAt: now,
            returnReason: reason,
            history: [
              ...historyOf(row.history),
              entry(outcome, actor, row.round, now, reason),
            ] as unknown as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (claimed.count !== 1) {
        throw new AppError('CONFLICT', 'งานส่งมอบนี้ไม่ได้รอรับอยู่');
      }
      await this.audit.record(
        {
          eventType: `crm.handover.${outcome}`,
          companyId: row.companyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: row.opportunityId,
          after: { handoverId: id, round: row.round, reason },
        },
        { prisma },
      );
      await this.publishTimeline(
        deal,
        outcome === 'accepted'
          ? `${deal.opportunityCode}: ทีม ${await this.unitName(row.toOrgUnitId)} รับงานส่งมอบแล้ว`
          : `${deal.opportunityCode}: ทีม ${await this.unitName(row.toOrgUnitId)} ตีกลับงานส่งมอบ — ${reason}`,
        `opportunity.handover_${outcome}`,
        actor,
        prisma,
      );
    });

    await this.tell(
      [deal.ownerUserId, row.submittedBy],
      outcome,
      id,
      deal,
      row.toOrgUnitId,
      actor,
      reason ?? undefined,
    );
    return this.findOne(id, actor);
  }

  /** The checklist and team as they would be saved — nothing written yet. */
  private async compose(
    deal: DealForHandover,
    row: HandoverRow | null,
    dto: SaveHandoverDto,
  ): Promise<{
    items: HandoverItem[];
    toOrgUnitId: string | null;
    note: string | null;
  }> {
    const items = mergeChecklist(
      await this.activeItems(deal.companyId),
      dto.items,
    );
    const toOrgUnitId =
      dto.to_org_unit_id === undefined
        ? (row?.toOrgUnitId ?? (await this.defaultTeam(deal.companyId)))
        : dto.to_org_unit_id || null;
    if (toOrgUnitId) {
      const unit = await this.orgUnits.findFirst({
        where: { id: toOrgUnitId, companyId: deal.companyId, active: true },
        select: { id: true },
      });
      if (!unit) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบทีมที่เลือก', [
          { field: 'to_org_unit_id', reason: 'not_found' },
        ]);
      }
    }
    return {
      items,
      toOrgUnitId,
      note:
        dto.note === undefined ? (row?.note ?? null) : dto.note.trim() || null,
    };
  }

  private async write(
    deal: DealForHandover,
    row: HandoverRow | null,
    draft: {
      items: HandoverItem[];
      toOrgUnitId: string | null;
      note: string | null;
    },
    actor: Principal,
    prisma: Prisma.TransactionClient,
    extra: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const fields = {
      toOrgUnitId: draft.toOrgUnitId,
      note: draft.note,
      items: draft.items as unknown as Prisma.InputJsonValue,
      updatedBy: actor.userId,
      ...extra,
    };
    if (!row) {
      return await this.handovers.create(
        {
          data: {
            companyId: deal.companyId,
            opportunityId: deal.id,
            createdBy: actor.userId,
            ...fields,
          },
        },
        { prisma },
      );
    }
    // Guarded against the team deciding meanwhile.
    const moved = await this.handovers.updateMany(
      { where: { id: row.id, status: { in: [...EDITABLE] } }, data: fields },
      { prisma },
    );
    if (moved.count !== 1) {
      throw new AppError('CONFLICT', 'งานส่งมอบนี้ส่งไปแล้ว — แก้ไม่ได้');
    }
    return { id: row.id };
  }

  private assertEditable(row: HandoverRow | null) {
    if (row && !EDITABLE.includes(row.status)) {
      throw new AppError(
        'CONFLICT',
        row.status === 'accepted'
          ? 'ทีมรับงานนี้แล้ว — แก้ไม่ได้'
          : 'ส่งมอบแล้ว รอทีมรับ — แก้ไม่ได้จนกว่าจะถูกตีกลับ',
      );
    }
  }

  private async tell(
    userIds: readonly (string | null)[],
    event: 'submitted' | 'accepted' | 'returned',
    handoverId: string,
    deal: DealForHandover,
    toOrgUnitId: string | null,
    actor: Principal,
    reason?: string,
  ) {
    const recipients = userIds.filter(
      (userId): userId is string => Boolean(userId) && userId !== actor.userId,
    );
    if (!recipients.length) {
      if (event === 'submitted') {
        this.logger.warn(
          `handover ${handoverId}: team ${toOrgUnitId} has no head to tell`,
        );
      }
      return;
    }
    try {
      await this.notifications.handoverChanged(
        recipients,
        deal.companyId,
        event,
        { id: handoverId },
        {
          opportunity_code: deal.opportunityCode,
          opportunity_title: deal.title,
          customer_name: deal.customer?.nameTh ?? deal.prospectName ?? '',
          team_name: await this.unitName(toOrgUnitId),
          sender_name: actor.displayName,
          actor_name: actor.displayName,
          reason,
        },
      );
    } catch (error) {
      // The handover is saved; a notice that failed must not undo it.
      this.logger.warn(
        `handover ${handoverId} notice: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Nearest head at or above the team who is not the sender. */
  private async headOf(unitId: string, senderId: string) {
    const heads = await this.orgUnits.managersOf(
      await this.orgUnits.ancestorIdsOf(unitId),
    );
    return heads.find((userId) => userId !== senderId) ?? null;
  }

  private async publishTimeline(
    deal: DealForHandover,
    summary: string,
    eventType: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
  ) {
    if (!deal.customerId) return;
    await this.timeline.publish(
      {
        companyId: deal.companyId,
        customerId: deal.customerId,
        refType: 'opportunity',
        refId: deal.id,
        eventType,
        summary,
        actorId: auditActor(actor).actorId,
        actorName: actor.displayName,
      },
      { prisma },
    );
  }

  /** Names for the screen: the team, the people, and the deal it is about. */
  private async decorate(rows: HandoverRow[], actor?: Principal) {
    if (!rows.length) return [];
    const deals = (await this.opportunities.findMany({
      where: { id: { in: rows.map((row) => row.opportunityId) } },
      select: DEAL_SELECT,
    })) as unknown as DealForHandover[];
    const dealById = new Map(deals.map((deal) => [deal.id, deal]));
    const unitIds = [
      ...new Set(rows.map((row) => row.toOrgUnitId).filter(isString)),
    ];
    const units = unitIds.length
      ? ((await this.orgUnits.findMany({
          where: { id: { in: unitIds } },
          select: { id: true, name: true },
        })) as { id: string; name: string }[])
      : [];
    const unitName = new Map(units.map((unit) => [unit.id, unit.name]));
    const names = await this.displayNames(
      rows.flatMap((row) => [
        row.submittedBy,
        row.decidedBy,
        dealById.get(row.opportunityId)?.ownerUserId ?? null,
      ]),
    );
    const mine = actor ? receiverUnits(actor) : new Set<string>();

    return rows.map((row) => {
      const deal = dealById.get(row.opportunityId);
      return {
        ...row,
        items: itemsOf(row.items),
        history: historyOf(row.history),
        toOrgUnitName: row.toOrgUnitId
          ? (unitName.get(row.toOrgUnitId) ?? null)
          : null,
        submittedByName: row.submittedBy
          ? (names.get(row.submittedBy) ?? row.submittedBy)
          : null,
        decidedByName: row.decidedBy
          ? (names.get(row.decidedBy) ?? row.decidedBy)
          : null,
        canDecide:
          row.status === 'submitted' &&
          !!row.toOrgUnitId &&
          mine.has(row.toOrgUnitId),
        opportunity: deal
          ? {
              id: deal.id,
              opportunityCode: deal.opportunityCode,
              title: deal.title,
              amount: deal.amount,
              customerId: deal.customerId,
              customerName: deal.customer?.nameTh ?? deal.prospectName,
              ownerUserId: deal.ownerUserId,
              ownerName: names.get(deal.ownerUserId) ?? deal.ownerUserId,
            }
          : null,
      };
    });
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter(isString))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  private async unitName(unitId: string | null): Promise<string> {
    if (!unitId) return '-';
    const unit = (await this.orgUnits.findFirst({
      where: { id: unitId },
      select: { name: true },
    })) as { name: string } | null;
    return unit?.name ?? '-';
  }

  private async activeItems(
    companyId: string,
  ): Promise<ChecklistTemplateItem[]> {
    return await this.checklist.findMany({
      where: { companyId, active: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      select: { code: true, category: true, label: true, requiresDetail: true },
    });
  }

  private async defaultTeam(companyId: string): Promise<string | null> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { handoverOrgUnitId: true },
    })) as { handoverOrgUnitId: string | null } | null;
    return config?.handoverOrgUnitId ?? null;
  }

  private async findByDeal(opportunityId: string) {
    return (await this.handovers.findFirst({
      where: { opportunityId },
    })) as HandoverRow | null;
  }

  /** Readable by its team (member or head), or by anyone who can see the deal. */
  private async requireReadable(id: string, actor: Principal) {
    const row = (await this.handovers.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as HandoverRow | null;
    if (row && row.status !== 'draft') {
      if (row.toOrgUnitId && receiverUnits(actor).has(row.toOrgUnitId)) {
        return row;
      }
    }
    if (row) {
      const visible = await this.opportunities.findFirst({
        where: {
          id: row.opportunityId,
          AND: [visibleSalesWhere(salesAccessSubject(actor))],
        },
        select: { id: true },
      });
      if (visible) return row;
    }
    // SCOPE-03: out of reach answers 404.
    throw new AppError('NOT_FOUND', 'ไม่พบงานส่งมอบที่ระบุ');
  }

  private async requireVisible(
    id: string,
    actor: Principal,
  ): Promise<DealForHandover> {
    const found = (await this.opportunities.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      select: DEAL_SELECT,
    })) as DealForHandover | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    return found;
  }

  private async requireWon(id: string, actor: Principal) {
    const deal = await this.requireVisible(id, actor);
    if (deal.stage !== 'won') {
      throw new AppError(
        'CONFLICT',
        'ส่งมอบงานได้เมื่อโอกาสการขายชนะแล้ว (เปิดใบสั่งขายแล้ว)',
      );
    }
    return deal;
  }
}

/** The teams whose handovers this person may accept: their own and those they lead. */
function receiverUnits(actor: Principal): Set<string> {
  return new Set(
    [actor.orgUnitId, ...(actor.ledUnitIds ?? [])].filter(isString),
  );
}

function entry(
  action: HandoverHistoryEntry['action'],
  actor: Principal,
  round: number,
  at: Date,
  reason: string | null,
): HandoverHistoryEntry {
  return {
    action,
    at: at.toISOString(),
    by: actor.userId,
    byName: actor.displayName,
    round,
    reason,
  };
}

function itemsOf(value: unknown): HandoverItem[] {
  return Array.isArray(value) ? (value as HandoverItem[]) : [];
}

function historyOf(value: unknown): HandoverHistoryEntry[] {
  return Array.isArray(value) ? (value as HandoverHistoryEntry[]) : [];
}

function isString(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
