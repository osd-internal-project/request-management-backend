import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { CustomerRepository } from '../crm/customer.repository';
import { OpportunitiesService } from '../crm/opportunities.service';
import { OpportunityRepository } from '../crm/sales.repositories';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestRepository } from '../requests/request.repository';
import {
  DONE_STATUSES,
  isOverdue,
  MAX_LEAD_DAYS,
  offerDue,
  opensNow,
  planProblems,
  pmSchedule,
  remindersReached,
  type PmInterval,
} from './pm-rules';
import {
  ListPmRoundsQueryDto,
  SavePmPlanDto,
  SkipPmRoundDto,
} from './support.dto';
import {
  ServiceEntitlementAssetRepository,
  ServiceEntitlementRepository,
  ServiceMaOfferRepository,
  ServicePmPlanRepository,
  ServicePmRoundRepository,
} from './support.repositories';
import { WorkOrdersService } from './work-orders.service';

interface EntitlementRow {
  id: string;
  companyId: string;
  customerId: string;
  contractId: string | null;
  kind: string;
  title: string;
  startOn: Date;
  endOn: Date;
  preventiveQuota: number | null;
  cancelledAt: Date | null;
}

interface PlanRow {
  id: string;
  companyId: string;
  entitlementId: string;
  interval: string;
  leadDays: number;
  ownerUserId: string;
  active: boolean;
}

interface RoundRow {
  id: string;
  companyId: string;
  entitlementId: string;
  roundNo: number;
  dueOn: Date;
  status: string;
  workOrderId: string | null;
  requestId: string | null;
  openedAt: Date | null;
  openError: string | null;
  doneAt: Date | null;
  skippedReason: string | null;
  overdueNotifiedAt: Date | null;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);
const RENEWAL_RULE = 'contract.renewal';
const OPEN_STAGES = ['qualifying', 'proposing', 'negotiating'];
/** Every permission the plan's owner acts with when the system opens a round. */
const OWNER_PERMISSIONS = [
  'request.create',
  'request.read',
  'service.asset.read',
  'service.asset.manage',
];

/**
 * CD-244 แผนบำรุงรักษาตามรอบ — a service contract's PM plan (how often, how
 * far ahead, whose), its rounds from the cover's start to its end (within the
 * preventive quota), and the hourly round:
 *
 * - a planned round within its lead days is opened as a preventive work
 *   order (CD-239) under the plan's owner and confirmed in contract against
 *   the cover; when that cannot be done the owner is told to open it by hand;
 * - a round is done when its case is; past its date and not done, the owner
 *   is told once;
 * - a cover with no contract behind it (a warranty, a contract not in the
 *   register) nearing its end gets a service-contract offer for the
 *   customer's account owner, on the company's `contract.renewal` days, as
 *   CD-70 does for contracts — reminded while the deal is open.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` plans, opens, skips.
 */
