import { Injectable, Logger } from '@nestjs/common';
import { AppError, AuditWriter, auditActor } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { CustomerRepository } from '../crm/customer.repository';
import { CustomerTimelineService } from '../crm/customer-timeline.service';
import { CustomerTouchpointRepository } from '../crm/keeper.repositories';
import { OpportunitiesService } from '../crm/opportunities.service';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SmartCallRepository,
  SmartProspectRepository,
} from './smart.repositories';

export interface KeeperResult {
  id: string;
  name: string;
  outcome: 'sent' | 'skipped';
  opportunity_id: string | null;
  owner_user_id: string | null;
  reason?: string;
}

interface ProspectRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  sourceId: string;
  matchKind: string | null;
  matchCustomerId: string | null;
  keeperOpportunityId: string | null;
  lastCallId: string | null;
  score: number | null;
}

interface CustomerRow {
  id: string;
  nameTh: string;
  accountOwnerUserId: string | null;
  ownerOrgUnitId: string | null;
}

/**
 * CD-294 (CD-16 AI SMART) — an existing customer interested in more goes
 * straight to the person who keeps the account, never to the shared pool.
 *
 * What it leaves behind: a contact on the customer's record (the 360°
 * timeline and the account plan show it), an upsell deal owned by the
 * account owner carrying the call's summary, and a notice to them. A
 * customer with no owner goes to the head of its own team, else the head of
 * the Keeper team in CRM settings; with no one to give it to, nothing is
 * created and the reason stays on the prospect.
 *
 * The deal is opened by whoever sent it (the call list's author when a call
 * did) and then handed to the owner — so the record says who created it and
 * the audit says who it was given to.
 */
@Injectable()
export class SmartKeeperService {
  private readonly logger = new Logger(SmartKeeperService.name);
  // An automatic send (a call found interest) comes through
  // SmartHandoffService.afterInterest, which keeps any failure on the prospect.

  constructor(
    private readonly prospects: SmartProspectRepository,
    private readonly calls: SmartCallRepository,
    private readonly customers: CustomerRepository,
    private readonly touchpoints: CustomerTouchpointRepository,
    private readonly opportunities: OpportunitiesService,
    private readonly opportunityRows: OpportunityRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly configs: CrmConfigRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
  ) {}

  /** From the queue: these prospects (each must match an existing customer). */
  async send(actor: Principal, ids: string[]) {
    const results: KeeperResult[] = [];
    for (const id of ids) results.push(await this.one(actor, id));
    return results;
  }

