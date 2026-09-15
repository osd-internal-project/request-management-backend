import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AuditWriter,
  PrismaTransactionService,
} from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type RequestEventPayload,
} from '../events/event-catalog';
import { QuotationRepository } from './sales.repositories';
import { CustomerTimelineService } from './customer-timeline.service';

/**
 * CD-76 — carries the outcome of a low-margin approval request back to its
 * quotation, the same way `KycCallbackService` carries a KYC result to the
 * customer: subscribed to the in-process domain events (§11.8), after commit.
 *
 * Matched by `Quotation.approvalRequestId`, never by type code — the approval
 * type is configuration (CRM settings), and a request can be linked to at most
 * the quotation that created it.
 *
 * Idempotent and stale-safe: only a quotation still `pending_approval` on that
 * very request moves. A redelivered event, or one for a version that has since
 * been revised or cancelled, finds nothing to update and stops.
 */
@Injectable()
export class QuotationApprovalSyncService implements OnModuleInit {
  private readonly logger = new Logger(QuotationApprovalSyncService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly quotations: QuotationRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    const outcomes: [DomainEventName, 'approved' | 'rejected' | 'cancelled'][] =
      [
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

  async onRequestOutcome(
    payload: RequestEventPayload,
    outcome: 'approved' | 'rejected' | 'cancelled',
  ): Promise<void> {
    const quotation = (await this.quotations.findFirst({
      where: {
        approvalRequestId: payload.request_id,
        status: 'pending_approval',
      },
      select: {
        id: true,
        quotationNo: true,
        version: true,
        companyId: true,
        customerId: true,
      },
    })) as {
      id: string;
      quotationNo: string;
      version: number;
      companyId: string;
      customerId: string | null;
    } | null;

    if (!quotation) return;

    const approved = outcome === 'approved';
    const requestLabel = payload.request_no ?? payload.request_id;
    const label = `${quotation.quotationNo} v${quotation.version}`;

    await this.transactions.execute(async (prisma) => {
      const moved = await prisma.quotation.updateMany({
        where: { id: quotation.id, status: 'pending_approval' },
        data: approved
          ? { status: 'approved', approvedAt: new Date() }
          : // ไม่ผ่าน = กลับเป็นร่างให้ปรับราคา/ต้นทุนแล้วยื่นใหม่ (คำขอเดิมคงไว้ในประวัติ).
            { status: 'draft' },
      });
      if (moved.count !== 1) return;

      await this.audit.record(
        {
          eventType: approved
            ? 'crm.quotation.approved'
            : 'crm.quotation.approval_failed',
          companyId: quotation.companyId,
          actorId: null,
          actorUsername: 'quotation-approval-sync',
          resourceType: 'quotation',
          resourceId: quotation.id,
          before: { status: 'pending_approval' },
          after: {
            status: approved ? 'approved' : 'draft',
            requestId: payload.request_id,
            requestNo: payload.request_no,
            outcome,
          },
        },
        { prisma },
      );

      if (quotation.customerId) {
        await this.timeline.publish(
          {
            companyId: quotation.companyId,
            customerId: quotation.customerId,
            refType: 'quotation',
            refId: quotation.id,
            eventType: approved
              ? 'quotation.approved'
              : 'quotation.approval_failed',
            summary: approved
              ? `ใบเสนอราคา ${label} ได้รับอนุมัติ margin · คำขอ ${requestLabel}`
              : `ใบเสนอราคา ${label} ไม่ผ่านการอนุมัติ margin (${
                  outcome === 'rejected' ? 'ไม่อนุมัติ' : 'คำขอถูกยกเลิก'
                }) — กลับเป็นร่าง`,
            actorId: null,
            actorName: 'ระบบ (คำขออนุมัติใบเสนอราคา)',
          },
          { prisma },
        );
      }
    });

    this.logger.log(`quotation ${label} ← request ${requestLabel} ${outcome}`);
  }
}
