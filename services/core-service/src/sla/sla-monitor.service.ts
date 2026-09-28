import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@request-management/share';
import type { Prisma } from '@prisma/client';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { backgroundTick } from '../common/background-tick';
import { nextRequestEventSeq } from '../requests/request-event-seq';
import { SlaService } from './sla.service';
import { AccessService } from '../access/access.service';

/** How often the clock is swept. Short enough to be useful, cheap to run. */
const DEFAULT_INTERVAL_MS = 60_000;
/** Clocks handled per query; the sweep keeps paging until none are left. */
const SWEEP_BATCH = 200;

const DEFAULT_TIERS = [100, 150];

type BreachedClock = Prisma.SlaClockGetPayload<{
  include: {
    request: {
      include: {
        requestType: true;
        approvalCases: { include: { steps: true } };
      };
    };
  };
}>;

type OverdueStep = Prisma.ApprovalStepGetPayload<{
  include: {
    case: {
      select: {
        id: true;
        companyId: true;
        subjectType: true;
        requestId: true;
        request: { select: { requestNo: true } };
      };
    };
  };
}>;

/**
 * SUP-02 — nobody has to notice that a request went past its deadline.
 *
 * A plain interval rather than `@nestjs/schedule`: this needs one timer, and
 * adding a scheduling dependency for it would be a larger change than the
 * feature. `OnModuleDestroy` clears it so tests and shutdowns do not leak.
 *
 * `escalatedAt` is the guard against repeat alerts. Without it every sweep
 * would notify the same people again, and an escalation that arrives every
 * minute is one that gets muted — which is worse than none, because then the
 * genuinely late request is invisible too.
 */
