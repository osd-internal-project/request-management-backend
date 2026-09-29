import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@request-management/share';
import { backgroundTick } from '../../common/background-tick';
import {
  TEAMS_CLIENT,
  TeamsPermanentError,
  type TeamsClient,
} from './teams-client';

const DEFAULT_INTERVAL_MS = 15_000;
const BATCH = 50;
/** Tries before a send is given up as failed. */
export const TEAMS_MAX_ATTEMPTS = 5;
/** Wait before try n+1 (after n failures): 1, 5, 15, 60 minutes. */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
/** A claimed row is left alone this long — the send's own lease. */
const LEASE_MS = 120_000;

interface QueuedRow {
  id: string;
  attempts: number;
  notification: { userId: string; title: string; body: string };
}

/**
 * CD-51 — sends the queued Teams messages. `NotificationsService` only
 * writes a `teams` row into the delivery log (status `queued`), so the action
 * that raised a notification never waits on Microsoft; this worker sends
 * them, retries what failed for a passing reason with backoff, and records
 * the outcome on the same row — the delivery log screen shows it as for
 * email. Runs in core-service only (`teams.deliveryIntervalMs` is 0 in
 * external-service).
 */
@Injectable()
export class TeamsDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TeamsDeliveryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional()
    @Inject(TEAMS_CLIENT)
    private readonly client: TeamsClient | null = null,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('teams.deliveryIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (!this.client || interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-51 Teams delivery', () =>
        this.deliverDue(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private get link(): string | null {
    const base = this.config.get<string>('teams.publicWebUrl');
    return base ? `${base.replace(/\/$/, '')}/pages/notifications` : null;
  }

  async deliverDue(
    now: Date = new Date(),
  ): Promise<{ sent: number; failed: number; retrying: number }> {
    const tally = { sent: 0, failed: 0, retrying: 0 };
    if (!this.client) return tally;
    const rows = (await this.prisma.notificationDeliveryLog.findMany({
      where: {
        channel: 'teams',
        status: 'queued',
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
      select: {
        id: true,
        attempts: true,
        notification: { select: { userId: true, title: true, body: true } },
      },
    })) as QueuedRow[];

    for (const row of rows) {
      // Claimed on the attempt count read: an overlapping tick sends nothing twice.
      const attempt = row.attempts + 1;
      const claimed = await this.prisma.notificationDeliveryLog.updateMany({
        where: { id: row.id, status: 'queued', attempts: row.attempts },
        data: {
          attempts: attempt,
          nextAttemptAt: new Date(now.getTime() + LEASE_MS),
        },
      });
      if (claimed.count !== 1) continue;

      const user = await this.prisma.user.findUnique({
        where: { id: row.notification.userId },
        select: { email: true },
      });
      if (!user?.email) {
        await this.finish(
          row.id,
          'failed',
          'ผู้ใช้ไม่มีอีเมล — หาใน Teams ไม่ได้',
        );
        tally.failed += 1;
        continue;
      }

      try {
        await this.client.send(
          { userId: row.notification.userId, email: user.email },
          {
            title: row.notification.title,
            body: row.notification.body,
            link: this.link,
          },
        );
        await this.prisma.notificationDeliveryLog.update({
          where: { id: row.id },
          data: {
            status: 'sent',
            target: user.email,
            sentAt: new Date(),
            error: null,
            nextAttemptAt: null,
          },
        });
        tally.sent += 1;
      } catch (error) {
        const reason = (error as Error)?.message ?? String(error);
        if (
          error instanceof TeamsPermanentError ||
          attempt >= TEAMS_MAX_ATTEMPTS
        ) {
          await this.finish(row.id, 'failed', reason, user.email);
          tally.failed += 1;
          continue;
        }
        await this.prisma.notificationDeliveryLog.update({
          where: { id: row.id },
          data: {
            error: reason.slice(0, 500),
            nextAttemptAt: new Date(
              now.getTime() +
                BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)],
            ),
          },
        });
        tally.retrying += 1;
      }
    }
    if (tally.sent || tally.failed || tally.retrying) {
      this.logger.log(
        `CD-51 Teams: sent ${tally.sent} · failed ${tally.failed} · retrying ${tally.retrying}`,
      );
    }
    return tally;
  }

  private finish(
    id: string,
    status: 'failed',
    reason: string,
    target?: string,
  ) {
    return this.prisma.notificationDeliveryLog.update({
      where: { id },
      data: {
        status,
        error: reason.slice(0, 500),
        nextAttemptAt: null,
        ...(target ? { target } : {}),
      },
    });
  }
}
