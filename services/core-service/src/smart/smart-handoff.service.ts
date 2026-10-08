import { Injectable, Logger } from '@nestjs/common';
import { AppError, AuditWriter, auditActor } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { LeadRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestsService } from '../requests/requests.service';
import { SmartKeeperService } from './smart-keeper.service';
import { SmartScreeningService } from './smart-screening.service';
import {
  SmartCallListRepository,
  SmartCallRepository,
  SmartProspectRepository,
} from './smart.repositories';

/** The axes a handoff goes to; Keeper is the account owner's (CD-294). */
export const HANDOFF_AXES = ['getter', 'government', 'partner'] as const;
export type HandoffAxis = (typeof HANDOFF_AXES)[number];

export interface HandoffResult {
  id: string;
  name: string;
  outcome: 'handed_off' | 'lead_only' | 'customer' | 'skipped';
  axis: string | null;
  lead_id: string | null;
  request_id: string | null;
  reason?: string;
}

interface ProspectRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  salesAxis: string | null;
  matchKind: string | null;
  leadId: string | null;
  sentOutcome: string | null;
  handoffRequestId: string | null;
  handedOffAt: Date | null;
  lastCallId: string | null;
  interestedAt: Date | null;
  score: number | null;
  phone: string | null;
}

interface Settings {
  smartHandoffTypeCode: string | null;
  smartGetterOrgUnitId: string | null;
  smartGovernmentOrgUnitId: string | null;
  smartPartnerOrgUnitId: string | null;
}

/** What a handoff's requester may do — enough to raise and submit it. */
const REQUESTER_PERMISSIONS = [
  'request.create',
  'request.read',
  'crm.sales.read',
];

/**
 * CD-293 (CD-16 AI SMART) — an interested prospect to its sales axis.
 *
 * The Lead is made the CD-290 way (the campaign screening): a repeat joins
 * its open Lead, an existing customer reaches its account owner and goes no
 * further here (CD-294). A new one is put under the axis's team (CRM
 * settings) and a request of the configured type is raised for it — the
 * type's receiver owns it, and its SLA is the deadline. Whether the team
 * took it up is read live from that request, never copied.
 *
 * Runs on its own when a call finds interest (as the call list's author),
 * and when someone sends from the queue.
 */
@Injectable()
export class SmartHandoffService {
  private readonly logger = new Logger(SmartHandoffService.name);

  constructor(
    private readonly prospects: SmartProspectRepository,
    private readonly lists: SmartCallListRepository,
    private readonly calls: SmartCallRepository,
    private readonly leads: LeadRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly screening: SmartScreeningService,
    private readonly requests: RequestsService,
    private readonly audit: AuditWriter,
    private readonly keeper: SmartKeeperService,
  ) {}

  /** From the queue: these prospects, optionally to another axis. */
  async handOff(actor: Principal, ids: string[], axis?: HandoffAxis) {
    const results: HandoffResult[] = [];
    for (const id of ids) {
      results.push(await this.one(actor, id, axis));
    }
    return results;
  }

