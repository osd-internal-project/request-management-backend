import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  PrismaService,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { PageQueryDto, Principal } from '@request-management/share';
import type { ApprovalCase, ApprovalStep, Prisma } from '@prisma/client';
import { LoggingEmailTransport } from './notification-transport';
import {
  DEFAULT_DIGEST_HOUR,
  DIGESTIBLE,
  NOTIFICATION_CATEGORIES,
  categoryOf,
  settingOf,
  type CategorySetting,
  type NotificationCategory,
} from './notification-categories';

type CaseWithSteps = ApprovalCase & { steps: ApprovalStep[] };

export interface NotificationPreferencesView {
  in_app: true;
  in_app_locked: true;
  email: boolean;
  email_delivery_available: boolean;
  /** CD-52 — Bangkok hour, working days. */
  digest_hour: number;
  categories: ({
    key: NotificationCategory;
    /** false = urgent; only `immediate` is accepted. */
    digestible: boolean;
  } & CategorySetting)[];
}

/**
 * SUP-03 — the minimum notification service.
 *
 * In-app is the reliable channel and works today. Email goes through a
 * transport that currently only logs, because Infra has not supplied SMTP
 * settings (open question B) — every attempt is still written to
 * `notification_delivery_logs`, so "every send logged" holds and the gap is
 * visible rather than silent.
 *
 * Notifying must never fail the thing being notified about: an approval that
 * succeeded and then threw because email was down would be a worse bug than
 * a missing notification.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: LoggingEmailTransport,
  ) {}

  /** The next approver has something waiting. */
  async awaitingApproval(
    approvalCase: CaseWithSteps,
    companyId: string,
  ): Promise<void> {
    const step = approvalCase.steps.find(
      (candidate) => candidate.stepNo === approvalCase.currentStep,
    );

    if (!step?.approverUserId) return;

    await this.emit({
      userId: step.approverUserId,
      companyId,
      eventType: 'approval.awaiting',
      title: 'มีรายการรออนุมัติ',
      body: `${approvalCase.subjectType} รอการอนุมัติจากคุณ`,
      resourceType: 'approval_case',
      resourceId: approvalCase.id,
    });
  }

  /** The requester learns the outcome. */
  async decisionMade(
    approvalCase: CaseWithSteps,
    decision: string,
  ): Promise<void> {
    if (approvalCase.status === 'pending') {
      // Not finished — the baton moved, so tell the next approver instead.
      await this.awaitingApproval(approvalCase, approvalCase.companyId);
      return;
    }

    if (!approvalCase.createdBy) return;

    const titles: Record<string, string> = {
      approve: 'คำขอของคุณได้รับอนุมัติ',
      reject: 'คำขอของคุณไม่ได้รับอนุมัติ',
      return: 'คำขอของคุณถูกส่งกลับให้แก้ไข',
    };

    // `approval.${decision}d` produced `approval.rejectd` / `approval.returnd`.
    const past: Record<string, string> = {
      approve: 'approved',
      reject: 'rejected',
      return: 'returned',
    };

    await this.emit({
      userId: approvalCase.createdBy,
      companyId: approvalCase.companyId,
      eventType: `approval.${past[decision] ?? decision}`,
      title: titles[decision] ?? 'มีการอัปเดตคำขอของคุณ',
      body: `${approvalCase.subjectType} — ${approvalCase.status}`,
      resourceType: 'approval_case',
      resourceId: approvalCase.id,
    });
  }

  // --- reads --------------------------------------------------------------

  async list(actor: Principal, query: PageQueryDto & { unread?: 'true' }) {
    const { skip, take } = toSkipTake(query);
    const where = {
      userId: actor.userId,
      companyId: actor.activeCompanyId,
      // CD-52: held for the digest — the digest row stands in for them.
      heldForDigest: false,
      ...(query.unread === 'true' ? { readAt: null } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginated(rows, query, total);
  }

  /** ที่ยังไม่อ่านในบริษัทที่เปิดอยู่ — ตัวเลขบนกระดิ่ง. */
  async unreadCount(actor: Principal): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: {
        userId: actor.userId,
        companyId: actor.activeCompanyId,
        heldForDigest: false,
        readAt: null,
      },
    });
    return { count };
  }

  /**
   * Scoped to the owner, so one person cannot mark another's as read.
   *
   * CD-55: only the first read is recorded. Opening it again used to move
   * `readAt` forward, which erased the one fact the log exists to prove —
   * when the person first saw it.
   */
  async markRead(id: string, actor: Principal): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId: actor.userId, readAt: null },
      data: { readAt: new Date(), readVia: 'opened' },
    });
  }

  /** CD-55: recorded as `mark_all` — clearing the bell is not having read it. */
  async markAllRead(actor: Principal): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId: actor.userId,
        companyId: actor.activeCompanyId,
        heldForDigest: false,
        readAt: null,
      },
      data: { readAt: new Date(), readVia: 'mark_all' },
    });
  }

  // --- internals ----------------------------------------------------------

  /**
   * SUP-02 — a deadline passed and somebody senior needs to know.
   *
   * Worded as a fact rather than a request for action: the recipient may be
   * the owner or the rung above them, and a single message that reads
   * correctly for both is less confusing than guessing which one this is.
   */
  async slaBreached(
    userId: string,
    companyId: string,
    requestId: string,
    requestNo: string | null,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'sla.breached',
      title: 'คำขอเกินกำหนด SLA',
      body: `คำขอ ${requestNo ?? requestId} เกินกำหนดเวลาที่ตั้งไว้แล้ว`,
      resourceType: 'request',
      resourceId: requestId,
    });
  }

  /**
   * CD-67 — a case nobody on the receiving side has responded to within its
   * severity's response time. Worded as a fact, like `slaBreached`.
   */
  async slaResponseOverdue(
    userId: string,
    companyId: string,
    requestId: string,
    requestNo: string | null,
    severity: string | null,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'sla.response_overdue',
      title: 'เคสยังไม่มีผู้ตอบกลับเกินเวลา',
      body: `คำขอ ${requestNo ?? requestId}${severity ? ` (ความรุนแรง ${severity})` : ''} เลยเวลาตอบกลับที่กำหนดแล้ว`,
      resourceType: 'request',
      resourceId: requestId,
    });
  }

  /**
   * CD-65 — an open opportunity has had no completed activity for `days`
   * days. Worded as a fact for the same reason as `slaBreached`: the owner and
   * their head get the same message.
   */
  async opportunityStale(
    userId: string,
    companyId: string,
    opportunity: { id: string; opportunityCode: string; title: string },
    days: number,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.opportunity.stale',
      title: 'โอกาสการขายไม่มีความเคลื่อนไหว',
      body: `${opportunity.opportunityCode} ${opportunity.title} ไม่มีกิจกรรมมาแล้วเกิน ${days} วัน`,
      resourceType: 'opportunity',
      resourceId: opportunity.id,
    });
  }

  private async emit(entry: {
    userId: string;
    companyId: string;
    eventType: string;
    title: string;
    body: string;
    resourceType: string;
    resourceId: string;
  }): Promise<void> {
    try {
      // CD-52 — the recipient's choice for this kind of event.
      const preference = await this.prisma.notificationPreference.findUnique({
        where: {
          userId_companyId: {
            userId: entry.userId,
            companyId: entry.companyId,
          },
        },
        select: { emailEnabled: true, categorySettings: true },
      });
      const setting = settingOf(
        preference?.categorySettings,
        categoryOf(entry.eventType),
      );
      const held = setting.frequency === 'daily';

      const notification = await this.prisma.notification.create({
        data: { ...entry, heldForDigest: held },
      });

      // In-app is delivered the moment the row exists — or, when held, logged
      // as queued until the digest carries it (NotificationDigestService).
      await this.prisma.notificationDeliveryLog.create({
        data: {
          notificationId: notification.id,
          channel: 'in_app',
          target: entry.userId,
          status: held ? 'queued' : 'sent',
          sentAt: held ? null : new Date(),
        },
      });

      // CD-52: the email switch is honoured — before, it was recorded and
      // ignored. A held item's email goes with the digest.
      if (!held && preference?.emailEnabled !== false && setting.email) {
        await this.deliverEmail(notification.id, entry);
      }
    } catch (error) {
      this.logger.error(
        `Failed to emit ${entry.eventType} for ${entry.userId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** Also used for the digest — one email carrying the day's held items. */
  async deliverEmail(
    notificationId: string,
    entry: { userId: string; title: string; body: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: entry.userId },
      select: { email: true },
    });

    if (!user?.email) return;

    // Recorded as `failed` when there is no mail server, because that is what
    // happened — reporting it as sent would make the gap invisible.
    const configured = this.email.isConfigured;

    await this.email.send({
      to: user.email,
      subject: entry.title,
      body: entry.body,
    });

    await this.prisma.notificationDeliveryLog.create({
      data: {
        notificationId,
        channel: 'email',
        target: user.email,
        status: configured ? 'sent' : 'failed',
        error: configured ? null : 'SMTP not configured (open question B)',
        sentAt: configured ? new Date() : null,
      },
    });
  }

  // --- SUP-03: channel preferences ---------------------------------------

  /**
   * The caller's channel choices for the active company.
   *
   * Returns the default rather than `404` when nothing was ever saved: a
   * preference row is created on first change, and a screen that had to treat
   * "never touched" as an error state would show one to every new user.
   *
   * `in_app` is reported as a fixed `true` — §09 makes it mandatory, and
   * showing it as a switch that cannot move is clearer than hiding the fact
   * that the channel exists.
   */
  async getPreferences(actor: Principal): Promise<NotificationPreferencesView> {
    const found = await this.prisma.notificationPreference.findUnique({
      where: {
        userId_companyId: {
          userId: actor.userId,
          companyId: actor.activeCompanyId,
        },
      },
    });

    return {
      in_app: true,
      in_app_locked: true,
      email: found?.emailEnabled ?? true,
      /**
       * Open question B: email is recorded but never sent, so a screen can say
       * so instead of promising delivery that will not happen.
       */
      email_delivery_available: false,
      // CD-52
      digest_hour: found?.digestHour ?? DEFAULT_DIGEST_HOUR,
      categories: NOTIFICATION_CATEGORIES.map((key) => ({
        key,
        digestible: DIGESTIBLE.has(key),
        ...settingOf(found?.categorySettings, key),
      })),
    };
  }

  /**
   * Records the choices. Upsert, because the row only exists once changed.
   * Every field is optional so a screen can send only what it edits.
   *
   * CD-52: a category that cannot be batched (SLA) refuses `daily` rather
   * than quietly storing it — a late request heard about tomorrow is too late.
   */
  async updatePreferences(
    actor: Principal,
    dto: {
      email?: boolean;
      digest_hour?: number;
      categories?: Record<string, { email?: boolean; frequency?: string }>;
    },
  ): Promise<NotificationPreferencesView> {
    const where = {
      userId_companyId: {
        userId: actor.userId,
        companyId: actor.activeCompanyId,
      },
    };
    const existing = await this.prisma.notificationPreference.findUnique({
      where,
      select: { categorySettings: true },
    });

    let categorySettings: Record<string, CategorySetting> | undefined;
    if (dto.categories) {
      categorySettings = {};
      for (const key of NOTIFICATION_CATEGORIES) {
        const current = settingOf(existing?.categorySettings, key);
        const change = dto.categories[key] ?? {};
        const frequency = change.frequency ?? current.frequency;
        if (frequency !== 'immediate' && frequency !== 'daily') {
          throw new AppError('VALIDATION_FAILED', 'ความถี่ไม่ถูกต้อง', [
            { field: `categories.${key}.frequency`, reason: String(frequency) },
          ]);
        }
        if (frequency === 'daily' && !DIGESTIBLE.has(key)) {
          throw new AppError(
            'VALIDATION_FAILED',
            'การแจ้งเตือนเรื่องเกินกำหนดต้องส่งทันที — รวมเป็นสรุปรายวันไม่ได้',
            [
              {
                field: `categories.${key}.frequency`,
                reason: 'not_digestible',
              },
            ],
          );
        }
        categorySettings[key] = {
          email: change.email ?? current.email,
          frequency,
        };
      }
    }

    const data = {
      ...(dto.email !== undefined ? { emailEnabled: dto.email } : {}),
      ...(dto.digest_hour !== undefined ? { digestHour: dto.digest_hour } : {}),
      ...(categorySettings
        ? {
            categorySettings:
              categorySettings as unknown as Prisma.InputJsonValue,
          }
        : {}),
    };

    await this.prisma.notificationPreference.upsert({
      where,
      create: {
        userId: actor.userId,
        companyId: actor.activeCompanyId,
        ...data,
      },
      update: data,
    });

    return this.getPreferences(actor);
  }
}
