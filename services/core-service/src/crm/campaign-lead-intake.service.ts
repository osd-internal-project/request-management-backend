import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { NotificationsService } from '../notifications/notifications.service';
import type { ApiKeyContext } from '../principal/api-key.service';
import {
  AD_PLATFORMS,
  REPEAT_WINDOW_DAYS,
  adLead,
  emailKey,
  phoneKey,
  samePerson,
  type AdPlatform,
} from './campaign-lead-rules';
import { CustomerContactRepository } from './customer-child.repositories';
import { CustomerRepository } from './customer.repository';
import { IntakeLeadDto } from './dto/lead-intake.dto';
import { eventOpen, seatFor } from './campaign-event-rules';
import { CampaignRegistrationWriter } from './campaign-registration.writer';
import { LeadStatusService } from './lead-status.service';
import { LeadsService } from './leads.service';
import {
  CampaignRegistrationRepository,
  CampaignRepository,
  LeadActivityRepository,
  LeadRepository,
} from './sales.repositories';

/** What became of one submission. */
export type CampaignLeadOutcome = 'created' | 'customer' | 'repeat';

export interface CampaignLeadResult {
  outcome: CampaignLeadOutcome;
  lead: {
    id: string;
    name: string;
    status: string;
    sourceCode: string | null;
    ownerUserId: string | null;
    createdAt: Date;
  };
}

interface CampaignRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  active: boolean;
  receivingOrgUnitId: string | null;
  formEnabled: boolean;
  formIntro: string | null;
  kind: string;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  eventVenue: string | null;
  eventOnlineUrl: string | null;
  eventCapacity: number | null;
}

const LEAD_SELECT = {
  id: true,
  name: true,
  status: true,
  sourceCode: true,
  ownerUserId: true,
  createdAt: true,
} as const;

/**
 * CD-269 — every Lead from outside goes through here: the external intake API
 * (one key per channel), a campaign's public form, and the Lead Ads webhook.
 * One screening for all of them, before anyone sees the Lead:
 *
 * 1. **Same person again** — an open Lead with the same e-mail or phone in the
 *    last 30 days takes the registration as an activity; no second Lead.
 * 2. **Existing customer** — tax ID, or a contact's e-mail/phone, matches a
 *    customer: the Lead links it and goes straight to the account owner
 *    (Keeper), not into a pool.
 * 3. **New** — unowned, in the campaign's receiving team (CD-268) when it
 *    has one, and the team head is told; otherwise the company pool as before.
 *
 * Creating still goes through `LeadsService.create`, so the default status,
 * audit and the lead workflow are the same as a Lead typed on the screen.
 */
@Injectable()
export class CampaignLeadIntakeService {
  private readonly logger = new Logger(CampaignLeadIntakeService.name);

  constructor(
    private readonly leadsService: LeadsService,
    private readonly leads: LeadRepository,
    private readonly activities: LeadActivityRepository,
    private readonly campaigns: CampaignRepository,
    private readonly customers: CustomerRepository,
    private readonly contacts: CustomerContactRepository,
    private readonly statuses: LeadStatusService,
    private readonly orgUnits: OrgUnitRepository,
    private readonly notifications: NotificationsService,
    // CD-270 — on an event campaign the form records a registration
    private readonly registrations: CampaignRegistrationWriter,
    private readonly registrationRows: CampaignRegistrationRepository,
  ) {}

