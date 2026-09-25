import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { NotificationsService } from '../notifications/notifications.service';
import { backgroundTick } from '../common/background-tick';

/** How often the clock is swept. Short enough to be useful, cheap to run. */
const DEFAULT_INTERVAL_MS = 60_000;

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
  async sweep(at = new Date()): Promise<{ breached: number; warned: number }> {
    return {
      breached: await this.escalateBreached(at),
      warned: await this.warnNearDue(at),
    };
  }

  /** Past the deadline and not yet escalated. */
  private async escalateBreached(at: Date): Promise<number> {
    const clocks = await this.prisma.slaClock.findMany({
      where: { state: 'running', dueAt: { lt: at }, escalatedAt: null },
      include: {
        request: {
          include: {
            approvalCases: {
              orderBy: { createdAt: 'desc' },
              take: 1,
              include: { steps: { orderBy: { stepNo: 'asc' } } },
            },
          },
        },
      },
      take: 200,
    });

    for (const clock of clocks) {
      const request = clock.request;

      /**
       * The owner, plus one rung up.
       *
       * "One level up" is read from the approval chain rather than the org
       * closure: the chain is already the escalation ladder for this request,
       * and reading the org tree would need an identity call this background
       * job has no user token for (open question C). Where the two differ the
       * chain is the more relevant one — it names who is actually blocking.
       */
      const chain = request.approvalCases[0]?.steps ?? [];
      const pendingIndex = chain.findIndex((step) => step.status === 'pending');
      const above =
        pendingIndex >= 0 ? chain[pendingIndex + 1]?.approverUserId : null;

      const recipients = [...new Set([request.requesterId, above ?? ''])]
        .filter(Boolean)
        .filter((id): id is string => typeof id === 'string');

      await this.prisma.slaClock.update({
        where: { requestId: clock.requestId },
        data: {
          state: 'breached',
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

      await this.recordEscalation(request.id, recipients, at);

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

    if (clocks.length) {
      this.logger.warn(`SUP-02: escalated ${clocks.length} overdue request(s)`);
    }

    return clocks.length;
  }

  /** Approaching the deadline — a nudge before it is a breach. */
  private async warnNearDue(at: Date): Promise<number> {
    const horizon = new Date(at.getTime() + 4 * 3_600_000);

    const clocks = await this.prisma.slaClock.findMany({
      where: {
        state: 'running',
        dueAt: { gte: at, lt: horizon },
        warnedAt: null,
      },
      include: { request: true },
      take: 200,
    });

    for (const clock of clocks) {
      await this.prisma.slaClock.update({
        where: { requestId: clock.requestId },
        data: { warnedAt: at },
      });

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

    return clocks.length;
  }

  /** The timeline must show that the system acted, not just the people. */
  private async recordEscalation(
    requestId: string,
    recipients: string[],
    at: Date,
  ): Promise<void> {
    const last = await this.prisma.requestEvent.findFirst({
      where: { requestId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });

    await this.prisma.requestEvent.create({
      data: {
        requestId,
        seq: (last?.seq ?? 0) + 1,
        type: 'sla.escalated',
        // No `actorId`: this was the system, and attributing it to a person
        // would put a name on the timeline who did nothing.
        actorLabel: 'system',
        data: { recipients, at: at.toISOString() },
      },
    });
  }
}
