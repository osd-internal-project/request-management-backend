import { Injectable } from '@nestjs/common';
import { AppError, AuditWriter, auditActor } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CampaignLeadIntakeService } from './campaign-lead-intake.service';
import { convertible, eventCounts, leadNote } from './campaign-event-rules';
import { CampaignRegistrationWriter } from './campaign-registration.writer';
import {
  CampaignRegistrationRepository,
  CampaignRepository,
} from './sales.repositories';
import {
  ConvertRegistrationsDto,
  FollowRegistrationDto,
  RegistrationStatusDto,
  WalkInDto,
} from './dto/sales.dto';

interface EventRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  kind: string;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  eventVenue: string | null;
  eventOnlineUrl: string | null;
  eventCapacity: number | null;
}

interface RegistrationRow {
  id: string;
  companyId: string;
  campaignId: string;
  company: string | null;
  contactName: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  need: string | null;
  status: string;
  walkIn: boolean;
  attendedAt: Date | null;
  interest: string | null;
  followNote: string | null;
  leadId: string | null;
  leadOutcome: string | null;
  convertedAt: Date | null;
  createdAt: Date;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * CD-270 — an event's registrations after the form: the check-in list on the
 * day (search, tick, walk-ins), what each attendee said afterwards, and the
 * step that turns the interested ones into Leads through the CD-269 screening
 * (the same person again joins their open Lead; an existing customer goes to
 * its account owner; the rest to the campaign's team).
 *
 * Registrations carry phones and e-mails of people who are not customers yet,
 * so every route here is for campaign managers only.
 */
@Injectable()
export class CampaignEventsService {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly registrations: CampaignRegistrationRepository,
    private readonly writer: CampaignRegistrationWriter,
    private readonly intake: CampaignLeadIntakeService,
    private readonly audit: AuditWriter,
  ) {}

  async list(actor: Principal, campaignId: string) {
    const event = await this.requireEvent(actor, campaignId);
    const rows = (await this.registrations.findMany({
      where: { campaignId },
      orderBy: [{ createdAt: 'asc' }],
    })) as RegistrationRow[];
    return {
      event: {
        id: event.id,
        code: event.code,
        name: event.name,
        starts_at: iso(event.eventStartsAt),
        ends_at: iso(event.eventEndsAt),
        venue: event.eventVenue,
        online_url: event.eventOnlineUrl,
        capacity: event.eventCapacity,
      },
      counts: eventCounts(rows),
      registrations: rows.map((row) => ({
        id: row.id,
        contact_name: row.contactName,
        company: row.company,
        position: row.position,
        phone: row.phone,
        email: row.email,
        need: row.need,
        status: row.status,
        walk_in: row.walkIn,
        attended_at: iso(row.attendedAt),
        interest: row.interest,
        follow_note: row.followNote,
        lead_id: row.leadId,
        lead_outcome: row.leadOutcome,
        registered_at: row.createdAt.toISOString(),
        convertible: convertible(row),
      })),
    };
  }

  /** Someone at the door who never registered — already in the room. */
  async walkIn(actor: Principal, campaignId: string, dto: WalkInDto) {
    const event = await this.requireEvent(actor, campaignId);
    const result = await this.writer.register(
      event,
      {
        contactName: dto.contact_name.trim(),
        company: dto.company?.trim() || null,
        position: dto.position?.trim() || null,
        phone: dto.phone?.trim() || null,
        email: dto.email?.trim() || null,
        need: dto.need?.trim() || null,
      },
      { walkIn: true, actorId: actor.userId },
    );
    await this.audit.record({
      eventType: 'macom.event.walk_in',
      companyId: event.companyId,
      ...auditActor(actor),
      resourceType: 'campaign',
      resourceId: campaignId,
      after: { registrationId: result.id, matchedExisting: result.repeat },
    });
    return this.list(actor, campaignId);
  }

  async checkIn(actor: Principal, registrationId: string, attended: boolean) {
    const row = await this.requireRegistration(actor, registrationId);
    if (row.status === 'cancelled') {
      throw new AppError('CONFLICT', 'ผู้ลงทะเบียนรายนี้ถูกยกเลิกแล้ว');
    }
    if (!attended && row.leadId) {
      throw new AppError(
        'CONFLICT',
        'แปลงเป็น Lead แล้ว — ยกเลิกการเข้าร่วมไม่ได้',
      );
    }
    await this.registrations.update({
      where: { id: registrationId },
      data: {
        attendedAt: attended ? (row.attendedAt ?? new Date()) : null,
        attendedBy: attended ? actor.userId : null,
        // a waitlisted person who turns up has a seat after all
        ...(attended && row.status === 'waitlisted'
          ? { status: 'registered' }
          : {}),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: attended
        ? 'macom.event.checked_in'
        : 'macom.event.check_in_undone',
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'campaign',
      resourceId: row.campaignId,
      after: { registrationId },
    });
    return this.list(actor, row.campaignId);
  }

  /** Give a waitlisted person a seat, or cancel a registration. */
  async setStatus(
    actor: Principal,
    registrationId: string,
    dto: RegistrationStatusDto,
  ) {
    const row = await this.requireRegistration(actor, registrationId);
    if (dto.status === 'cancelled' && row.leadId) {
      throw new AppError('CONFLICT', 'แปลงเป็น Lead แล้ว — ยกเลิกไม่ได้');
    }
    await this.registrations.update({
      where: { id: registrationId },
      data: { status: dto.status, updatedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'macom.event.registration_status',
      companyId: row.companyId,
      ...auditActor(actor),
      resourceType: 'campaign',
      resourceId: row.campaignId,
      before: { registrationId, status: row.status },
      after: { status: dto.status },
    });
    return this.list(actor, row.campaignId);
  }

  /** What they said after the event. */
  async follow(
    actor: Principal,
    registrationId: string,
    dto: FollowRegistrationDto,
  ) {
    const row = await this.requireRegistration(actor, registrationId);
    await this.registrations.update({
      where: { id: registrationId },
      data: {
        ...(dto.interest !== undefined
          ? { interest: dto.interest || null }
          : {}),
        ...(dto.follow_note !== undefined
          ? { followNote: dto.follow_note.trim() || null }
          : {}),
        updatedBy: actor.userId,
      },
    });
    return this.list(actor, row.campaignId);
  }

  /**
   * Turn the interested attendees into Leads — all that qualify, or the ones
   * named. Each goes through the same screening as any outside Lead; one that
   * fails is reported and the rest still go.
   */
  async convert(
    actor: Principal,
    campaignId: string,
    dto: ConvertRegistrationsDto,
  ) {
    const event = await this.requireEvent(actor, campaignId);
    const rows = (
      (await this.registrations.findMany({
        where: {
          campaignId,
          ...(dto.registration_ids?.length
            ? { id: { in: dto.registration_ids } }
            : {}),
        },
      })) as RegistrationRow[]
    ).filter(convertible);
    const day = event.eventStartsAt?.toISOString().slice(0, 10) ?? null;
    const done: { id: string; outcome: string }[] = [];
    const failed: { id: string; reason: string }[] = [];
    for (const row of rows) {
      try {
        const result = await this.intake.receive(
          {
            name: row.company || row.contactName,
            contact_name: row.contactName,
            contact_position: row.position ?? undefined,
            phone: row.phone ?? undefined,
            email: row.email ?? undefined,
            note: leadNote({
              eventName: event.name,
              eventDay: day,
              walkIn: row.walkIn,
              need: row.need,
              followNote: row.followNote,
            }),
            campaign_code: event.code,
            source_code: 'event',
          },
          actor,
        );
        await this.registrations.update({
          where: { id: row.id },
          data: {
            leadId: result.lead.id,
            leadOutcome: result.outcome,
            convertedAt: new Date(),
            convertedBy: actor.userId,
            updatedBy: actor.userId,
          },
        });
        done.push({ id: row.id, outcome: result.outcome });
      } catch (error) {
        failed.push({
          id: row.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.audit.record({
      eventType: 'macom.event.converted',
      companyId: event.companyId,
      ...auditActor(actor),
      resourceType: 'campaign',
      resourceId: campaignId,
      after: { converted: done.length, failed: failed.length },
    });
    return {
      converted: done.length,
      created: done.filter((row) => row.outcome === 'created').length,
      customer: done.filter((row) => row.outcome === 'customer').length,
      repeat: done.filter((row) => row.outcome === 'repeat').length,
      failed,
      view: await this.list(actor, campaignId),
    };
  }

  private async requireEvent(
    actor: Principal,
    campaignId: string,
  ): Promise<EventRow> {
    const event = (await this.campaigns.findFirst({
      where: { id: campaignId, companyId: actor.activeCompanyId },
    })) as EventRow | null;
    // SCOPE-03: another company's campaign answers 404.
    if (!event) throw new AppError('NOT_FOUND', 'ไม่พบแคมเปญนี้');
    if (event.kind !== 'event') {
      throw new AppError('CONFLICT', 'แคมเปญนี้ไม่ใช่อีเวนต์');
    }
    return event;
  }

  private async requireRegistration(
    actor: Principal,
    registrationId: string,
  ): Promise<RegistrationRow> {
    const row = (await this.registrations.findFirst({
      where: { id: registrationId, companyId: actor.activeCompanyId },
    })) as RegistrationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบผู้ลงทะเบียนรายนี้');
    return row;
  }
}
