import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { ApprovalsService } from '../approvals/approvals.service';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { RunNumberClient } from '../run-number/run-number.client';
import { FundFacts, fromSatang, toSatang } from './disbursement-rules';
import {
  CreateFundDto,
  CreateReplenishmentDto,
  PayDisbursementDto,
  UpdateFundDto,
} from './disbursement.dto';
import {
  DisbursementMovementRepository,
  DisbursementRepository,
  PettyCashFundRepository,
  PettyCashReplenishmentRepository,
} from './disbursement.repositories';

const REPLENISH_SUBJECT = 'disbursement:REPLENISH';
const SYSTEM = { actorId: null, actorUsername: 'system' } as const;

type Fund = Prisma.PettyCashFundGetPayload<object>;
type Replenishment = Prisma.PettyCashReplenishmentGetPayload<object>;

const satangOf = (value: Prisma.Decimal | string | number) =>
  toSatang(value.toString()) ?? 0;

/**
 * เงินสดย่อย — the imprest funds, their cash on hand (the sum of the
 * ledger), and the top-ups that bring a fund back to its imprest.
 * docs/disbursement.md §6.
 */
@Injectable()
export class PettyCashService implements OnModuleInit {
  private readonly logger = new Logger(PettyCashService.name);

  constructor(
    private readonly funds: PettyCashFundRepository,
    private readonly replenishments: PettyCashReplenishmentRepository,
    private readonly disbursements: DisbursementRepository,
    private readonly movements: DisbursementMovementRepository,
    private readonly approvals: ApprovalsService,
    private readonly runNumbers: RunNumberClient,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    for (const name of [
      DOMAIN_EVENTS.approvalCompleted,
      DOMAIN_EVENTS.approvalRejected,
    ]) {
      this.events.on(name, (event) => {
        const payload = event.payload as {
          case_id?: string;
          subject_type?: string;
          decision?: string;
        };
        if (payload.subject_type !== REPLENISH_SUBJECT || !payload.case_id) {
          return Promise.resolve();
        }
        return this.onDecided(payload.case_id, payload.decision).catch(
          (error: Error) =>
            this.logger.warn(`replenishment sync: ${error.message}`),
        );
      });
    }
  }

  // --- funds -----------------------------------------------------------------

