import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CustomerTimelineService } from '../crm/customer-timeline.service';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type RequestEventPayload,
} from '../events/event-catalog';
import { RequestsService } from '../requests/requests.service';
import { SolutionVersionRepository } from './solution.repositories';
import { SolutionsService } from './solutions.service';
import {
  approvalBlocker,
  approvalFormData,
  type FeasibilityVerdict,
  type SolutionApprovalStatus,
} from './solution-rules';

type Outcome = 'approved' | 'rejected' | 'cancelled';

interface VersionRow {
  id: string;
  versionNo: number;
  status: string;
  summary: string;
  inScope: unknown;
  outOfScope: unknown;
  deliverables: unknown;
  assumptions: unknown;
  approvalStatus: SolutionApprovalStatus;
  approvalRequestId: string | null;
  feasibility: FeasibilityVerdict;
  feasibilityNote: string;
}

/**
 * CD-143 — อนุมัติ Solution (user decisions 29 ก.ย. 2569):
 *
 * - Pre-Sales asks from the current locked version: a **draft** request of
 *   the type the CRM settings name (`solutionApprovalTypeCode`) is raised,
 *   prefilled with what is being approved, so documents can be attached
 *   before it is submitted — the same shape as CD-62;
 * - who approves is the `request:<type>` ladder (after the work: the
 *   technical team reviews, then the heads above the reviewer approve),
 *   editable on screen A1;
 * - the approval belongs to that version. Only an approved version may go to
 *   the customer; a change is a new version, which starts unapproved and
 *   must be approved again.
 *
 * Matched by `SolutionVersion.approvalRequestId`, never by type code.
 */
@Injectable()
export class SolutionApprovalService implements OnModuleInit {
  private readonly logger = new Logger(SolutionApprovalService.name);

  constructor(
    private readonly solutions: SolutionsService,
    private readonly versions: SolutionVersionRepository,
    private readonly requests: RequestsService,
    private readonly configs: CrmConfigRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly events: DomainEventsService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    const outcomes: [DomainEventName, Outcome][] = [
      [DOMAIN_EVENTS.requestApproved, 'approved'],
      [DOMAIN_EVENTS.requestRejected, 'rejected'],
      [DOMAIN_EVENTS.requestCancelled, 'cancelled'],
    ];
    for (const [name, outcome] of outcomes) {
      this.events.on(name, (event) =>
        this.onRequestOutcome(event.payload as RequestEventPayload, outcome),
      );
    }
  }

