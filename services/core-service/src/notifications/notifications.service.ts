import { Injectable, Logger } from '@nestjs/common';
import {
  PrismaService,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { PageQueryDto, Principal } from '@request-management/share';
import type { ApprovalCase, ApprovalStep } from '@prisma/client';
import { LoggingEmailTransport } from './notification-transport';

type CaseWithSteps = ApprovalCase & { steps: ApprovalStep[] };

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

    await this.emit({
      userId: approvalCase.createdBy,
      companyId: approvalCase.companyId,
      eventType: `approval.${decision}d`,
      title: titles[decision] ?? 'มีการอัปเดตคำขอของคุณ',
      body: `${approvalCase.subjectType} — ${approvalCase.status}`,
      resourceType: 'approval_case',
      resourceId: approvalCase.id,
    });
  }

  // --- reads --------------------------------------------------------------

  async list(actor: Principal, query: PageQueryDto) {
    const { skip, take } = toSkipTake(query);
    const where = { userId: actor.userId, companyId: actor.activeCompanyId };

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

  /** Scoped to the owner, so one person cannot mark another's as read. */
  async markRead(id: string, actor: Principal): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id, userId: actor.userId },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(actor: Principal): Promise<void> {
    await this.prisma.notification.updateMany({
      where: {
        userId: actor.userId,
        companyId: actor.activeCompanyId,
        readAt: null,
      },
      data: { readAt: new Date() },
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
      const notification = await this.prisma.notification.create({
        data: entry,
      });

      // In-app is delivered the moment the row exists.
      await this.prisma.notificationDeliveryLog.create({
        data: {
          notificationId: notification.id,
          channel: 'in_app',
          target: entry.userId,
          status: 'sent',
          sentAt: new Date(),
        },
      });

      await this.deliverEmail(notification.id, entry);
    } catch (error) {
      this.logger.error(
        `Failed to emit ${entry.eventType} for ${entry.userId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async deliverEmail(
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
  async getPreferences(actor: Principal) {
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
    };
  }

  /** Records the choice. Upsert, because the row only exists once changed. */
  async updatePreferences(actor: Principal, emailEnabled: boolean) {
    await this.prisma.notificationPreference.upsert({
      where: {
        userId_companyId: {
          userId: actor.userId,
          companyId: actor.activeCompanyId,
        },
      },
      create: {
        userId: actor.userId,
        companyId: actor.activeCompanyId,
        emailEnabled,
      },
      update: { emailEnabled },
    });

    return this.getPreferences(actor);
  }
}