@Injectable()
export class PmPlanService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PmPlanService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly plans: ServicePmPlanRepository,
    private readonly rounds: ServicePmRoundRepository,
    private readonly offers: ServiceMaOfferRepository,
    private readonly entitlements: ServiceEntitlementRepository,
    private readonly entitlementAssets: ServiceEntitlementAssetRepository,
    private readonly requestRows: RequestRepository,
    private readonly customers: CustomerRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly people: CompanyMemberRepository,
    private readonly workOrders: WorkOrdersService,
    private readonly deals: OpportunitiesService,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('service.pmSweepIntervalMs') ?? 3_600_000;
    // `0` disables — tests and external-service never sweep.
    if (everyMs <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'PM plan sweep', () => this.sweep()),
      everyMs,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --- the plan --------------------------------------------------------------

  /** An entitlement's plan and its rounds. */
  async planOf(actor: Principal, entitlementId: string) {
    const entitlement = await this.requireEntitlement(
      actor.activeCompanyId,
      entitlementId,
    );
    const plan = (await this.plans.findFirst({
      where: { entitlementId },
    })) as PlanRow | null;
    const rows = (await this.rounds.findMany({
      where: { entitlementId },
      orderBy: { roundNo: 'asc' },
    })) as RoundRow[];
    const [views, names] = await Promise.all([
      this.roundViews(rows, [entitlement]),
      this.names([plan?.ownerUserId ?? null]),
    ]);
    return {
      entitlementId,
      plan: plan
        ? {
            interval: plan.interval,
            leadDays: plan.leadDays,
            ownerUserId: plan.ownerUserId,
            ownerName: names.get(plan.ownerUserId) ?? plan.ownerUserId,
            active: plan.active,
          }
        : null,
      rounds: views,
    };
  }

  /** Set (or change) the plan; its planned rounds are laid out again. */
  async savePlan(actor: Principal, entitlementId: string, dto: SavePmPlanDto) {
    const companyId = actor.activeCompanyId;
    const entitlement = await this.requireEntitlement(companyId, entitlementId);
    if (entitlement.kind !== 'service_contract') {
      throw new AppError(
        'CONFLICT',
        'ตั้งแผนบำรุงรักษาได้เฉพาะสิทธิ์แบบสัญญาบริการ',
      );
    }
    if (entitlement.cancelledAt) {
      throw new AppError('CONFLICT', 'สิทธิ์นี้ถูกยกเลิกแล้ว');
    }
    const leadDays = dto.lead_days ?? 14;
    const problems = planProblems({ interval: dto.interval, leadDays });
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    if (!(await this.requestRows.findReceiver(dto.owner_user_id, companyId))) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ดูแลแผนในบริษัทนี้', [
        { field: 'owner_user_id', reason: dto.owner_user_id },
      ]);
    }
    const active = dto.active ?? true;
    const schedule = pmSchedule({
      startOn: day(entitlement.startOn),
      endOn: day(entitlement.endOn),
      interval: dto.interval as PmInterval,
      quota: entitlement.preventiveQuota,
    });
    await this.transactions.execute(async (prisma) => {
      await prisma.servicePmPlan.upsert({
        where: { entitlementId },
        create: {
          companyId,
          entitlementId,
          interval: dto.interval,
          leadDays,
          ownerUserId: dto.owner_user_id,
          active,
          createdBy: actor.userId,
        },
        update: {
          interval: dto.interval,
          leadDays,
          ownerUserId: dto.owner_user_id,
          active,
          updatedBy: actor.userId,
        },
      });
      // rounds already opened, done or skipped stay as they happened; the
      // ones still ahead follow the plan as it is now
      await prisma.servicePmRound.deleteMany({
        where: { entitlementId, status: 'planned' },
      });
      const kept = (await prisma.servicePmRound.findMany({
        where: { entitlementId },
        select: { roundNo: true },
      })) as { roundNo: number }[];
      const taken = new Set(kept.map((row) => row.roundNo));
      if (active) {
        await prisma.servicePmRound.createMany({
          data: schedule.flatMap((dueOn, index) =>
            taken.has(index + 1)
              ? []
              : [
                  {
                    companyId,
                    entitlementId,
                    roundNo: index + 1,
                    dueOn: asDate(dueOn),
                  },
                ],
          ),
        });
      }
      await this.audit.record(
        {
          eventType: 'service.pm_plan.saved',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_entitlement',
          resourceId: entitlementId,
          after: {
            interval: dto.interval,
            leadDays,
            ownerUserId: dto.owner_user_id,
            active,
            rounds: schedule.length,
          },
        },
        { prisma },
      );
    });
    return this.planOf(actor, entitlementId);
  }

  /** Rounds of every plan: coming due, overdue, open, done or all. */
  async list(actor: Principal, query: ListPmRoundsQueryDto) {
    const companyId = actor.activeCompanyId;
    const today = thaiToday();
    const state = query.state ?? 'upcoming';
    const where: Prisma.ServicePmRoundWhereInput = { companyId };
    if (state === 'upcoming') {
      where.status = { in: ['planned', 'opened', 'failed'] };
      where.dueOn = {
        gte: asDate(today),
        lte: new Date(asDate(today).getTime() + 60 * 86_400_000),
      };
    } else if (state === 'overdue') {
      where.status = { in: ['planned', 'opened', 'failed'] };
      where.dueOn = { lt: asDate(today) };
    } else if (state === 'done') {
      where.status = { in: ['done', 'skipped'] };
    }
    const rows = (await this.rounds.findMany({
      where,
      orderBy: [{ dueOn: 'asc' }, { roundNo: 'asc' }],
      take: 300,
    })) as RoundRow[];
    const entitlements = (await this.entitlements.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.entitlementId))] } },
    })) as EntitlementRow[];
    return this.roundViews(rows, entitlements);
  }

  /** Open a round's work order now, as the person clicking. */
  async openNow(actor: Principal, roundId: string, authorization: string) {
    const round = await this.requireRound(actor.activeCompanyId, roundId);
    if (!['planned', 'failed'].includes(round.status)) {
      throw new AppError('CONFLICT', 'รอบนี้เปิดใบสั่งงานแล้ว หรือปิดไปแล้ว');
    }
    const claimed = await this.rounds.updateMany({
      where: { id: roundId, status: round.status },
      data: { status: 'opening' },
    });
    if (claimed.count !== 1) {
      throw new AppError('CONFLICT', 'รอบนี้กำลังถูกเปิดอยู่');
    }
    try {
      await this.openRound(round, actor, authorization);
    } catch (error) {
      await this.rounds.update({
        where: { id: roundId },
        data: { status: round.status, openError: message(error) },
      });
      throw error;
    }
    return this.roundDetail(actor.activeCompanyId, roundId);
  }

  /** A round not to be done, with why (the customer postponed, site closed…). */
  async skip(actor: Principal, roundId: string, dto: SkipPmRoundDto) {
    const round = await this.requireRound(actor.activeCompanyId, roundId);
    if (['done', 'skipped'].includes(round.status)) {
      throw new AppError('CONFLICT', 'รอบนี้ปิดไปแล้ว');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.servicePmRound.update({
        where: { id: roundId },
        data: {
          status: 'skipped',
          skippedReason: dto.reason.trim(),
          skippedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.pm_round.skipped',
          companyId: round.companyId,
          ...auditActor(actor),
          resourceType: 'service_entitlement',
          resourceId: round.entitlementId,
          before: { roundNo: round.roundNo, status: round.status },
          after: { status: 'skipped', reason: dto.reason.trim() },
        },
        { prisma },
      );
    });
    return this.roundDetail(actor.activeCompanyId, roundId);
  }

  // --- the hourly round --------------------------------------------------------

  async sweep(now = new Date()) {
    const today = thaiToday(now);
    const opened = await this.openDue(today);
    const done = await this.markDone();
    const overdue = await this.notifyOverdue(today);
    const offers = await this.offerContracts(today, now);
    return { opened, done, overdue, ...offers };
  }

  /** Planned rounds inside their lead days → opened under the plan's owner. */
  private async openDue(today: string) {
    const horizon = new Date(
      asDate(today).getTime() + MAX_LEAD_DAYS * 86_400_000,
    );
    const due = (await this.rounds.findMany({
      where: { status: 'planned', dueOn: { lte: horizon } },
      orderBy: { dueOn: 'asc' },
      take: 50,
    })) as RoundRow[];
    const plans = new Map(
      (
        (await this.plans.findMany({
          where: {
            entitlementId: {
              in: [...new Set(due.map((row) => row.entitlementId))],
            },
          },
        })) as PlanRow[]
      ).map((plan) => [plan.entitlementId, plan]),
    );
    let opened = 0;
    for (const round of due) {
      const plan = plans.get(round.entitlementId);
      if (!plan?.active || !opensNow(day(round.dueOn), today, plan.leadDays)) {
        continue;
      }
      const claimed = await this.rounds.updateMany({
        where: { id: round.id, status: 'planned' },
        data: { status: 'opening' },
      });
      if (claimed.count !== 1) continue;
      try {
        const owner = await this.principalOf(plan.ownerUserId, round.companyId);
        await this.openRound(round, owner, '');
        opened += 1;
      } catch (error) {
        const reason = message(error);
        this.logger.warn(`PM round ${round.id} not opened: ${reason}`);
        await this.rounds.update({
          where: { id: round.id },
          data: { status: 'failed', openError: reason },
        });
        await this.tell(plan.ownerUserId, round, 'failed', null, reason);
      }
    }
    return opened;
  }

  /** The work order of the round, opened and confirmed in contract. */
  private async openRound(
    round: RoundRow,
    actor: Principal,
    authorization: string,
  ) {
    const entitlement = await this.requireEntitlement(
      round.companyId,
      round.entitlementId,
    );
    const assets = (await this.entitlementAssets.findMany({
      where: { entitlementId: entitlement.id, removedAt: null },
      select: {
        asset: {
          select: { id: true, name: true, serialNo: true, status: true },
        },
      },
    })) as unknown as {
      asset: {
        id: string;
        name: string;
        serialNo: string | null;
        status: string;
      };
    }[];
    const active = assets
      .map((row) => row.asset)
      .filter((a) => a.status === 'active');
    const order = (await this.workOrders.open(
      actor,
      {
        customer_id: entitlement.customerId,
        ...(active[0] ? { asset_id: active[0].id } : {}),
        work_kind: 'preventive',
        severity: 'low',
        subject:
          `บำรุงรักษาตามรอบ ครั้งที่ ${round.roundNo} — ${entitlement.title}`.slice(
            0,
            255,
          ),
        detail: [
          `ครบกำหนด ${day(round.dueOn)}`,
          active.length > 1
            ? `อุปกรณ์ในสัญญา: ${active.map((a) => [a.name, a.serialNo].filter(Boolean).join(' ')).join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000),
      },
      authorization,
    )) as {
      id: string;
      requestId: string;
      request: { requestNo: string | null } | null;
    };
    // a planned round is the contract's own visit
    await this.workOrders
      .confirm(actor, order.id, {
        billing: 'in_contract',
        entitlement_id: entitlement.id,
        reason: 'รอบบำรุงรักษาตามแผนของสัญญา',
      })
      .catch((error: Error) =>
        this.logger.warn(
          `PM round ${round.id} not confirmed: ${error.message}`,
        ),
      );
    await this.rounds.update({
      where: { id: round.id },
      data: {
        status: 'opened',
        workOrderId: order.id,
        requestId: order.requestId,
        openedAt: new Date(),
        openError: null,
      },
    });
    const plan = (await this.plans.findFirst({
      where: { entitlementId: round.entitlementId },
    })) as PlanRow | null;
    if (plan) {
      await this.tell(
        plan.ownerUserId,
        round,
        'opened',
        order.request?.requestNo ?? null,
      );
    }
  }

  /** Rounds whose case is done. */
  private async markDone() {
    const open = (await this.rounds.findMany({
      where: { status: 'opened', requestId: { not: null } },
      select: { id: true, requestId: true },
      take: 500,
    })) as { id: string; requestId: string }[];
    if (!open.length) return 0;
    const finished = new Set(
      (
        (await this.requestRows.findMany({
          where: {
            id: { in: open.map((row) => row.requestId) },
            status: { in: DONE_STATUSES as never },
          },
          select: { id: true },
        })) as { id: string }[]
      ).map((row) => row.id),
    );
    let done = 0;
    for (const row of open) {
      if (!finished.has(row.requestId)) continue;
      const moved = await this.rounds.updateMany({
        where: { id: row.id, status: 'opened' },
        data: { status: 'done', doneAt: new Date() },
      });
      done += moved.count;
    }
    return done;
  }

  /** Past the due date, not done: the plan's owner is told once. */
  private async notifyOverdue(today: string) {
    const late = (await this.rounds.findMany({
      where: {
        status: { in: ['planned', 'opened', 'failed'] },
        dueOn: { lt: asDate(today) },
        overdueNotifiedAt: null,
      },
      take: 100,
    })) as RoundRow[];
    let told = 0;
    for (const round of late) {
      if (
        !isOverdue({ status: round.status, dueOn: day(round.dueOn) }, today)
      ) {
        continue;
      }
      const claimed = await this.rounds.updateMany({
        where: { id: round.id, overdueNotifiedAt: null },
        data: { overdueNotifiedAt: new Date() },
      });
      if (claimed.count !== 1) continue;
      const plan = (await this.plans.findFirst({
        where: { entitlementId: round.entitlementId },
      })) as PlanRow | null;
      if (!plan) continue;
      const requestNo = round.requestId
        ? ((
            (await this.requestRows.findFirst({
              where: { id: round.requestId },
              select: { requestNo: true },
            })) as { requestNo: string | null } | null
          )?.requestNo ?? null)
        : null;
      await this.tell(plan.ownerUserId, round, 'overdue', requestNo);
      told += 1;
    }
    return told;
  }

  /**
   * Covers with no contract behind them, near their end: a service-contract
   * offer for the customer's account owner, then its reminders.
   */
  private async offerContracts(today: string, now: Date) {
    const rule = await this.rules.across(RENEWAL_RULE);
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (one) => one.enabled,
    );
    const widest = (key: 'open_days' | 'remind_days') =>
      Math.max(-1, ...enabled.flatMap((one) => one.params[key]));
    if (widest('open_days') < 0) return { offered: 0, reminded: 0 };
    const openDaysOf = (companyId: string) => {
      const one = rule.of(companyId);
      return one.enabled ? (one.params.open_days as number) : -1;
    };
    const remindDaysOf = (companyId: string) => {
      const one = rule.of(companyId);
      return one.enabled ? (one.params.remind_days as number[]) : [];
    };

    let offered = 0;
    const candidates = (await this.entitlements.findMany({
      where: {
        cancelledAt: null,
        contractId: null,
        endOn: {
          gte: asDate(today),
          lte: new Date(
            asDate(today).getTime() + widest('open_days') * 86_400_000,
          ),
        },
      },
      take: 100,
    })) as EntitlementRow[];
    const already = new Set(
      (
        (await this.offers.findMany({
          where: { entitlementId: { in: candidates.map((row) => row.id) } },
          select: { entitlementId: true },
        })) as { entitlementId: string }[]
      ).map((row) => row.entitlementId),
    );
    for (const entitlement of candidates) {
      const endOn = day(entitlement.endOn);
      if (
        already.has(entitlement.id) ||
        !offerDue(endOn, today, openDaysOf(entitlement.companyId))
      ) {
        continue;
      }
      const customer = (await this.customers.findFirst({
        where: { id: entitlement.customerId },
        select: {
          nameTh: true,
          accountOwnerUserId: true,
          ownerOrgUnitId: true,
        },
      })) as {
        nameTh: string;
        accountOwnerUserId: string | null;
        ownerOrgUnitId: string | null;
      } | null;
      if (!customer?.accountOwnerUserId) continue;
      // claimed by the unique entitlement row: a second sweep finds it taken
      const claim = await this.offers
        .create({
          data: {
            companyId: entitlement.companyId,
            entitlementId: entitlement.id,
          },
        })
        .catch(() => null);
      if (!claim) continue;
      const claimId = (claim as { id: string }).id;
      try {
        const deal = await this.deals.createRenewal({
          companyId: entitlement.companyId,
          customerId: entitlement.customerId,
          title: `เสนอสัญญาบริการ: ${entitlement.title}`.slice(0, 255),
          amount: null,
          expectedCloseAt: entitlement.endOn,
          ownerUserId: customer.accountOwnerUserId,
          ownerOrgUnitId: customer.ownerOrgUnitId,
          contractNo: entitlement.title,
          origin: {
            dealType: entitlement.kind === 'warranty' ? 'upsell' : 'renewal',
            summary: `เสนอสัญญาบริการก่อน ${entitlement.title} หมด ${endOn}`,
          },
        });
        const left = Math.round(
          (entitlement.endOn.getTime() - asDate(today).getTime()) / 86_400_000,
        );
        await this.offers.update({
          where: { id: claimId },
          data: {
            opportunityId: deal.id,
            openedAt: now,
            remindedDays: remindDaysOf(entitlement.companyId).filter(
              (days) => left <= days,
            ),
          },
        });
        await this.notifications
          .maOffer(customer.accountOwnerUserId, entitlement.companyId, {
            kind: 'opened',
            title: entitlement.title,
            customer: customer.nameTh,
            endOn,
            daysLeft: left,
            opportunityId: deal.id,
            opportunityCode: deal.opportunityCode,
          })
          .catch(() => undefined);
        offered += 1;
      } catch (error) {
        // release the claim so the next round tries again
        await this.offers
          .delete({ where: { id: claimId } })
          .catch(() => undefined);
        this.logger.error(
          `MA offer for entitlement ${entitlement.id} failed: ${message(error)}`,
        );
      }
    }

    let reminded = 0;
    const open = (await this.offers.findMany({
      where: { opportunityId: { not: null } },
      take: 500,
    })) as {
      id: string;
      entitlementId: string;
      opportunityId: string;
      remindedDays: number[];
    }[];
    for (const offer of open) {
      const entitlement = (await this.entitlements.findFirst({
        where: {
          id: offer.entitlementId,
          cancelledAt: null,
          endOn: { gte: asDate(today) },
        },
      })) as EntitlementRow | null;
      if (!entitlement) continue;
      const endOn = day(entitlement.endOn);
      const reached = remindersReached(
        endOn,
        today,
        remindDaysOf(entitlement.companyId),
        offer.remindedDays,
      );
      if (!reached.length) continue;
      const claimed = await this.offers.updateMany({
        where: { id: offer.id, remindedDays: { equals: offer.remindedDays } },
        data: { remindedDays: [...offer.remindedDays, ...reached] },
      });
      if (claimed.count !== 1) continue;
      const deal = (await this.opportunities.findFirst({
        where: { id: offer.opportunityId, stage: { in: OPEN_STAGES as never } },
        select: { id: true, opportunityCode: true, ownerUserId: true },
      })) as {
        id: string;
        opportunityCode: string;
        ownerUserId: string;
      } | null;
      if (!deal) continue;
      const customer = (await this.customers.findFirst({
        where: { id: entitlement.customerId },
        select: { nameTh: true },
      })) as { nameTh: string } | null;
      await this.notifications
        .maOffer(deal.ownerUserId, entitlement.companyId, {
          kind: 'due',
          title: entitlement.title,
          customer: customer?.nameTh ?? '',
          endOn,
          daysLeft: Math.round(
            (entitlement.endOn.getTime() - asDate(today).getTime()) /
              86_400_000,
          ),
          opportunityId: deal.id,
          opportunityCode: deal.opportunityCode,
        })
        .catch(() => undefined);
      reminded += 1;
    }
    return { offered, reminded };
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * The plan's owner as the system acts for them: who they are and where they
   * sit, with the service permissions a PM round needs — the same rows the
   * screens' principal is built from, without a token.
   */
  private async principalOf(
    userId: string,
    companyId: string,
  ): Promise<Principal> {
    const user = (await this.people.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: {
        id: true,
        keycloakId: true,
        username: true,
        displayName: true,
        email: true,
        orgUnitId: true,
        supervisorUserId: true,
        companies: {
          select: {
            isPrimary: true,
            company: { select: { id: true, name: true, docPrefix: true } },
          },
        },
      },
    })) as {
      id: string;
      keycloakId: string;
      username: string;
      displayName: string;
      email: string | null;
      orgUnitId: string | null;
      supervisorUserId: string | null;
      companies: {
        isPrimary: boolean;
        company: { id: string; name: string; docPrefix: string };
      }[];
    } | null;
    if (!user) {
      throw new Error('ผู้ดูแลแผนไม่ได้อยู่ในบริษัทนี้แล้ว หรือบัญชีถูกปิด');
    }
    return {
      userId: user.id,
      keycloakId: user.keycloakId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      companies: user.companies.map((row) => ({
        ...row.company,
        isPrimary: row.isPrimary,
      })),
      activeCompanyId: companyId,
      orgUnitId: user.orgUnitId,
      supervisorUserId: user.supervisorUserId,
      ledUnitIds: [],
      levelUnitIds: [],
      scopedUnitIds: [],
      scopedActUnitIds: [],
      scopedUserIds: [],
      scopedActUserIds: [],
      scopedByPermission: {},
      roles: [],
      permissions: OWNER_PERMISSIONS,
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      isServiceAccount: false,
      pendingOrgAssignment: false,
    } as unknown as Principal;
  }

  private async tell(
    userId: string,
    round: RoundRow,
    kind: 'opened' | 'failed' | 'overdue',
    requestNo: string | null,
    error?: string,
  ) {
    const entitlement = (await this.entitlements.findFirst({
      where: { id: round.entitlementId },
      select: { title: true, customerId: true },
    })) as { title: string; customerId: string } | null;
    const customer = entitlement
      ? ((await this.customers.findFirst({
          where: { id: entitlement.customerId },
          select: { nameTh: true },
        })) as { nameTh: string } | null)
      : null;
    await this.notifications
      .pmRound(userId, round.companyId, {
        kind,
        entitlementId: round.entitlementId,
        title: entitlement?.title ?? '',
        customer: customer?.nameTh ?? '',
        dueOn: day(round.dueOn),
        roundNo: round.roundNo,
        requestId: round.requestId,
        requestNo,
        error,
      })
      .catch((err: Error) =>
        this.logger.warn(`PM notice not sent: ${err.message}`),
      );
  }

  private async roundViews(rows: RoundRow[], entitlements: EntitlementRow[]) {
    const today = thaiToday();
    const byId = new Map(entitlements.map((row) => [row.id, row]));
    const [cases, customers] = await Promise.all([
      this.requestRows.findMany({
        where: {
          id: {
            in: rows.flatMap((row) => (row.requestId ? [row.requestId] : [])),
          },
        },
        select: { id: true, requestNo: true, status: true },
      }) as Promise<{ id: string; requestNo: string | null; status: string }[]>,
      this.customers.findMany({
        where: {
          id: { in: [...new Set(entitlements.map((row) => row.customerId))] },
        },
        select: { id: true, customerCode: true, nameTh: true },
      }) as Promise<{ id: string; customerCode: string; nameTh: string }[]>,
    ]);
    const caseById = new Map(cases.map((row) => [row.id, row]));
    const customerById = new Map(customers.map((row) => [row.id, row]));
    return rows.map((row) => {
      const entitlement = byId.get(row.entitlementId);
      const customer = entitlement
        ? customerById.get(entitlement.customerId)
        : undefined;
      const request = row.requestId ? caseById.get(row.requestId) : undefined;
      return {
        id: row.id,
        entitlementId: row.entitlementId,
        entitlementTitle: entitlement?.title ?? '',
        customer: customer
          ? {
              id: customer.id,
              code: customer.customerCode,
              name: customer.nameTh,
            }
          : null,
        roundNo: row.roundNo,
        dueOn: day(row.dueOn),
        status: row.status,
        overdue: isOverdue(
          { status: row.status, dueOn: day(row.dueOn) },
          today,
        ),
        workOrderId: row.workOrderId,
        requestId: row.requestId,
        request: request
          ? { requestNo: request.requestNo, status: request.status }
          : null,
        openedAt: row.openedAt?.toISOString() ?? null,
        openError: row.openError,
        doneAt: row.doneAt?.toISOString() ?? null,
        skippedReason: row.skippedReason,
      };
    });
  }

  private async roundDetail(companyId: string, id: string) {
    const round = await this.requireRound(companyId, id);
    const entitlement = await this.requireEntitlement(
      companyId,
      round.entitlementId,
    );
    const [view] = await this.roundViews([round], [entitlement]);
    return view;
  }

  private async requireEntitlement(companyId: string, id: string) {
    const row = (await this.entitlements.findFirst({
      where: { id, companyId },
    })) as EntitlementRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบสิทธิ์บริการ');
    return row;
  }

  private async requireRound(companyId: string, id: string) {
    const row = (await this.rounds.findFirst({
      where: { id, companyId },
    })) as RoundRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรอบบำรุงรักษา');
    return row;
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