  /** The one path — also what CD-293's handoff calls for an existing customer. */
  async one(actor: Principal, id: string): Promise<KeeperResult> {
    const companyId = actor.activeCompanyId;
    const row = (await this.prospects.findFirst({
      where: { id, companyId },
    })) as ProspectRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายชื่อที่กวาดได้');
    const skip = (reason: string): KeeperResult => ({
      id: row.id,
      name: row.name,
      outcome: 'skipped',
      opportunity_id: row.keeperOpportunityId,
      owner_user_id: null,
      reason,
    });
    if (row.keeperOpportunityId) return skip('ส่งถึงผู้ดูแลบัญชีไปแล้ว');
    if (row.status === 'discarded') return skip('ถูกทิ้งไปแล้ว');
    if (row.matchKind !== 'customer' || !row.matchCustomerId) {
      return skip('ไม่ใช่ลูกค้าเดิม — ใช้ "ส่งเข้าแกนขาย" แทน');
    }

    const customer = (await this.customers.findFirst({
      where: { id: row.matchCustomerId, companyId, mergedIntoCustomerId: null },
      select: {
        id: true,
        nameTh: true,
        accountOwnerUserId: true,
        ownerOrgUnitId: true,
      },
    })) as CustomerRow | null;
    if (!customer) return skip('ไม่พบลูกค้าที่จับคู่ไว้ (อาจถูกรวมหรือย้าย)');

    const receiver = await this.receiverOf(companyId, customer);
    if (!receiver) {
      return skip(
        'ลูกค้าไม่มีผู้ดูแลบัญชี ทีมไม่มีหัวหน้า และยังไม่ได้ตั้งทีม Keeper ในหน้าตั้งค่า CRM',
      );
    }

    const call = row.lastCallId
      ? ((await this.calls.findFirst({
          where: { id: row.lastCallId, companyId },
          select: { summary: true, outcome: true, startedAt: true },
        })) as {
          summary: string | null;
          outcome: string | null;
          startedAt: Date;
        } | null)
      : null;
    const summary =
      call?.summary ??
      (call?.outcome === 'interested'
        ? 'ลูกค้าแจ้งว่าสนใจระหว่างการโทรของ AI SMART'
        : 'AI SMART พบว่าลูกค้ารายนี้มีโอกาสขายเพิ่ม');

    // The upsell deal first — if it cannot be opened (a document number,
    // KYC), nothing else is written and the prospect can be sent again.
    // Opened as the sender, then given to the receiver.
    const deal = (await this.opportunities.create(
      {
        customer_id: customer.id,
        title: `ขยายบริการ (AI SMART): ${customer.nameTh}`.slice(0, 200),
        deal_type: 'upsell',
      } as never,
      actor,
    )) as { id: string; opportunityCode?: string; opportunity_code?: string };
    await this.opportunityRows.update({
      where: { id: deal.id },
      data: {
        ownerUserId: receiver.userId,
        ownerOrgUnitId: receiver.orgUnitId,
        updatedBy: actor.userId,
      },
    });
    // A call on the customer's record — what the owner sees in its history.
    // Sent from the queue with no call, the timeline entry below is the record.
    const now = new Date();
    if (call) {
      await this.touchpoints.create({
        data: {
          companyId,
          customerId: customer.id,
          type: 'call',
          occurredAt: call.startedAt,
          summary: `AI SMART: ${summary}`.slice(0, 2000),
          nextSteps: 'ผู้ดูแลบัญชีติดต่อกลับและประเมินดีลขยาย',
          createdBy: actor.userId,
        },
      });
    }
    await this.timeline.publish({
      companyId,
      customerId: customer.id,
      refType: 'customer',
      refId: customer.id,
      eventType: 'customer.contacted',
      summary: `AI SMART: ${summary}`.slice(0, 300),
      actorId: actor.userId,
      actorName: actor.displayName,
      occurredAt: call?.startedAt ?? now,
    });

    await this.prospects.update({
      where: { id: row.id },
      data: {
        keeperOpportunityId: deal.id,
        handoffAxis: 'keeper',
        handedOffAt: now,
        handoffError: null,
      },
    });
    await this.audit.record({
      eventType: 'smart.prospect.to_keeper',
      companyId,
      ...auditActor(actor),
      resourceType: 'smart_prospect',
      resourceId: row.id,
      after: {
        customerId: customer.id,
        opportunityId: deal.id,
        ownerUserId: receiver.userId,
        via: receiver.via,
      },
    });
    await this.notifications
      .smartKeeperInterest(receiver.userId, companyId, {
        opportunityId: deal.id,
        opportunityCode: deal.opportunityCode ?? deal.opportunity_code ?? '',
        customer: customer.nameTh,
        summary,
      })
      .catch((error: unknown) =>
        this.logger.warn(`keeper notice failed: ${String(error)}`),
      );
    return {
      id: row.id,
      name: row.name,
      outcome: 'sent',
      opportunity_id: deal.id,
      owner_user_id: receiver.userId,
    };
  }

  /** The account owner; else the head of its team; else the Keeper team's head. */
  private async receiverOf(companyId: string, customer: CustomerRow) {
    if (customer.accountOwnerUserId) {
      return {
        userId: customer.accountOwnerUserId,
        orgUnitId: customer.ownerOrgUnitId,
        via: 'account_owner' as const,
      };
    }
    const head = await this.headOf(companyId, customer.ownerOrgUnitId);
    if (head) {
      return {
        userId: head,
        orgUnitId: customer.ownerOrgUnitId,
        via: 'team_head' as const,
      };
    }
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { smartKeeperOrgUnitId: true },
    })) as { smartKeeperOrgUnitId: string | null } | null;
    const keeperHead = await this.headOf(
      companyId,
      config?.smartKeeperOrgUnitId ?? null,
    );
    return keeperHead
      ? {
          userId: keeperHead,
          orgUnitId: config?.smartKeeperOrgUnitId ?? null,
          via: 'keeper_team_head' as const,
        }
      : null;
  }

  private async headOf(companyId: string, unitId: string | null) {
    if (!unitId) return null;
    const unit = (await this.orgUnits.findFirst({
      where: { id: unitId, companyId },
      select: { managerUserId: true },
    })) as { managerUserId: string | null } | null;
    return unit?.managerUserId ?? null;
  }
}