  /** The screening, for any channel. `dto.source_code` must be set. */
  async receive(
    dto: IntakeLeadDto & { source_code: string },
    actor: Principal,
    now = new Date(),
  ): Promise<CampaignLeadResult> {
    const companyId = actor.activeCompanyId;
    const campaign = dto.campaign_code
      ? await this.campaignByCode(companyId, dto.campaign_code)
      : null;
    const label = campaign?.name ?? dto.source_code;

    const repeat = await this.openLeadOf(companyId, dto, now);
    if (repeat) {
      await this.activities.create({
        data: {
          companyId,
          leadId: repeat.id,
          type: 'note',
          subject: `ลงทะเบียนซ้ำผ่าน ${label}`,
          detail: [
            `ช่องทาง: ${dto.source_code}`,
            dto.contact_name && `ผู้ติดต่อ: ${dto.contact_name}`,
            dto.phone && `โทร: ${dto.phone}`,
            dto.email && `อีเมล: ${dto.email}`,
            dto.note,
          ]
            .filter(Boolean)
            .join('\n'),
          completedAt: now,
          completedBy: actor.userId,
          createdBy: actor.userId,
        },
      });
      const to =
        repeat.ownerUserId ??
        (await this.headOf(repeat.ownerOrgUnitId, companyId));
      if (to) {
        await this.tell(
          to,
          companyId,
          'repeat',
          repeat,
          label,
          dto.source_code,
        );
      }
      return { outcome: 'repeat', lead: repeat };
    }

    const customer = await this.customerOf(companyId, dto);
    const created = (await this.leadsService.create(
      {
        ...dto,
        ...(customer ? { customer_id: customer.id } : {}),
      },
      actor,
      { unowned: true },
    )) as { id: string };

    if (customer?.accountOwnerUserId) {
      await this.leads.update({
        where: { id: created.id },
        data: {
          ownerUserId: customer.accountOwnerUserId,
          ownerOrgUnitId: customer.ownerOrgUnitId,
          updatedBy: actor.userId,
        },
      });
      const lead = await this.read(created.id);
      await this.tell(
        customer.accountOwnerUserId,
        companyId,
        'customer',
        lead,
        label,
        dto.source_code,
      );
      return { outcome: 'customer', lead };
    }

    if (campaign?.receivingOrgUnitId) {
      await this.leads.update({
        where: { id: created.id },
        data: {
          ownerOrgUnitId: campaign.receivingOrgUnitId,
          updatedBy: actor.userId,
        },
      });
      const head = await this.headOf(campaign.receivingOrgUnitId, companyId);
      const lead = await this.read(created.id);
      if (head) {
        await this.tell(
          head,
          companyId,
          'routed',
          lead,
          label,
          dto.source_code,
        );
      }
      return { outcome: 'created', lead };
    }
    return { outcome: 'created', lead: await this.read(created.id) };
  }

  // --- the campaign's public form ------------------------------------------

  /** What the form page shows — only a campaign that is open and has it on. */
  async formOf(token: string, key: ApiKeyContext | undefined) {
    const campaign = await this.campaignByToken(token, key);
    if (campaign.kind !== 'event') {
      return {
        campaign: campaign.name,
        intro: campaign.formIntro,
        kind: 'campaign',
      };
    }
    const seated = await this.registrationRows.count({
      where: { campaignId: campaign.id, status: 'registered' },
    });
    return {
      campaign: campaign.name,
      intro: campaign.formIntro,
      kind: 'event',
      event: {
        starts_at: campaign.eventStartsAt?.toISOString() ?? null,
        ends_at: campaign.eventEndsAt?.toISOString() ?? null,
        venue: campaign.eventVenue,
        online: Boolean(campaign.eventOnlineUrl),
        // the form says so up front, rather than after they type it all in
        full: seatFor(campaign.eventCapacity, seated) === 'waitlisted',
        open: eventOpen(campaign.eventEndsAt, new Date()),
      },
    };
  }

  async submitForm(
    token: string,
    dto: IntakeLeadDto,
    actor: Principal,
    key: ApiKeyContext | undefined,
  ) {
    const campaign = await this.campaignByToken(token, key);
    if (campaign.kind === 'event') return this.registerFor(campaign, dto);
    const result = await this.receive(
      {
        ...dto,
        campaign_code: campaign.code,
        source_code: key?.sourceCode?.trim() || 'web_form',
      },
      { ...actor, activeCompanyId: campaign.companyId },
    );
    // The person on the form learns it was received — nothing about the Lead.
    return { received: true, outcome: result.outcome };
  }

