import { Injectable } from '@nestjs/common';
import { emailKey, phoneKey, samePerson } from './campaign-lead-rules';
import { seatFor } from './campaign-event-rules';
import { CampaignRegistrationRepository } from './sales.repositories';

export interface RegistrationInput {
  contactName: string;
  company: string | null;
  position: string | null;
  phone: string | null;
  email: string | null;
  need: string | null;
}

/**
 * CD-270 — writes one registration to an event. Shared by the public form
 * (through `CampaignLeadIntakeService`) and walk-ins on the day (through
 * `CampaignEventsService`), so both count seats and spot the same person the
 * same way. Its own class only because each of those two depends on the other
 * otherwise.
 */
@Injectable()
export class CampaignRegistrationWriter {
  constructor(private readonly registrations: CampaignRegistrationRepository) {}

  /**
   * A seat while there is one, else the waitlist. The same person (e-mail or
   * phone) registering again gets their registration back, not a second one.
   */
  async register(
    event: { id: string; companyId: string; eventCapacity: number | null },
    input: RegistrationInput,
    options: { walkIn?: boolean; actorId?: string | null; now?: Date } = {},
  ): Promise<{ id: string; status: string; repeat: boolean }> {
    const now = options.now ?? new Date();
    const wanted = {
      email: emailKey(input.email),
      phone: phoneKey(input.phone),
    };
    if (wanted.email || wanted.phone) {
      const rows = (await this.registrations.findMany({
        where: { campaignId: event.id, status: { not: 'cancelled' } },
        select: { id: true, status: true, email: true, phone: true },
      })) as {
        id: string;
        status: string;
        email: string | null;
        phone: string | null;
      }[];
      const same = rows.find((row) => samePerson(wanted, row));
      if (same) {
        if (options.walkIn) {
          // they registered and came — the walk-in is the check-in
          await this.registrations.update({
            where: { id: same.id },
            data: {
              status: 'registered',
              attendedAt: now,
              attendedBy: options.actorId ?? null,
              updatedBy: options.actorId ?? null,
            },
          });
          return { id: same.id, status: 'registered', repeat: true };
        }
        return { id: same.id, status: same.status, repeat: true };
      }
    }

    const seated = await this.registrations.count({
      where: { campaignId: event.id, status: 'registered' },
    });
    // a walk-in is already in the room: no seat question
    const status = options.walkIn
      ? 'registered'
      : seatFor(event.eventCapacity, seated);
    const row = (await this.registrations.create({
      data: {
        companyId: event.companyId,
        campaignId: event.id,
        contactName: input.contactName,
        company: input.company,
        position: input.position,
        phone: input.phone,
        email: input.email,
        need: input.need,
        consentAt: options.walkIn ? null : now,
        status,
        walkIn: options.walkIn ?? false,
        attendedAt: options.walkIn ? now : null,
        attendedBy: options.walkIn ? (options.actorId ?? null) : null,
        createdBy: options.actorId ?? null,
      },
      select: { id: true },
    })) as { id: string };
    return { id: row.id, status, repeat: false };
  }
}
