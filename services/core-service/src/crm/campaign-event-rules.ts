/**
 * CD-270 — an event's registrations: who gets a seat, who waits, and what an
 * interested attendee's Lead says about where it came from. Pure.
 */

export const CAMPAIGN_KINDS = ['campaign', 'event'] as const;
export const REGISTRATION_STATUSES = [
  'registered',
  'waitlisted',
  'cancelled',
] as const;
export const INTERESTS = ['interested', 'later', 'not_interested'] as const;
export type Interest = (typeof INTERESTS)[number];

/** A new registration takes a seat while there is one, else waits. */
export function seatFor(
  capacity: number | null,
  seated: number,
): 'registered' | 'waitlisted' {
  return capacity === null || seated < capacity ? 'registered' : 'waitlisted';
}

/** What the event form may still take: closed once the event has ended. */
export function eventOpen(endsAt: Date | null, now: Date): boolean {
  return endsAt === null || endsAt.getTime() > now.getTime();
}

export interface RegistrationFacts {
  status: string;
  attendedAt: Date | null;
  interest: string | null;
  leadId: string | null;
}

/** Turned into a Lead only when they came, said they are interested, and are not yet a Lead. */
export function convertible(row: RegistrationFacts): boolean {
  return (
    row.status !== 'cancelled' &&
    row.attendedAt !== null &&
    row.interest === 'interested' &&
    row.leadId === null
  );
}

export interface EventCounts {
  registered: number;
  waitlisted: number;
  cancelled: number;
  attended: number;
  walkIns: number;
  interested: number;
  converted: number;
}

export function eventCounts(
  rows: readonly (RegistrationFacts & { walkIn: boolean })[],
): EventCounts {
  return {
    registered: rows.filter((row) => row.status === 'registered').length,
    waitlisted: rows.filter((row) => row.status === 'waitlisted').length,
    cancelled: rows.filter((row) => row.status === 'cancelled').length,
    attended: rows.filter((row) => row.attendedAt !== null).length,
    walkIns: rows.filter((row) => row.walkIn).length,
    interested: rows.filter((row) => row.interest === 'interested').length,
    converted: rows.filter((row) => row.leadId !== null).length,
  };
}

/** The note on the Lead: the event, the day, and what they said they need. */
export function leadNote(input: {
  eventName: string;
  eventDay: string | null;
  walkIn: boolean;
  need: string | null;
  followNote: string | null;
}): string {
  return [
    `เข้าร่วม ${input.eventName}${input.eventDay ? ` (${input.eventDay})` : ''}${input.walkIn ? ' · walk-in' : ''}`,
    input.need && `ความต้องการ: ${input.need}`,
    input.followNote && `หมายเหตุหลังงาน: ${input.followNote}`,
  ]
    .filter(Boolean)
    .join('\n');
}