  /**
   * CD-270 — an event's form makes a registration, not a Lead: Leads come
   * after the event, from those who came and are interested.
   */
  private async registerFor(campaign: CampaignRow, dto: IntakeLeadDto) {
    if (!eventOpen(campaign.eventEndsAt, new Date())) {
      throw new AppError('CONFLICT', 'งานนี้จบแล้ว — ปิดรับลงทะเบียน');
    }
    const contactName = dto.contact_name?.trim() || dto.name.trim();
    const result = await this.registrations.register(campaign, {
      contactName,
      company: dto.contact_name?.trim() ? dto.name.trim() : null,
      position: dto.contact_position?.trim() || null,
      phone: dto.phone?.trim() || null,
      email: dto.email?.trim() || null,
      need: dto.note?.trim() || null,
    });
    return {
      received: true,
      status: result.status,
      // the online link only once they hold a seat
      online_url:
        result.status === 'registered' ? campaign.eventOnlineUrl : null,
    };
  }

  // --- Lead Ads (Facebook / TikTok) -----------------------------------------

  /**
   * One answer from a Lead Ads form. The form id picks the campaign
   * (`adFormIds`, CD-269); a form no campaign claims is refused rather than
   * landing without a campaign, since its cost could then never be counted.
   */
  async receiveAd(
    platform: string,
    payload: unknown,
    actor: Principal,
    key: ApiKeyContext | undefined,
  ) {
    if (!(AD_PLATFORMS as readonly string[]).includes(platform)) {
      throw new AppError('NOT_FOUND', `ไม่รองรับ Lead Ads ของ ${platform}`);
    }
    const lead = adLead(platform as AdPlatform, payload);
    if (!lead) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ข้อมูลจากฟอร์มโฆษณาไม่มีรหัสฟอร์ม ชื่อ หรือช่องทางติดต่อ',
        [{ field: 'payload', reason: 'unreadable' }],
      );
    }
    const companyId = key?.companyId ?? actor.activeCompanyId;
    const campaign = (await this.campaigns.findFirst({
      where: { companyId, active: true, adFormIds: { has: lead.formId } },
      select: { code: true },
    })) as { code: string } | null;
    if (!campaign) {
      throw new AppError(
        'NOT_FOUND',
        `ฟอร์มโฆษณา ${lead.formId} ยังไม่ได้ผูกกับแคมเปญที่เปิดอยู่`,
        [{ field: 'form_id', reason: 'unmapped' }],
      );
    }
    const result = await this.receive(
      {
        name: lead.name,
        contact_name: lead.contactName ?? undefined,
        phone: lead.phone ?? undefined,
        email: lead.email ?? undefined,
        note: lead.note ?? undefined,
        campaign_code: campaign.code,
        source_code: key?.sourceCode?.trim() || `${platform}-lead-ads`,
      },
      { ...actor, activeCompanyId: companyId },
    );
    return { outcome: result.outcome, lead_id: result.lead.id };
  }

  // --- helpers ---------------------------------------------------------------

  private async campaignByCode(companyId: string, code: string) {
    return (await this.campaigns.findFirst({
      where: { companyId, code: code.trim().toUpperCase() },
    })) as CampaignRow | null;
  }

  private async campaignByToken(
    token: string,
    key: ApiKeyContext | undefined,
  ): Promise<CampaignRow> {
    const campaign = (await this.campaigns.findFirst({
      where: { formToken: token, formEnabled: true, active: true },
    })) as CampaignRow | null;
    // A key bound to one company never reaches another company's form.
    if (!campaign || (key?.companyId && key.companyId !== campaign.companyId)) {
      throw new AppError('NOT_FOUND', 'ไม่พบแบบฟอร์มนี้ หรือปิดรับแล้ว');
    }
    return campaign;
  }

  private async openLeadOf(companyId: string, dto: IntakeLeadDto, now: Date) {
    const wanted = { email: emailKey(dto.email), phone: phoneKey(dto.phone) };
    if (!wanted.email && !wanted.phone) return null;
    const open = (await this.statuses.listAll(companyId))
      .filter((row) => row.kind === 'open')
      .map((row) => row.code);
    const since = new Date(now.getTime() - REPEAT_WINDOW_DAYS * 86_400_000);
    const candidates = (await this.leads.findMany({
      where: {
        companyId,
        status: { in: open },
        convertedOpportunityId: null,
        createdAt: { gte: since },
        OR: [
          ...(wanted.email
            ? [
                {
                  email: { equals: wanted.email, mode: 'insensitive' as const },
                },
              ]
            : []),
          ...(wanted.phone
            ? [{ phone: { endsWith: wanted.phone.slice(-4) } }]
            : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: {
        ...LEAD_SELECT,
        email: true,
        phone: true,
        ownerOrgUnitId: true,
      },
      take: 50,
    })) as (CampaignLeadResult['lead'] & {
      email: string | null;
      phone: string | null;
      ownerOrgUnitId: string | null;
    })[];
    return candidates.find((row) => samePerson(wanted, row)) ?? null;
  }

  private async customerOf(companyId: string, dto: IntakeLeadDto) {
    const select = {
      id: true,
      accountOwnerUserId: true,
      ownerOrgUnitId: true,
    } as const;
    type Row = {
      id: string;
      accountOwnerUserId: string | null;
      ownerOrgUnitId: string | null;
    };
    const taxId = dto.tax_id?.replace(/\D/g, '');
    if (taxId && taxId.length === 13) {
      const byTax = (await this.customers.findFirst({
        where: { companyId, taxId },
        select,
      })) as Row | null;
      if (byTax) return byTax;
    }
    const wanted = { email: emailKey(dto.email), phone: phoneKey(dto.phone) };
    if (!wanted.email && !wanted.phone) return null;
    const contacts = (await this.contacts.findMany({
      where: {
        active: true,
        customer: { companyId },
        OR: [
          ...(wanted.email
            ? [
                {
                  email: { equals: wanted.email, mode: 'insensitive' as const },
                },
              ]
            : []),
          ...(wanted.phone
            ? [{ phone: { endsWith: wanted.phone.slice(-4) } }]
            : []),
        ],
      },
      select: { customerId: true, email: true, phone: true },
      take: 50,
    })) as { customerId: string; email: string | null; phone: string | null }[];
    const hit = contacts.find((row) => samePerson(wanted, row));
    if (!hit) return null;
    return (await this.customers.findFirst({
      where: { id: hit.customerId, companyId },
      select,
    })) as Row | null;
  }

  private async headOf(unitId: string | null, companyId: string) {
    if (!unitId) return null;
    const unit = (await this.orgUnits.findFirst({
      where: { id: unitId, companyId },
      select: { managerUserId: true },
    })) as { managerUserId: string | null } | null;
    return unit?.managerUserId ?? null;
  }

  private async read(id: string) {
    return (await this.leads.findFirst({
      where: { id },
      select: LEAD_SELECT,
    })) as CampaignLeadResult['lead'];
  }

  private async tell(
    userId: string,
    companyId: string,
    kind: 'routed' | 'customer' | 'repeat',
    lead: { id: string; name: string },
    campaign: string,
    source: string,
  ) {
    // A notice that cannot be sent never loses the Lead.
    await this.notifications
      .campaignLead(userId, companyId, {
        kind,
        leadId: lead.id,
        name: lead.name,
        campaign,
        source,
      })
      .catch((error: unknown) =>
        this.logger.warn(`campaign lead notice failed: ${String(error)}`),
      );
  }
}
