import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { DEFAULT_CALENDAR, type WorkingCalendar } from '../sla/business-hours';
import {
  DEFAULT_DIGEST_HOUR,
  categoryOf,
  digestDue,
  settingOf,
} from './notification-categories';
import { NotificationsService } from './notifications.service';

const DEFAULT_INTERVAL_MS = 300_000;
/** Lines listed in the digest body; the rest are counted. */
const LISTED = 15;

const CATEGORY_LABELS: Record<string, string> = {
  approval: 'รออนุมัติจากคุณ',
  my_requests: 'ผลการอนุมัติคำขอของคุณ',
  crm: 'เตือนงานขาย',
};

/**
 * CD-52 — sends each person's daily digest: once per working day, at or after
 * the hour they chose, carrying whatever `NotificationsService.emit` held for
 * them. Nothing held, nothing sent — an empty summary is noise.
 *
 * Lives in core-service only (registered by the HTTP module): the digest is a
 * schedule, and one process should run it. The claim on `lastDigestDate` is
 * what keeps a second instance, or an overlapping tick, from sending twice.
 *
 * The held rows are not changed into something else: they stay, marked with
 * the digest that carried them, and their in-app delivery moves from queued
 * to sent — so the CD-55 log shows exactly when each one reached the person.
 */
@Injectable()
export class NotificationDigestService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationDigestService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('notificationDigestIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-52 notification digest', () =>
        this.sweep(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Returns how many digests went out. */
  async sweep(now: Date = new Date()): Promise<number> {
    const waiting = await this.prisma.notification.groupBy({
      by: ['userId', 'companyId'],
      where: { heldForDigest: true, digestId: null },
    });

    let sent = 0;
    for (const { userId, companyId } of waiting) {
      try {
        if (await this.sendOne(userId, companyId, now)) sent += 1;
      } catch (error) {
        this.logger.error(
          `digest for ${userId}@${companyId} failed`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    if (sent) this.logger.log(`CD-52: ${sent} daily digest(s) sent`);
    return sent;
  }

  private async sendOne(
    userId: string,
    companyId: string,
    now: Date,
  ): Promise<boolean> {
    const preference = await this.prisma.notificationPreference.findUnique({
      where: { userId_companyId: { userId, companyId } },
    });
    const { due, date } = digestDue(
      now,
      preference?.digestHour ?? DEFAULT_DIGEST_HOUR,
      preference?.lastDigestDate ?? null,
      await this.calendarOf(companyId),
    );
    if (!due) return false;

    // The once-a-day claim. A row is created if it vanished, so held items
    // can never be stranded without one.
    if (preference) {
      const claimed = await this.prisma.notificationPreference.updateMany({
        where: {
          id: preference.id,
          OR: [{ lastDigestDate: null }, { lastDigestDate: { not: date } }],
        },
        data: { lastDigestDate: date },
      });
      if (claimed.count === 0) return false;
    } else {
      await this.prisma.notificationPreference.create({
        data: { userId, companyId, lastDigestDate: date },
      });
    }

    const held = await this.prisma.notification.findMany({
      where: { userId, companyId, heldForDigest: true, digestId: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, eventType: true, title: true, body: true },
    });
    if (!held.length) return false;

    // CD-54 — the company may word the digest too.
    const parts = digestParts(held);
    const wording = await this.notifications.render(
      companyId,
      'notification.digest',
      { count: String(held.length), ...parts },
    );
    const digest = await this.prisma.notification.create({
      data: {
        userId,
        companyId,
        eventType: 'notification.digest',
        ...wording,
        resourceType: 'notification_digest',
      },
    });
    await this.prisma.notificationDeliveryLog.create({
      data: {
        notificationId: digest.id,
        channel: 'in_app',
        target: userId,
        status: 'sent',
        sentAt: now,
      },
    });

    const ids = held.map((row) => row.id);
    await this.prisma.notification.updateMany({
      where: { id: { in: ids } },
      data: { digestId: digest.id },
    });
    await this.prisma.notificationDeliveryLog.updateMany({
      where: {
        notificationId: { in: ids },
        channel: 'in_app',
        status: 'queued',
      },
      data: { status: 'sent', sentAt: now },
    });

    // One email for the day, if any held item's category wants email.
    const wantsEmail =
      preference?.emailEnabled !== false &&
      held.some(
        (row) =>
          settingOf(preference?.categorySettings, categoryOf(row.eventType))
            .email,
      );
    if (wantsEmail) {
      await this.notifications.deliverEmail(digest.id, {
        userId,
        companyId,
        title: digest.title,
        body: digest.body,
      });
    }
    // CD-51 — and one Teams message, if the person has Teams on.
    if (preference?.teamsEnabled !== false) {
      await this.notifications.queueTeams(digest.id, userId);
    }
    return true;
  }

  private async calendarOf(companyId: string): Promise<WorkingCalendar> {
    const stored = await this.prisma.holidayCalendar.findUnique({
      where: { companyId },
    });
    if (!stored) return DEFAULT_CALENDAR;
    return {
      ...DEFAULT_CALENDAR,
      workingWeekdays: stored.workingWeekdays,
      holidays: Array.isArray(stored.holidays)
        ? (stored.holidays as unknown[]).filter(
            (day): day is string => typeof day === 'string',
          )
        : [],
    };
  }
}

/** Counts per category, and the first items one per line. */
export function digestParts(
  held: { eventType: string; title: string; body: string }[],
): { summary: string; items: string } {
  const counts = new Map<string, number>();
  for (const row of held) {
    const category = categoryOf(row.eventType);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  const summary = [...counts]
    .map(
      ([category, count]) =>
        `${CATEGORY_LABELS[category] ?? 'อื่น ๆ'} ${count}`,
    )
    .join(' · ');
  const lines = held
    .slice(0, LISTED)
    .map((row) => `• ${row.title} — ${row.body}`);
  if (held.length > LISTED) lines.push(`และอีก ${held.length - LISTED} รายการ`);
  return { summary, items: lines.join('\n') };
}