  /**
   * After a call found interest. Never throws — a handoff that cannot be made
   * is recorded on the prospect (`handoffError`) for someone to pick up.
   */
  async afterInterest(companyId: string, prospectId: string, listId: string) {
    try {
      const list = (await this.lists.findFirst({
        where: { id: listId, companyId },
        select: { createdBy: true },
      })) as { createdBy: string } | null;
      if (!list) return;
      const actor = await this.principalOf(list.createdBy, companyId);
      const result = await this.one(actor, prospectId);
      if (result.outcome === 'skipped' && result.reason) {
        await this.prospects.update({
          where: { id: prospectId },
          data: { handoffError: result.reason },
        });
      }
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`handoff of ${prospectId} failed: ${message}`);
      await this.prospects
        .update({
          where: { id: prospectId },
          data: { handoffError: message.slice(0, 500) },
        })
        .catch(() => undefined);
    }
  }

  // --- the one path ---------------------------------------------------------------

  private async one(
    actor: Principal,
    id: string,
    override?: HandoffAxis,
  ): Promise<HandoffResult> {
    const companyId = actor.activeCompanyId;
    const row = (await this.prospects.findFirst({
      where: { id, companyId },
    })) as ProspectRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายชื่อที่กวาดได้');
    const base = { id: row.id, name: row.name };
    const skip = (reason: string): HandoffResult => ({
      ...base,
      outcome: 'skipped',
      axis: null,
      lead_id: row.leadId,
      request_id: row.handoffRequestId,
      reason,
    });

    // CD-294 — an existing customer goes to its account owner, not an axis team.
    if (
      row.matchKind === 'customer' ||
      (override === undefined && row.salesAxis === 'keeper')
    ) {
      const kept = await this.keeper.one(actor, row.id);
      return {
        ...base,
        outcome: kept.outcome === 'sent' ? 'customer' : 'skipped',
        axis: 'keeper',
        lead_id: row.leadId,
        request_id: null,
        ...(kept.reason ? { reason: kept.reason } : {}),
      };
    }

    const settings = (await this.configs.findFirst({
      where: { companyId },
      select: {
        smartHandoffTypeCode: true,
        smartGetterOrgUnitId: true,
        smartGovernmentOrgUnitId: true,
        smartPartnerOrgUnitId: true,
      },
    })) as Settings | null;
    if (row.handoffRequestId) return skip('ส่งเข้าแกนขายไปแล้ว');
    // Handed off before as a Lead only: again only to raise the request,
    // once a handoff type has been set — never a second Lead.
    if (row.handedOffAt && !settings?.smartHandoffTypeCode) {
      return skip('ส่งเข้าแกนแล้ว (ยังไม่ได้ตั้งประเภทคำขอส่งต่อ)');
    }
    if (row.status === 'discarded') return skip('ถูกทิ้งไปแล้ว');
    if (row.status === 'new') return skip('ยังไม่ได้คัดกรอง');
    const axis = override ?? row.salesAxis ?? 'getter';
    if (!(HANDOFF_AXES as readonly string[]).includes(axis)) {
      return skip(`แกนขายไม่รู้จัก: ${axis}`);
    }

    // The Lead, the CD-290 way (a row sent before keeps its Lead).
    let leadId = row.leadId;
    let sentOutcome = row.sentOutcome;
    if (!leadId) {
      const [sent] = await this.screening.send(actor, [row.id]);
      if (sent.outcome === 'skipped' || !sent.lead_id) {
        return skip(sent.reason ?? 'ส่งเข้า CRM ไม่สำเร็จ');
      }
      leadId = sent.lead_id;
      sentOutcome = sent.outcome;
    }
    if (sentOutcome === 'customer') {
      return {
        ...base,
        outcome: 'customer',
        axis: 'keeper',
        lead_id: leadId,
        request_id: null,
        reason: 'ลูกค้าเดิม — ส่งถึงผู้ดูแลบัญชีแล้ว',
      };
    }

    const team = this.teamOf(settings, axis as HandoffAxis);

    // An unowned Lead goes to the axis team; one somebody owns stays theirs.
    if (team) {
      await this.leads.updateMany({
        where: { id: leadId, companyId, ownerUserId: null },
        data: { ownerOrgUnitId: team, updatedBy: actor.userId },
      });
    }

    let requestId: string | null = null;
    if (settings?.smartHandoffTypeCode) {
      requestId = await this.raise(
        actor,
        settings.smartHandoffTypeCode,
        row,
        axis,
        leadId,
      );
    }
    await this.prospects.update({
      where: { id: row.id },
      data: {
        handoffAxis: axis,
        handoffRequestId: requestId,
        handedOffAt: new Date(),
        handoffError: null,
      },
    });
    await this.audit.record({
      eventType: 'smart.prospect.handed_off',
      companyId,
      ...auditActor(actor),
      resourceType: 'smart_prospect',
      resourceId: row.id,
      after: { axis, leadId, requestId, team },
    });
    return {
      ...base,
      outcome: requestId ? 'handed_off' : 'lead_only',
      axis,
      lead_id: leadId,
      request_id: requestId,
      ...(requestId
        ? {}
        : { reason: 'ยังไม่ได้ตั้งประเภทคำขอส่งต่อ — สร้าง Lead อย่างเดียว' }),
    };
  }

  /** The handoff request, submitted; a failed submit leaves no stray draft. */
  private async raise(
    actor: Principal,
    typeCode: string,
    row: ProspectRow,
    axis: string,
    leadId: string,
  ) {
    const call = row.lastCallId
      ? ((await this.calls.findFirst({
          where: { id: row.lastCallId },
          select: { outcome: true, summary: true, startedAt: true },
        })) as {
          outcome: string | null;
          summary: string | null;
          startedAt: Date;
        } | null)
      : null;
    const created = (await this.requests.create(
      {
        type_code: typeCode,
        ref_type: 'lead',
        ref_id: leadId,
        form_data: {
          subject: `AI SMART ส่งต่อโอกาสการขาย: ${row.name}`,
          prospect_name: row.name,
          sales_axis: axis,
          phone: row.phone ?? '',
          score: row.score === null ? '' : String(row.score),
          interested_at: row.interestedAt?.toISOString() ?? '',
          call_summary: call?.summary ?? '',
          call_outcome: call?.outcome ?? '',
          lead_id: leadId,
        },
      },
      actor,
    )) as { id: string };
    try {
      await this.requests.submit(created.id, actor, '');
    } catch (error) {
      await this.requests
        .cancel(
          created.id,
          {
            reason: `ส่งต่อไม่สำเร็จ: ${error instanceof Error ? error.message : 'ไม่ทราบสาเหตุ'}`,
          },
          actor,
        )
        .catch(() => undefined);
      throw error;
    }
    return created.id;
  }

  private teamOf(settings: Settings | null, axis: HandoffAxis) {
    if (!settings) return null;
    return (
      {
        getter: settings.smartGetterOrgUnitId,
        government: settings.smartGovernmentOrgUnitId,
        partner: settings.smartPartnerOrgUnitId,
      }[axis] ?? null
    );
  }

  /** The call list's author, as the requester of an automatic handoff. */
  private async principalOf(
    userId: string,
    companyId: string,
  ): Promise<Principal> {
    const user = (await this.people.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId } },
      },
      select: {
        id: true,
        keycloakId: true,
        username: true,
        displayName: true,
        email: true,
        orgUnitId: true,
        supervisorUserId: true,
        companies: {
          select: {
            isPrimary: true,
            company: { select: { id: true, name: true, docPrefix: true } },
          },
        },
      },
    })) as {
      id: string;
      keycloakId: string;
      username: string;
      displayName: string;
      email: string | null;
      orgUnitId: string | null;
      supervisorUserId: string | null;
      companies: {
        isPrimary: boolean;
        company: { id: string; name: string; docPrefix: string };
      }[];
    } | null;
    if (!user) {
      throw new Error(
        'ผู้สร้างรายการโทรไม่ได้อยู่ในบริษัทนี้แล้ว หรือบัญชีถูกปิด',
      );
    }
    return {
      userId: user.id,
      keycloakId: user.keycloakId,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      companies: user.companies.map((row) => ({
        ...row.company,
        isPrimary: row.isPrimary,
      })),
      activeCompanyId: companyId,
      orgUnitId: user.orgUnitId,
      supervisorUserId: user.supervisorUserId,
      ledUnitIds: [],
      levelUnitIds: [],
      scopedUnitIds: [],
      scopedActUnitIds: [],
      scopedUserIds: [],
      scopedActUserIds: [],
      scopedByPermission: {},
      roles: [],
      permissions: REQUESTER_PERMISSIONS,
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      isServiceAccount: false,
      pendingOrgAssignment: false,
    } as unknown as Principal;
  }
}