  async listFunds(actor: Principal) {
    const rows = (await this.funds.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: { code: 'asc' },
    })) as Fund[];
    return Promise.all(rows.map((fund) => this.presentFund(fund)));
  }

  async fund(actor: Principal, code: string) {
    return this.presentFund(await this.requireFund(actor.activeCompanyId, code));
  }

  async openFund(actor: Principal, dto: CreateFundDto) {
    const companyId = actor.activeCompanyId;
    const taken = await this.funds.count({ where: { companyId, code: dto.code } });
    if (taken) throw new AppError('CONFLICT', `มีกองทุนรหัส ${dto.code} แล้ว`);
    await this.transactions.execute(async (prisma) => {
      const fund = await prisma.pettyCashFund.create({
        data: {
          companyId,
          code: dto.code,
          name: dto.name,
          custodianUserId: dto.custodian_user_id,
          orgUnitId: dto.org_unit_id ?? null,
          imprestAmount: fromSatang(satangOf(dto.imprest_amount)),
          perClaimLimit: fromSatang(satangOf(dto.per_claim_limit)),
          createdBy: actor.userId,
        },
      });
      await prisma.disbursementMovement.create({
        data: {
          companyId,
          fundId: fund.id,
          type: 'FUND_OPEN',
          amount: fund.imprestAmount,
          actedBy: actor.userId,
        },
      });
      await this.record(prisma, actor, 'disbursement.fund_opened', fund.id, {
        code: dto.code,
        imprest: fund.imprestAmount.toString(),
        custodian: dto.custodian_user_id,
      });
    });
    return this.fund(actor, dto.code);
  }

  /** A new imprest moves the cash by the difference, as an adjustment row. */
  async updateFund(actor: Principal, code: string, dto: UpdateFundDto) {
    const fund = await this.requireFund(actor.activeCompanyId, code);
    const before = satangOf(fund.imprestAmount);
    const after =
      dto.imprest_amount !== undefined ? satangOf(dto.imprest_amount) : before;
    await this.transactions.execute(async (prisma) => {
      await prisma.pettyCashFund.update({
        where: { id: fund.id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.custodian_user_id !== undefined
            ? { custodianUserId: dto.custodian_user_id }
            : {}),
          ...(dto.per_claim_limit !== undefined
            ? { perClaimLimit: fromSatang(satangOf(dto.per_claim_limit)) }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          imprestAmount: fromSatang(after),
          updatedBy: actor.userId,
        },
      });
      if (after !== before) {
        await prisma.disbursementMovement.create({
          data: {
            companyId: fund.companyId,
            fundId: fund.id,
            type: 'FUND_ADJUST',
            amount: fromSatang(after - before),
            note: `ปรับวงเงิน ${fromSatang(before)} → ${fromSatang(after)}`,
            actedBy: actor.userId,
          },
        });
      }
      await this.record(prisma, actor, 'disbursement.fund_updated', fund.id, {
        name: dto.name ?? null,
        custodian: dto.custodian_user_id ?? null,
        imprest: fromSatang(after),
        perClaimLimit: dto.per_claim_limit ?? null,
        active: dto.active ?? null,
      });
    });
    return this.fund(actor, code);
  }

  /** What the claim and payout rules need to know about a fund. */
  async factsOf(fundId: string | null): Promise<FundFacts | null> {
    if (!fundId) return null;
    const fund = (await this.funds.findFirst({ where: { id: fundId } })) as Fund | null;
    if (!fund) return null;
    return {
      custodianUserId: fund.custodianUserId,
      perClaimLimitSatang: satangOf(fund.perClaimLimit),
      cashOnHandSatang: await this.cashOnHandSatang(fund.id),
      active: fund.active,
    };
  }

  private async cashOnHandSatang(fundId: string): Promise<number> {
    const rows = (await this.movements.findMany({
      where: { fundId },
      select: { amount: true },
    })) as { amount: Prisma.Decimal }[];
    return rows.reduce((sum, row) => sum + satangOf(row.amount), 0);
  }

  // --- replenishment ---------------------------------------------------------

  /** Gathers every paid claim not yet topped up, and asks for the money. */
  async replenish(
    actor: Principal,
    dto: CreateReplenishmentDto,
    authorization: string,
  ) {
    const fund = await this.requireFund(actor.activeCompanyId, dto.fund_code);
    if (fund.custodianUserId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'เฉพาะผู้ถือเงินสดย่อยของกองทุนนี้เท่านั้นที่ขอเติมเงินได้');
    }
    const claims = (await this.disbursements.findMany({
      where: {
        fundId: fund.id,
        kind: 'PETTY_CASH',
        status: 'CLOSED',
        replenishmentId: null,
      },
      select: { id: true, paidAmount: true },
    })) as { id: string; paidAmount: Prisma.Decimal }[];
    if (!claims.length) {
      throw new AppError('CONFLICT', 'ยังไม่มีใบเบิกที่จ่ายแล้วรอเติมเงิน');
    }
    const total = claims.reduce((sum, c) => sum + satangOf(c.paidAmount), 0);
    const routed = await this.approvals.hasPublishedMatrix(
      REPLENISH_SUBJECT,
      fund.companyId,
      authorization,
    );
    const docNo = await this.runNumbers.issueUnused(
      { companyId: fund.companyId, docType: 'PETTY_REPLENISH' },
      async (code) =>
        (await this.replenishments.count({
          where: { companyId: fund.companyId, docNo: code },
        })) > 0,
    );

    const created = await this.transactions.execute(async (prisma) => {
      const row = await prisma.pettyCashReplenishment.create({
        data: {
          companyId: fund.companyId,
          docNo,
          fundId: fund.id,
          status: routed ? 'PENDING_APPROVAL' : 'APPROVED',
          totalAmount: fromSatang(total),
          ...(routed ? {} : { approvedAt: new Date() }),
          createdBy: actor.userId,
        },
      });
      // Claimed with the null guard, so two top-ups never take the same claim.
      const linked = await prisma.disbursement.updateMany({
        where: { id: { in: claims.map((c) => c.id) }, replenishmentId: null },
        data: { replenishmentId: row.id },
      });
      if (linked.count !== claims.length) {
        throw new AppError('CONFLICT', 'มีใบเบิกถูกนำไปเติมเงินในใบอื่นแล้ว กรุณาลองใหม่');
      }
      await this.record(prisma, actor, 'disbursement.replenishment_created', row.id, {
        docNo,
        fund: fund.code,
        claims: claims.length,
        total: fromSatang(total),
      });
      return row;
    });

    if (routed) {
      try {
        const opened = await this.approvals.openCase(
          {
            subject_type: REPLENISH_SUBJECT,
            subject_id: docNo,
            amount: fromSatang(total),
            currency: fund.currency,
            requester_user_id: actor.userId,
          },
          actor,
          authorization,
        );
        await this.replenishments.update({
          where: { id: created.id },
          data: { approvalCaseId: opened.id },
        });
      } catch (error) {
        await this.release(created.id, 'REJECTED');
        throw error;
      }
    }
    return this.replenishment(actor, docNo);
  }

  async replenishment(actor: Principal, docNo: string) {
    const row = (await this.replenishments.findFirst({
      where: { companyId: actor.activeCompanyId, docNo },
    })) as Replenishment | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบเติมเงินที่ระบุ');
    const claims = await this.disbursements.findMany({
      where: { replenishmentId: row.id },
      select: { docNo: true, requestNo: true, paidAmount: true, paidAt: true },
      orderBy: { paidAt: 'asc' },
    });
    return { ...row, totalAmount: row.totalAmount.toString(), claims };
  }

  async listReplenishments(actor: Principal, fundCode?: string) {
    const fund = fundCode
      ? await this.requireFund(actor.activeCompanyId, fundCode)
      : null;
    return this.replenishments.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(fund ? { fundId: fund.id } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Accounting transfers the top-up: the fund's cash is back at its imprest. */
  async payReplenishment(
    actor: Principal,
    docNo: string,
    dto: Pick<PayDisbursementDto, 'method' | 'reference'>,
  ) {
    const row = (await this.replenishments.findFirst({
      where: { companyId: actor.activeCompanyId, docNo },
    })) as Replenishment | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบเติมเงินที่ระบุ');
    if (row.status !== 'APPROVED') {
      throw new AppError('CONFLICT', 'โอนเติมเงินได้เฉพาะใบที่อนุมัติแล้ว');
    }
    await this.transactions.execute(async (prisma) => {
      const moved = await prisma.pettyCashReplenishment.updateMany({
        where: { id: row.id, status: 'APPROVED' },
        data: {
          status: 'PAID',
          paidBy: actor.userId,
          paidAt: new Date(),
          paymentRef: dto.reference ?? null,
        },
      });
      if (!moved.count) {
        throw new AppError('CONFLICT', 'ใบเติมเงินถูกเปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่');
      }
      await prisma.disbursementMovement.create({
        data: {
          companyId: row.companyId,
          fundId: row.fundId,
          replenishmentId: row.id,
          type: 'REPLENISH',
          amount: row.totalAmount,
          method: dto.method,
          reference: dto.reference ?? null,
          actedBy: actor.userId,
        },
      });
      await this.record(prisma, actor, 'disbursement.replenishment_paid', row.id, {
        total: row.totalAmount.toString(),
      });
    });
    return this.replenishment(actor, docNo);
  }

  /** The approver's decision on a top-up case. */
  async onDecided(caseId: string, decision?: string): Promise<void> {
    const row = (await this.replenishments.findFirst({
      where: { approvalCaseId: caseId, status: 'PENDING_APPROVAL' },
    })) as Replenishment | null;
    if (!row) return;
    if (decision === 'approved') {
      await this.transactions.execute(async (prisma) => {
        await prisma.pettyCashReplenishment.updateMany({
          where: { id: row.id, status: 'PENDING_APPROVAL' },
          data: { status: 'APPROVED', approvedAt: new Date() },
        });
        await this.audit.record(
          {
            eventType: 'disbursement.replenishment_approved',
            companyId: row.companyId,
            ...SYSTEM,
            resourceType: 'petty_cash_replenishment',
            resourceId: row.id,
          },
          { prisma },
        );
      });
      return;
    }
    await this.release(row.id, 'REJECTED');
  }

  /** A refused top-up lets its claims go into the next one. */
  private async release(id: string, status: 'REJECTED') {
    await this.transactions.execute(async (prisma) => {
      await prisma.pettyCashReplenishment.update({
        where: { id },
        data: { status },
      });
      await prisma.disbursement.updateMany({
        where: { replenishmentId: id },
        data: { replenishmentId: null },
      });
    });
  }

  private async requireFund(companyId: string, code: string): Promise<Fund> {
    const fund = (await this.funds.findFirst({
      where: { companyId, code },
    })) as Fund | null;
    if (!fund) throw new AppError('NOT_FOUND', 'ไม่พบกองทุนเงินสดย่อยที่ระบุ');
    return fund;
  }

  private async presentFund(fund: Fund) {
    const cash = await this.cashOnHandSatang(fund.id);
    return {
      code: fund.code,
      name: fund.name,
      custodianUserId: fund.custodianUserId,
      orgUnitId: fund.orgUnitId,
      currency: fund.currency,
      active: fund.active,
      imprestAmount: fund.imprestAmount.toString(),
      perClaimLimit: fund.perClaimLimit.toString(),
      cashOnHand: fromSatang(cash),
      /** Paid out and not yet topped up. */
      outstanding: fromSatang(satangOf(fund.imprestAmount) - cash),
    };
  }

  private record(
    prisma: Prisma.TransactionClient,
    actor: Principal,
    eventType: string,
    resourceId: string,
    after: Prisma.InputJsonObject,
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: eventType.includes('replenishment')
          ? 'petty_cash_replenishment'
          : 'petty_cash_fund',
        resourceId,
        after,
      },
      { prisma },
    );
  }
}