@Injectable()
export class SlaMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlaMonitorService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly config: ConfigService,
    private readonly sla: SlaService,
    private readonly access: AccessService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('slaSweepIntervalMs') ?? DEFAULT_INTERVAL_MS;

    // `0` disables the sweep — tests and one-off scripts boot the module
    // without wanting a background timer firing under them.
    if (interval <= 0) return;

    this.timer = setInterval(
      backgroundTick(this.logger, 'SUP-02 SLA sweep', () => this.sweep()),
      interval,
    );
    // Does not hold the process open on its own.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * One pass over the clocks. Public so a test — or an operator — can run it
   * on demand instead of waiting for the interval.
   */
  async sweep(
    at = new Date(),
  ): Promise<{ breached: number; warned: number; approvals: number }> {
    return {
      breached: await this.escalateBreached(at),
      warned: await this.warnNearDue(at),
      approvals: await this.escalateOverdueSteps(at),
    };
  }

  /**
   * Overdue clocks, tier by tier (`SlaConfig.escalatePercents`, default 100/150).
   * The clock keeps running — met or breached is decided when it stops.
   */
  private async escalateBreached(at: Date): Promise<number> {
    let total = 0;
    let after: string | undefined;

    for (;;) {
      const clocks = await this.prisma.slaClock.findMany({
        where: {
          state: 'running',
          dueAt: { lt: at },
          ...(after ? { id: { gt: after } } : {}),
        },
        include: {
          request: {
            include: {
              requestType: true,
              approvalCases: {
                where: { status: 'pending' },
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: { steps: { orderBy: { stepNo: 'asc' } } },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
      });

      for (const clock of clocks) {
        const reached = await this.tiersReached(clock, at);
        if (reached > clock.escalationLevel) {
          await this.escalateOne(clock, reached, at);
          total += 1;
        }
      }

      if (clocks.length < SWEEP_BATCH) break;
      after = clocks[clocks.length - 1].id;
    }

    if (total)
      this.logger.warn(`SUP-02: escalated ${total} overdue request(s)`);
    return total;
  }

  /** How many configured tiers the clock has crossed; past due is always at least one. */
  private async tiersReached(clock: BreachedClock, at: Date): Promise<number> {
    const config = await this.prisma.slaConfig.findFirst({
      where: {
        companyId: clock.request.companyId,
        requestTypeCode: clock.request.typeCode,
      },
      select: { escalatePercents: true },
    });
    const tiers = [...(config?.escalatePercents ?? DEFAULT_TIERS)].sort(
      (a, b) => a - b,
    );
    const used = await this.sla.percentUsed(this.prisma, clock, at);
    if (used === null) return 1;
    return Math.max(tiers.filter((tier) => used >= tier).length, 1);
  }

  /** Holder, the approver it waits on, the requester, and one head per tier crossed. */
  private async escalateOne(
    clock: BreachedClock,
    reached: number,
    at: Date,
  ): Promise<void> {
    const request = clock.request;
    const holder = request.assigneeUserId ?? request.receiverUserId;
    const pending = request.approvalCases[0];
    const blocking =
      pending?.steps.find((step) => step.stepNo === pending.currentStep) ??
      null;

    // Tier k reaches the head k levels above the holder: 100% their team head, 150% the next.
    const heads: string[] = [];
    for (let tier = clock.escalationLevel + 1; tier <= reached; tier += 1) {
      if (holder) heads.push(...(await this.headAbove(holder, tier)));
    }

    const recipients = [
      ...new Set(
        [
          holder,
          ...(blocking?.candidateUserIds.length
            ? blocking.candidateUserIds
            : [blocking?.approverUserId]),
          request.requesterId,
          ...heads,
        ].filter((id): id is string => Boolean(id)),
      ),
    ];

    await this.prisma.slaClock.update({
      where: { requestId: clock.requestId },
      data: {
        escalationLevel: reached,
        breachedAt: clock.breachedAt ?? at,
        escalatedAt: at,
      },
    });

    for (const userId of recipients) {
      await this.notifications.slaBreached(
        userId,
        request.companyId,
        request.id,
        request.requestNo,
      );
    }

    await this.recordEscalation(request.id, recipients, at, reached);

    if (clock.escalationLevel === 0) {
      await this.domainEvents.emit({
        name: DOMAIN_EVENTS.slaBreached,
        payload: {
          company_id: request.companyId,
          request_id: request.id,
          request_no: request.requestNo,
          due_at: clock.dueAt.toISOString(),
        },
      });
    }
  }

  /**
   * Approval steps past their own deadline: tier 1 reminds the candidates,
   * tier 2 (half a budget later) also tells each candidate's head.
   */
  private async escalateOverdueSteps(at: Date): Promise<number> {
    let total = 0;
    let after: string | undefined;

    for (;;) {
      const steps = await this.prisma.approvalStep.findMany({
        where: {
          status: 'pending',
          dueAt: { lt: at },
          escalationLevel: { lt: 2 },
          case: { status: 'pending' },
          ...(after ? { id: { gt: after } } : {}),
        },
        include: {
          case: {
            select: {
              id: true,
              companyId: true,
              subjectType: true,
              requestId: true,
              request: { select: { requestNo: true } },
            },
          },
        },
        orderBy: { id: 'asc' },
        take: SWEEP_BATCH,
      });

      for (const step of steps) {
        const reached = await this.stepTierReached(step, at);
        if (reached > step.escalationLevel) {
          await this.escalateStep(step, reached);
          total += 1;
        }
      }

      if (steps.length < SWEEP_BATCH) break;
      after = steps[steps.length - 1].id;
    }

    return total;
  }

  private async stepTierReached(step: OverdueStep, at: Date): Promise<number> {
    if (!step.dueAt || !step.slaHours) return 1;
    const typeCode =
      /^request:([^:]+)/.exec(step.case.subjectType)?.[1] ?? null;
    const secondTier = await this.sla.dueAfter(
      this.prisma,
      step.case.companyId,
      typeCode,
      step.slaHours / 2,
      step.dueAt,
    );
    return secondTier && at >= secondTier ? 2 : 1;
  }

  private async escalateStep(
    step: OverdueStep,
    reached: number,
  ): Promise<void> {
    const candidates = step.candidateUserIds.length
      ? step.candidateUserIds
      : step.approverUserId
        ? [step.approverUserId]
        : [];
    const heads: string[] = [];
    if (reached >= 2) {
      for (const candidate of candidates)
        heads.push(...(await this.headAbove(candidate, 1)));
    }

    await this.prisma.approvalStep.update({
      where: { id: step.id },
      data: { escalationLevel: reached },
    });

    const link = {
      requestId: step.case.requestId,
      caseId: step.case.id,
      label: step.case.request?.requestNo ?? step.case.subjectType,
    };
    for (const userId of new Set(candidates)) {
      await this.notifications.approvalOverdue(
        userId,
        step.case.companyId,
        link,
        false,
      );
    }
    for (const userId of new Set(
      heads.filter((id) => !candidates.includes(id)),
    )) {
      await this.notifications.approvalOverdue(
        userId,
        step.case.companyId,
        link,
        true,
      );
    }
  }

  /** The head `up` levels above where this person sits; empty when the chart runs out. */
  private async headAbove(userId: string, up: number): Promise<string[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { orgUnitId: true },
    });
    if (!user?.orgUnitId) return [];
    return this.access.approverCandidatesOf(
      { type: 'supervisor', up },
      { requesterId: userId, orgUnitId: user.orgUnitId },
    );
  }

  /** Approaching the deadline — a nudge to whoever holds the work, before it is a breach. */
  private async warnNearDue(at: Date): Promise<number> {
    const horizon = new Date(at.getTime() + 4 * 3_600_000);
    let total = 0;

    for (;;) {
      const clocks = await this.prisma.slaClock.findMany({
        where: {
          state: 'running',
          dueAt: { gte: at, lt: horizon },
          warnedAt: null,
        },
        include: { request: true },
        take: SWEEP_BATCH,
      });

      for (const clock of clocks) {
        await this.prisma.slaClock.update({
          where: { requestId: clock.requestId },
          data: { warnedAt: at },
        });

        const holder =
          clock.request.assigneeUserId ?? clock.request.receiverUserId;
        if (holder) {
          await this.notifications.slaWarning(
            holder,
            clock.request.companyId,
            clock.request.id,
            clock.request.requestNo,
          );
        }

        await this.domainEvents.emit({
          name: DOMAIN_EVENTS.slaWarning,
          payload: {
            company_id: clock.request.companyId,
            request_id: clock.request.id,
            request_no: clock.request.requestNo,
            due_at: clock.dueAt.toISOString(),
          },
        });
      }

      total += clocks.length;
      if (clocks.length < SWEEP_BATCH) break;
    }

    return total;
  }

  /** The timeline must show that the system acted, not just the people. */
  private async recordEscalation(
    requestId: string,
    recipients: string[],
    at: Date,
    level: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (prisma) => {
      await prisma.requestEvent.create({
        data: {
          requestId,
          seq: await nextRequestEventSeq(prisma, requestId),
          type: 'sla.escalated',
          // No `actorId`: this was the system, and attributing it to a person
          // would put a name on the timeline who did nothing.
          actorLabel: 'system',
          data: { recipients, level, at: at.toISOString() },
        },
      });
    });
  }
}
