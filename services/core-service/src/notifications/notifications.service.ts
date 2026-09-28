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

  /** The step now waiting: every candidate and whoever covers for them, never the requester. */
  async awaitingApproval(
    approvalCase: CaseWithSteps,
    companyId: string,
  ): Promise<void> {
    const step = approvalCase.steps.find(
      (candidate) => candidate.stepNo === approvalCase.currentStep,
    );
    if (!step) return;

    const subject = await this.subjectOf(approvalCase);
    const candidates = await this.withDelegates(companyId, candidatesOf(step));

    await this.emitTo(
      candidates.filter((userId) => userId !== subject.requesterId),
      {
        companyId,
        eventType: 'approval.awaiting',
        title: 'มีรายการรออนุมัติ',
        body: `${subject.label} รอคุณอนุมัติ (ขั้น ${step.stepNo}/${approvalCase.steps.length})`,
        ...subject.link,
      },
    );
  }

  /**
   * After a decision: progress to the requester, the baton to the next step, or
   * the outcome to whoever acts next — the requester before the work, the team after it.
   */
  async decisionMade(
    approvalCase: CaseWithSteps,
    decision: string,
    note: string | null = null,
  ): Promise<void> {
    const subject = await this.subjectOf(approvalCase);
    const base = { companyId: approvalCase.companyId, ...subject.link };

    if (approvalCase.status === 'pending') {
      await this.emitTo([subject.requesterId], {
        ...base,
        eventType: 'approval.step_passed',
        title: 'ผ่านการอนุมัติขั้นหนึ่งแล้ว',
        body: `${subject.label} ผ่านการอนุมัติขั้น ${approvalCase.currentStep - 1}/${approvalCase.steps.length}`,
      });
      await this.awaitingApproval(approvalCase, approvalCase.companyId);
      return;
    }

    const stage = stageOf(approvalCase.subjectType);
    const reason = note ? `: ${note}` : '';
    const team = [subject.workerId];

    if (decision === 'approve') {
      const [who, title] =
        stage === 'pre'
          ? [
              [subject.requesterId, subject.receiverId],
              'อนุมัติแล้ว — รอทีมรับเรื่อง',
            ]
          : stage === 'step'
            ? [team, 'อนุมัติขั้นนี้แล้ว — งานไปขั้นถัดไป']
            : [
                [subject.requesterId, subject.workerId],
                'ผ่านการตรวจแล้ว — ผู้ขอปิดคำขอได้',
              ];
      await this.emitTo(who, {
        ...base,
        eventType: 'approval.approved',
        title,
        body: subject.label,
      });
      return;
    }

    if (decision === 'reject') {
      await this.emitTo(
        stage === 'pre'
          ? [subject.requesterId]
          : [subject.requesterId, subject.workerId],
        {
          ...base,
          eventType: 'approval.rejected',
          title: 'คำขอไม่ได้รับอนุมัติ',
          body: `${subject.label}${reason}`,
        },
      );
      return;
    }

    await this.emitTo(stage === 'pre' ? [subject.requesterId] : team, {
      ...base,
      eventType: 'approval.returned',
      title:
        stage === 'pre' ? 'คำขอถูกส่งกลับให้แก้ไข' : 'งานถูกส่งกลับให้ทีมแก้',
      body: `${subject.label}${reason}`,
    });
  }

  /** A request cancelled while waiting: its approvers no longer owe a decision. */
  async approvalWithdrawn(requestId: string, companyId: string): Promise<void> {
    const closed = await this.prisma.approvalCase.findFirst({
      where: { requestId, status: 'cancelled' },
      orderBy: { decidedAt: 'desc' },
      include: { steps: true },
    });
    if (!closed) return;

    const step = closed.steps.find(
      (candidate) => candidate.stepNo === closed.currentStep,
    );
    if (!step) return;

    const subject = await this.subjectOf(closed);
    await this.emitTo(await this.withDelegates(companyId, candidatesOf(step)), {
      companyId,
      eventType: 'approval.withdrawn',
      title: 'คำขอถูกยกเลิก ไม่ต้องอนุมัติแล้ว',
      body: subject.label,
      ...subject.link,
    });
  }

  /** What a notification names and links to: the request when there is one. */
  private async subjectOf(approvalCase: ApprovalCase) {
    const request = approvalCase.requestId
      ? await this.prisma.request.findUnique({
          where: { id: approvalCase.requestId },
          select: {
            id: true,
            requestNo: true,
            requesterId: true,
            receiverUserId: true,
            assigneeUserId: true,
            requestType: { select: { name: true } },
          },
        })
      : null;

    return {
      label: request
        ? [request.requestNo, request.requestType.name]
            .filter(Boolean)
            .join(' · ')
        : approvalCase.subjectType,
      requesterId: request?.requesterId ?? approvalCase.createdBy ?? null,
      receiverId: request?.receiverUserId ?? null,
      workerId: request?.assigneeUserId ?? request?.receiverUserId ?? null,
      link: request
        ? { resourceType: 'request', resourceId: request.id }
        : { resourceType: 'approval_case', resourceId: approvalCase.id },
    };
  }

  /** Candidates plus anyone actively covering for one of them (APV-03). */
  private async withDelegates(
    companyId: string,
    candidates: readonly string[],
  ): Promise<string[]> {
    if (!candidates.length) return [];
    const now = new Date();
    const covering = await this.prisma.delegation.findMany({
      where: {
        companyId,
        delegatorUserId: { in: [...candidates] },
        active: true,
        revokedAt: null,
        fromDate: { lte: now },
        toDate: { gte: now },
      },
      select: { delegateUserId: true },
    });
    return [...candidates, ...covering.map((row) => row.delegateUserId)];
  }

  /** One notification per distinct person; nulls dropped. */
  private async emitTo(
    userIds: readonly (string | null)[],
    entry: Omit<Parameters<NotificationsService['emit']>[0], 'userId'>,
  ): Promise<void> {
    const distinct = [
      ...new Set(userIds.filter((id): id is string => Boolean(id))),
    ];
    for (const userId of distinct) {
      await this.emit({ ...entry, userId });
    }
  }

  // --- reads --------------------------------------------------------------

  async list(actor: Principal, query: PageQueryDto & { unread?: 'true' }) {
    const { skip, take } = toSkipTake(query);
    const where = {
      userId: actor.userId,
      companyId: actor.activeCompanyId,
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
        readAt: null,
      },
    });
    return { count };
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

  /** SUP-02 — an approval step is past its own deadline; `escalated` reaches the approver's head. */
  async approvalOverdue(
    userId: string,
    companyId: string,
    link: { requestId: string | null; caseId: string; label: string },
    escalated: boolean,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: escalated ? 'approval.escalated' : 'approval.overdue',
      title: escalated
        ? 'รายการอนุมัติค้างนานเกินกำหนด'
        : 'รายการรออนุมัติเกินเวลาที่ตั้งไว้',
      body: `${link.label} ยังรอการอนุมัติ`,
      resourceType: link.requestId ? 'request' : 'approval_case',
      resourceId: link.requestId ?? link.caseId,
    });
  }

  /** SUP-02 — the deadline is near; told to whoever holds the work. */
  async slaWarning(
    userId: string,
    companyId: string,
    requestId: string,
    requestNo: string | null,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'sla.warning',
      title: 'คำขอใกล้ครบกำหนด SLA',
      body: `คำขอ ${requestNo ?? requestId} จะครบกำหนดภายใน 4 ชั่วโมง`,
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

/** Everyone the step named; the pre-`candidateUserIds` fallback is the one approver. */
function candidatesOf(step: ApprovalStep): string[] {
  if (step.candidateUserIds.length) return step.candidateUserIds;
  return step.approverUserId ? [step.approverUserId] : [];
}

/** Which stage routed a case, read off its subject like `decide` does. */
function stageOf(subjectType: string): 'pre' | 'step' | 'post' {
  if (subjectType.endsWith(':pre')) return 'pre';
  if (subjectType.includes(':step:')) return 'step';
  return 'post';
}
