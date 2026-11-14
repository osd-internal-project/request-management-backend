import { Injectable, Logger } from '@nestjs/common';
import { auditActor, AuditWriter, Principal } from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { LeadStatusService } from './lead-status.service';
import { LeadRepository } from './sales.repositories';

/** What the customer did that makes the sale real (user decision, 11 Nov 2026). */
export type LeadWonReason = 'quotation_accepted' | 'sale_order_opened';

/**
 * A Lead closes as `won` when the customer commits — they accept the quotation
 * (a confirmation or a PO answered back) or a sale order is opened — not when
 * it becomes a deal. Converting only links the Lead to its opportunity; until
 * one of those two happens the Lead keeps the open status it had.
 */
@Injectable()
export class LeadClosingService {
  private readonly logger = new Logger(LeadClosingService.name);

  constructor(
    private readonly leads: LeadRepository,
    private readonly statuses: LeadStatusService,
    private readonly audit: AuditWriter,
    private readonly events: DomainEventsService,
  ) {}

  /**
   * Closes the Lead this deal came from, if it is still open. Safe to call
   * twice (accept, then the sale order) and for a deal that never had a Lead.
   * Never fails its caller: the quotation or sale order is already recorded.
   */
  async wonByOpportunity(
    opportunityId: string,
    reason: LeadWonReason,
    actor: Principal,
  ): Promise<void> {
    try {
      const lead = (await this.leads.findFirst({
        where: {
          convertedOpportunityId: opportunityId,
          companyId: actor.activeCompanyId,
        },
        select: { id: true, name: true, status: true, sourceCode: true },
      })) as {
        id: string;
        name: string;
        status: string;
        sourceCode: string | null;
      } | null;
      if (!lead) return;

      const current = await this.statuses.require(
        actor.activeCompanyId,
        lead.status,
      );
      if (current.kind !== 'open') return;

      const status = await this.statuses.closingCode(
        actor.activeCompanyId,
        'won',
      );
      await this.leads.update({
        where: { id: lead.id },
        data: { status, updatedBy: actor.userId },
      });

      await this.audit.record({
        eventType: 'crm.lead.status_changed',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'lead',
        resourceId: lead.id,
        before: { status: lead.status },
        after: { status, reason, opportunityId },
      });

      await this.events.emit({
        name: 'lead.status_changed',
        payload: {
          company_id: actor.activeCompanyId,
          lead_id: lead.id,
          name: lead.name,
          status,
          source_code: lead.sourceCode,
          previous_status: lead.status,
          opportunity_id: opportunityId,
          reason,
        },
      });
    } catch (failure) {
      this.logger.warn(
        `lead of opportunity ${opportunityId} not closed as won: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    }
  }
}