  /** Raise the draft approval request for this version. */
  async requestApproval(id: string, versionNo: number, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const typeCode = await this.approvalType(solution.companyId);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอ "ขออนุมัติ Solution" ในตั้งค่า CRM',
      );
    }
    const version = (await this.versions.findFirst({
      where: { solutionId: id, versionNo },
    })) as VersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    const blocker = approvalBlocker(
      version,
      versionNo === solution.currentVersionNo,
    );
    if (blocker) throw new AppError('CONFLICT', blocker);

    const deal = (await this.opportunities.findFirst({
      where: { id: solution.opportunityId },
      select: {
        id: true,
        companyId: true,
        opportunityCode: true,
        customerId: true,
      },
    })) as {
      id: string;
      companyId: string;
      opportunityCode: string;
      customerId: string | null;
    } | null;
    const requirements = await this.solutions.activeRequirements(id);

    // Not in a transaction with the link below: `create` runs its own. A
    // failure after it leaves a draft nobody points at, which the requester
    // sees in their drafts and may cancel — not a version stuck `pending`.
    const created = (await this.requests.create(
      {
        type_code: typeCode,
        // On the deal, so the request also shows among the deal's requests.
        ...(deal
          ? { ref_type: 'opportunity', ref_id: deal.opportunityCode }
          : {}),
        form_data: approvalFormData({
          title: solution.title,
          versionNo,
          summary: version.summary,
          inScope: version.inScope,
          outOfScope: version.outOfScope,
          deliverables: version.deliverables,
          assumptions: version.assumptions,
          feasibility: version.feasibility,
          feasibilityNote: version.feasibilityNote,
          requirements,
        }),
      },
      actor,
    )) as { id: string; requestNo: string | null };

    await this.transactions.execute(async (prisma) => {
      const moved = await this.versions.updateMany(
        {
          where: {
            id: version.id,
            status: 'locked',
            approvalStatus: { in: ['none', 'rejected', 'cancelled'] },
          },
          data: {
            approvalStatus: 'pending',
            approvalRequestId: created.id,
            approvedAt: null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError('CONFLICT', 'เวอร์ชันนี้อยู่ระหว่างขออนุมัติแล้ว');
      }
      await this.audit.record(
        {
          eventType: 'presales.solution.approval_requested',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: id,
          before: {
            versionNo,
            approvalStatus: version.approvalStatus,
            previousRequestId: version.approvalRequestId,
          },
          after: {
            versionNo,
            approvalStatus: 'pending',
            requestId: created.id,
          },
        },
        { prisma },
      );
    });
    return { request_id: created.id, request_no: created.requestNo };
  }

  async onRequestOutcome(
    payload: RequestEventPayload,
    outcome: Outcome,
  ): Promise<void> {
    const version = (await this.versions.findFirst({
      where: {
        approvalRequestId: payload.request_id,
        approvalStatus: 'pending',
      },
      select: {
        id: true,
        versionNo: true,
        solution: {
          select: {
            id: true,
            companyId: true,
            opportunity: {
              select: { id: true, opportunityCode: true, customerId: true },
            },
          },
        },
      },
    })) as {
      id: string;
      versionNo: number;
      solution: {
        id: string;
        companyId: string;
        opportunity: {
          id: string;
          opportunityCode: string;
          customerId: string | null;
        };
      };
    } | null;
    // Not ours, redelivered, or already settled — nothing to move.
    if (!version) return;

    const { solution } = version;
    await this.transactions.execute(async (prisma) => {
      const moved = await this.versions.updateMany(
        {
          where: {
            id: version.id,
            approvalRequestId: payload.request_id,
            approvalStatus: 'pending',
          },
          data: {
            approvalStatus: outcome,
            ...(outcome === 'approved' ? { approvedAt: new Date() } : {}),
          },
        },
        { prisma },
      );
      if (moved.count !== 1) return;

      await this.audit.record(
        {
          eventType: `presales.solution.approval_${outcome}`,
          companyId: solution.companyId,
          actorId: null,
          actorUsername: 'solution-approval-sync',
          resourceType: 'solution',
          resourceId: solution.id,
          before: { versionNo: version.versionNo, approvalStatus: 'pending' },
          after: {
            versionNo: version.versionNo,
            approvalStatus: outcome,
            requestId: payload.request_id,
            requestNo: payload.request_no,
          },
        },
        { prisma },
      );
      const deal = solution.opportunity;
      if (deal.customerId) {
        await this.timeline.publish(
          {
            companyId: solution.companyId,
            customerId: deal.customerId,
            refType: 'opportunity',
            refId: deal.id,
            eventType: `opportunity.solution_${outcome}`,
            summary:
              outcome === 'approved'
                ? `${deal.opportunityCode}: อนุมัติ Solution เวอร์ชัน ${version.versionNo} แล้ว — เสนอลูกค้าได้`
                : `${deal.opportunityCode}: Solution เวอร์ชัน ${version.versionNo} ไม่ผ่านการอนุมัติ`,
            actorId: null,
            actorName: 'ระบบ (อนุมัติ Solution)',
          },
          { prisma },
        );
      }
    });
    this.logger.log(
      `CD-143: solution ${solution.id} v${version.versionNo} → ${outcome}`,
    );
  }

  private async approvalType(companyId: string): Promise<string | null> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { solutionApprovalTypeCode: true },
    })) as { solutionApprovalTypeCode: string | null } | null;
    return config?.solutionApprovalTypeCode ?? null;
  }
}
