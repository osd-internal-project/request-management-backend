import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  AppError,
  PrismaService,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { PageQueryDto, Principal } from '@request-management/share';
import type { ApprovalCase, ApprovalStep, Prisma } from '@prisma/client';
import { LoggingEmailTransport } from './notification-transport';
import { TEAMS_CLIENT, type TeamsClient } from './teams/teams-client';
import {
  emailSignature,
  renderTemplate,
  templateOf,
} from './notification-templates';
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

/** CD-67 levels as the message reads them. */
const SEVERITY_LABELS: Record<string, string> = {
  critical: 'วิกฤต',
  high: 'สูง',
  medium: 'ปานกลาง',
  low: 'ต่ำ',
};

export interface NotificationPreferencesView {
  in_app: true;
  in_app_locked: true;
  email: boolean;
  email_delivery_available: boolean;
  /** CD-51 — the Teams switch; `teams_available` false = TEAMS_MODE off. */
  teams: boolean;
  teams_available: boolean;
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
    @Optional()
    @Inject(TEAMS_CLIENT)
    private readonly teams: TeamsClient | null = null,
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
        values: {
          subject: `${subject.label} (ขั้น ${step.stepNo}/${approvalCase.steps.length})`,
        },
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
        values: {
          subject: subject.label,
          step: `${approvalCase.currentStep - 1}/${approvalCase.steps.length}`,
        },
      });
      await this.awaitingApproval(approvalCase, approvalCase.companyId);
      return;
    }

    const stage = stageOf(approvalCase.subjectType);
    const reason = note ? `: ${note}` : '';
    const team = [subject.workerId];

    if (decision === 'approve') {
      const [who, status] =
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
        values: { subject: subject.label, status },
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
          values: { subject: subject.label, status: `ไม่อนุมัติ${reason}` },
        },
      );
      return;
    }

    await this.emitTo(stage === 'pre' ? [subject.requesterId] : team, {
      ...base,
      eventType: 'approval.returned',
      values: {
        subject: subject.label,
        status: `${stage === 'pre' ? 'ส่งกลับให้ผู้ขอแก้ไข' : 'ส่งกลับให้ทีมแก้งาน'}${reason}`,
      },
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
      values: { subject: subject.label },
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
      values: { request_no: requestNo ?? requestId },
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
      values: {
        request_no: requestNo ?? requestId,
        severity_note: severity
          ? ` (ความรุนแรง ${SEVERITY_LABELS[severity] ?? severity})`
          : '',
      },
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
      values: { subject: link.label },
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
      values: { request_no: requestNo ?? requestId },
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
      values: {
        opportunity_code: opportunity.opportunityCode,
        opportunity_title: opportunity.title,
        days: String(days),
      },
      resourceType: 'opportunity',
      resourceId: opportunity.id,
    });
  }

  /** CD-162 — a contract with no renewal deal is about to end, or has. */
  async contractExpiry(
    userId: string,
    companyId: string,
    contract: {
      id: string;
      contractNo: string;
      title: string;
      party: string;
      endOn: string;
    },
    daysLeft: number,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType:
        daysLeft <= 0 ? 'legal.contract.expired' : 'legal.contract.expiring',
      values: {
        contract_no: contract.contractNo,
        contract_title: contract.title,
        party: contract.party,
        end_on: contract.endOn,
        days_left: String(daysLeft),
      },
      resourceType: 'customer_contract',
      resourceId: contract.id,
    });
  }

  /** CD-163 — an obligation handed to someone, coming due, or overdue. */
  async contractObligation(
    kind: 'assigned' | 'due' | 'overdue',
    userId: string,
    companyId: string,
    obligation: { title: string; dueOn: string | null },
    contract: { contractNo: string },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: `legal.obligation.${kind}`,
      values: {
        title: obligation.title,
        contract_no: contract.contractNo,
        due_on: obligation.dueOn ?? '—',
      },
      // The owner may not read the contract — their list is where it leads.
      resourceType: 'contract_obligation',
      resourceId: 'mine',
    });
  }

  /** CD-171 — still waiting: to the signer again, or to the sender. */
  async esignReminder(
    kind: 'reminder' | 'expiring' | 'expired',
    userId: string,
    companyId: string,
    envelope: { id: string; title: string; expiresAt: Date },
    signer?: { id: string; role: string },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: `esign.${kind}`,
      values: {
        title: envelope.title,
        role: signer?.role ?? '',
        expires_on: envelope.expiresAt.toLocaleDateString('th-TH', {
          timeZone: 'Asia/Bangkok',
        }),
      },
      resourceType: signer ? 'esign_signer' : 'esign_envelope',
      resourceId: signer?.id ?? envelope.id,
    });
  }

  /** CD-166 — an internal signer's turn to sign. */
  async esignRequested(
    userId: string,
    companyId: string,
    signer: { id: string; role: string },
    envelope: { title: string; expiresAt: Date },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'esign.requested',
      values: {
        title: envelope.title,
        role: signer.role,
        expires_on: envelope.expiresAt.toLocaleDateString('th-TH', {
          timeZone: 'Asia/Bangkok',
        }),
      },
      resourceType: 'esign_signer',
      resourceId: signer.id,
    });
  }

  /** CD-169 — everyone signed; to whoever sent it. */
  async esignFinished(
    kind: 'completed' | 'declined',
    userId: string,
    companyId: string,
    envelope: { id: string; title: string; verifyCode: string },
    decline?: { name: string; reason: string },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: `esign.${kind}`,
      values: {
        title: envelope.title,
        verify_code: envelope.verifyCode,
        name: decline?.name ?? '',
        reason: decline?.reason ?? '',
      },
      resourceType: 'esign_envelope',
      resourceId: envelope.id,
    });
  }

  /** CD-175 — someone was made a project's manager or put on its team. */
  async projectAssigned(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    contractNo: string,
    role: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.project.assigned',
      values: {
        project_no: project.projectNo,
        project_name: project.name,
        contract_no: contractNo,
        role,
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-185 — the change board decided a change request. */
  async changeDecided(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string },
    change: { seq: number; title: string; approved: boolean },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.change.decided',
      values: {
        project_no: project.projectNo,
        change_no: `CR-${change.seq}`,
        result: change.approved ? 'อนุมัติแล้ว' : 'ไม่อนุมัติ',
        title: change.title,
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-211 — the approvers decided on a design version (to who sent it). */
  async designDecided(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    version: string,
    approved: boolean,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.design.decided',
      values: {
        project_no: project.projectNo,
        project_name: project.name,
        version,
        result: approved ? 'อนุมัติแล้ว' : 'ไม่อนุมัติ',
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-222 — someone was handed a UAT point to fix. */
  async uatAssigned(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    findingNo: string,
    title: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.uat.assigned',
      values: {
        project_no: project.projectNo,
        project_name: project.name,
        finding_no: findingNo,
        title,
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-189 — someone owns an open point from an acceptance. */
  async acceptanceItemAssigned(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    round: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.acceptance.item_assigned',
      values: {
        project_no: project.projectNo,
        project_name: project.name,
        round,
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-225 — someone was named to inspect a readiness line. */
  async readinessAssigned(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    line: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.readiness.assigned',
      values: {
        project_no: project.projectNo,
        project_name: project.name,
        line,
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-192 — this week's status report is drafted (to the manager). */
  async statusReportDue(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.status_report.due',
      values: { project_no: project.projectNo, project_name: project.name },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-191 — the executives decided on closing a project (to who asked). */
  async closeDecided(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    approved: boolean,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.project.close_decided',
      values: {
        project_no: project.projectNo,
        project_name: project.name,
        result: approved ? 'อนุมัติให้ปิดแล้ว' : 'ไม่อนุมัติให้ปิด',
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-184 — an issue was handed to someone to fix. */
  async issueAssigned(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string },
    issueNo: string,
    title: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.issue.assigned',
      values: { project_no: project.projectNo, issue_no: issueNo, title },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-181 — a task was handed to someone. */
  async taskAssigned(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    task: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.task.assigned',
      values: {
        task,
        project_no: project.projectNo,
        project_name: project.name,
      },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-181 — a task was reported done, to the project's manager. */
  async taskDone(
    userId: string,
    companyId: string,
    project: { id: string; projectNo: string },
    task: string,
    by: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.task.done',
      values: { task, project_no: project.projectNo, by },
      resourceType: 'project',
      resourceId: project.id,
    });
  }

  /** CD-178 — a milestone that unlocks an installment is now forecast later. */
  async milestoneSlipped(
    userId: string,
    companyId: string,
    input: {
      project: { id: string; projectNo: string };
      milestone: string;
      from: string | null;
      to: string;
      installment: { seq: number; label: string; dueOn: string | null };
    },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.milestone.slipped',
      values: {
        project_no: input.project.projectNo,
        milestone: input.milestone,
        from: input.from ?? '-',
        to: input.to,
        installment_seq: String(input.installment.seq),
        installment_label: input.installment.label,
        pay_due: input.installment.dueOn ?? '-',
      },
      resourceType: 'project',
      resourceId: input.project.id,
    });
  }

  /** CD-182 — a milestone that unlocks an installment was achieved. */
  async milestoneAchieved(
    userId: string,
    companyId: string,
    input: {
      project: { id: string; projectNo: string };
      milestone: string;
      installment: { seq: number; label: string; amount: number };
    },
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'pm.milestone.achieved',
      values: {
        project_no: input.project.projectNo,
        milestone: input.milestone,
        installment_seq: String(input.installment.seq),
        installment_label: input.installment.label,
        amount: input.installment.amount.toLocaleString('th-TH', {
          maximumFractionDigits: 2,
        }),
      },
      resourceType: 'project',
      resourceId: input.project.id,
    });
  }

  /** CD-149 — the MSA a contract is made under was changed. */
  async masterAgreementChanged(
    userId: string,
    companyId: string,
    master: { contractNo: string; title: string },
    contract: { id: string; contractNo: string },
    change: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'legal.msa.changed',
      values: {
        master_no: master.contractNo,
        master_title: master.title,
        contract_no: contract.contractNo,
        change,
      },
      resourceType: 'customer_contract',
      resourceId: contract.id,
    });
  }

  /** CD-78 — a number held for a deal expires soon, or has expired. */
  async phoneReservationExpiry(
    userId: string,
    companyId: string,
    opportunity: { id: string; opportunityCode: string; title: string },
    reservation: { number: string; expiresOn: string },
    expired: boolean,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: expired
        ? 'crm.phone_reservation.expired'
        : 'crm.phone_reservation.expiring',
      values: {
        number: formatPhoneNumber(reservation.number),
        expires_on: reservation.expiresOn,
        opportunity_code: opportunity.opportunityCode,
        opportunity_title: opportunity.title,
      },
      resourceType: 'opportunity',
      resourceId: opportunity.id,
    });
  }

  /** CD-70 — a renewal deal was opened from a contract's end date. */
  async contractRenewalOpened(
    userId: string,
    companyId: string,
    contract: { contractNo: string; title: string },
    deal: { id: string; opportunityCode: string },
    daysLeft: number,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.contract.renewal_opened',
      values: {
        contract_no: contract.contractNo,
        contract_title: contract.title,
        days_left: String(daysLeft),
        opportunity_code: deal.opportunityCode,
      },
      resourceType: 'opportunity',
      resourceId: deal.id,
    });
  }

  /** CD-70 — each reminder step of the company's rule (CD-53), while the deal is open. */
  async contractRenewalDue(
    userId: string,
    companyId: string,
    contract: { contractNo: string; title: string },
    deal: { id: string; opportunityCode: string },
    daysLeft: number,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.contract.renewal_due',
      values: {
        contract_no: contract.contractNo,
        contract_title: contract.title,
        days_left: String(daysLeft),
        opportunity_code: deal.opportunityCode,
      },
      resourceType: 'opportunity',
      resourceId: deal.id,
    });
  }

  /** CD-86 — a customer's account review is due (the `customer.review` rule). */
  async accountReviewDue(
    userId: string,
    companyId: string,
    customer: { id: string; customerCode: string; nameTh: string },
    reviewOn: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.account.review_due',
      values: {
        customer_code: customer.customerCode,
        customer_name: customer.nameTh,
        review_on: reviewOn,
      },
      resourceType: 'customer',
      resourceId: customer.id,
    });
  }

  /** CD-53 — an open SAP invoice has passed one of the rule's overdue steps. */
  async invoiceOverdue(
    userId: string,
    companyId: string,
    customer: { id: string; customerCode: string; nameTh: string },
    invoice: {
      docNo: string;
      dueOn: string;
      outstanding: number;
      currency: string;
    },
    daysOverdue: number,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.invoice.overdue',
      values: {
        doc_no: invoice.docNo,
        customer_code: customer.customerCode,
        customer_name: customer.nameTh,
        due_on: invoice.dueOn,
        days_overdue: String(daysOverdue),
        outstanding: invoice.outstanding.toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
        currency: invoice.currency,
      },
      resourceType: 'customer',
      resourceId: customer.id,
    });
  }

  /** CD-61 — a customer's KYC runs out within the warning window. */
  async kycExpiring(
    userId: string,
    companyId: string,
    customer: { id: string; customerCode: string; nameTh: string },
    expiresOn: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.kyc.expiring',
      values: {
        customer_code: customer.customerCode,
        customer_name: customer.nameTh,
        expires_on: expiresOn,
      },
      resourceType: 'customer',
      resourceId: customer.id,
    });
  }

  /** CD-61 — a customer's KYC has run out; it is unverified again. */
  async kycExpired(
    userId: string,
    companyId: string,
    customer: { id: string; customerCode: string; nameTh: string },
    expiresOn: string,
  ): Promise<void> {
    await this.emit({
      userId,
      companyId,
      eventType: 'crm.kyc.expired',
      values: {
        customer_code: customer.customerCode,
        customer_name: customer.nameTh,
        expires_on: expiresOn,
      },
      resourceType: 'customer',
      resourceId: customer.id,
    });
  }

  /**
   * CD-84 — a won deal's handover: sent (to the receiving team's head),
   * accepted or returned (to the deal's owner and whoever sent it).
   */
  async handoverChanged(
    userIds: readonly (string | null)[],
    companyId: string,
    event: 'submitted' | 'accepted' | 'returned',
    handover: { id: string },
    values: {
      opportunity_code: string;
      opportunity_title: string;
      customer_name: string;
      team_name: string;
      sender_name: string;
      actor_name: string;
      reason?: string;
    },
  ): Promise<void> {
    await this.emitTo(userIds, {
      companyId,
      eventType: `crm.handover.${event}`,
      values: { ...values, reason: values.reason ?? '' },
      resourceType: 'sales_handover',
      resourceId: handover.id,
    });
  }

  /**
   * CD-54 — the wording for one event in one company: the company's own if
   * it saved one, else the standard. An event the catalog does not declare
   * throws — wording must not live only inside a caller again.
   */
  async render(
    companyId: string,
    eventType: string,
    values: Record<string, string>,
  ): Promise<{ title: string; body: string }> {
    const definition = templateOf(eventType);
    if (!definition) {
      throw new Error(`no notification template for ${eventType}`);
    }
    const own = await this.prisma.notificationTemplate.findUnique({
      where: { companyId_eventType: { companyId, eventType } },
      select: { title: true, body: true },
    });
    return {
      title: renderTemplate(own?.title ?? definition.title, values),
      body: renderTemplate(own?.body ?? definition.body, values),
    };
  }

  private async emit(event: {
    userId: string;
    companyId: string;
    eventType: string;
    values: Record<string, string>;
    resourceType: string;
    resourceId: string;
  }): Promise<void> {
    const { values, ...rest } = event;
    try {
      const entry = {
        ...rest,
        ...(await this.render(event.companyId, event.eventType, values)),
      };

      // CD-52 — the recipient's choice for this kind of event.
      const preference = await this.prisma.notificationPreference.findUnique({
        where: {
          userId_companyId: {
            userId: entry.userId,
            companyId: entry.companyId,
          },
        },
        select: {
          emailEnabled: true,
          teamsEnabled: true,
          categorySettings: true,
        },
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
      // CD-51: queued, not sent here — TeamsDeliveryService sends it.
      if (!held && preference?.teamsEnabled !== false) {
        await this.queueTeams(notification.id, entry.userId);
      }
    } catch (error) {
      this.logger.error(
        `Failed to emit ${event.eventType} for ${event.userId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Also used for the digest — one email carrying the day's held items.
   * CD-54: signed with the company's letterhead (the one on its quotations).
   */
  async deliverEmail(
    notificationId: string,
    entry: { userId: string; companyId: string; title: string; body: string },
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: entry.userId },
      select: { email: true },
    });

    if (!user?.email) return;

    const company = await this.prisma.company.findUnique({
      where: { id: entry.companyId },
      select: {
        name: true,
        crmConfig: {
          select: {
            letterheadNameTh: true,
            letterheadAddress: true,
            letterheadPhone: true,
            letterheadEmail: true,
            letterheadWebsite: true,
          },
        },
      },
    });
    const body = company
      ? `${entry.body}\n\n${emailSignature(company.name, company.crmConfig)}`
      : entry.body;

    // Recorded as `failed` when there is no mail server, because that is what
    // happened — reporting it as sent would make the gap invisible.
    const configured = this.email.isConfigured;

    await this.email.send({
      to: user.email,
      subject: entry.title,
      body,
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

  /**
   * CD-51 — a Teams message waiting for the worker. Nothing when the channel
   * is off (TEAMS_MODE unset): no row that could only ever fail.
   */
  async queueTeams(notificationId: string, userId: string): Promise<void> {
    if (!this.teams) return;
    await this.prisma.notificationDeliveryLog.create({
      data: {
        notificationId,
        channel: 'teams',
        target: userId,
        status: 'queued',
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
      teams: found?.teamsEnabled ?? true,
      teams_available: Boolean(this.teams),
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
      teams?: boolean;
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
      ...(dto.teams !== undefined ? { teamsEnabled: dto.teams } : {}),
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

/** `021008888` → `02-100-8888`, `0861234567` → `086-123-4567`. */
export function formatPhoneNumber(number: string): string {
  if (/^02\d{7}$/.test(number)) {
    return `${number.slice(0, 2)}-${number.slice(2, 5)}-${number.slice(5)}`;
  }
  if (/^0\d{9}$/.test(number)) {
    return `${number.slice(0, 3)}-${number.slice(3, 6)}-${number.slice(6)}`;
  }
  return number;
}
