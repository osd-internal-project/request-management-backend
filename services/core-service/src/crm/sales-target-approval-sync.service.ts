import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
import { SalesTargetRevisionRepository } from './sales.repositories';

type Outcome = 'approved' | 'rejected' | 'cancelled';

/**
 * CD-82 — carries the outcome of a target-adjustment request back to the
 * target, the same way `QuotationApprovalSyncService` does for low margins:
 * subscribed to the in-process domain events, after commit.
 *
 * Matched by `SalesTargetRevision.approvalRequestId` (unique), never by type
 * code — the type is configuration. Idempotent and stale-safe: only a revision
 * still `pending_approval` on that very request moves, and the target's
 * amount changes in the same transaction or not at all.
 */
@Injectable()
export class SalesTargetApprovalSyncService implements OnModuleInit {
  private readonly logger = new Logger(SalesTargetApprovalSyncService.name);

  constructor(
    private readonly events: DomainEventsService,
    private readonly revisions: SalesTargetRevisionRepository,
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

  async onRequestOutcome(
    payload: RequestEventPayload,
    outcome: Outcome,
  ): Promise<void> {
    const revision = (await this.revisions.findFirst({
      where: {
        approvalRequestId: payload.request_id,
        status: 'pending_approval',
      },
      select: {
        id: true,
        companyId: true,
        targetId: true,
        previousAmount: true,
        newAmount: true,
      },
    })) as {
      id: string;
      companyId: string;
      targetId: string;
      previousAmount: Prisma.Decimal | null;
      newAmount: Prisma.Decimal;
    } | null;

    if (!revision) return;

    const approved = outcome === 'approved';
    const now = new Date();

    await this.transactions.execute(async (prisma) => {
      const moved = await prisma.salesTargetRevision.updateMany({
        where: { id: revision.id, status: 'pending_approval' },
        data: {
          status: approved ? 'applied' : outcome,
          decidedAt: now,
        },
      });
      if (moved.count !== 1) return;

      if (approved) {
        await prisma.salesTarget.update({
          where: { id: revision.targetId },
          data: { amount: revision.newAmount, updatedBy: null },
        });
      }

      await this.audit.record(
        {
          eventType: approved
            ? 'crm.sales_target.adjustment_approved'
            : 'crm.sales_target.adjustment_failed',
          companyId: revision.companyId,
          actorId: null,
          actorUsername: 'sales-target-approval-sync',
          resourceType: 'sales_target',
          resourceId: revision.targetId,
          before: { amount: revision.previousAmount?.toFixed(2) ?? null },
          after: {
            amount: (approved
              ? revision.newAmount
              : revision.previousAmount
            )?.toFixed(2),
            revisionId: revision.id,
            requestId: payload.request_id,
            requestNo: payload.request_no,
            outcome,
          },
        },
        { prisma },
      );
    });

    this.logger.log(
      `sales target ${revision.targetId} ← request ${payload.request_no ?? payload.request_id} ${outcome}`,
    );
  }
}
