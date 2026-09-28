import { localDay, type WorkingCalendar } from '../sla/business-hours';

/**
 * CD-52 — what a person chooses per kind of notification. The event types
 * are the ones `NotificationsService` emits; anything new lands in `other`
 * until it is given a category, and `other` is always immediate.
 */
export const NOTIFICATION_CATEGORIES = [
  /** รายการรออนุมัติจากฉัน — the approver's flood the ticket is about. */
  'approval',
  /** ผลการอนุมัติคำขอของฉัน. */
  'my_requests',
  /** เตือนงานขาย เช่น ดีลเงียบ. */
  'crm',
  /** เกินกำหนด / เลยเวลาตอบกลับ — urgent, never batched. */
  'sla',
] as const;

export type NotificationCategory =
  (typeof NOTIFICATION_CATEGORIES)[number] | 'other';

export type NotificationFrequency = 'immediate' | 'daily';

export interface CategorySetting {
  email: boolean;
  frequency: NotificationFrequency;
}

/** A late request is only useful to hear about while it can still be acted on. */
export const DIGESTIBLE: ReadonlySet<NotificationCategory> = new Set([
  'approval',
  'my_requests',
  'crm',
]);

export const DEFAULT_DIGEST_HOUR = 8;

export function categoryOf(eventType: string): NotificationCategory {
  // Overdue approvals are SLA warnings: never held for a digest.
  if (eventType === 'approval.overdue' || eventType === 'approval.escalated') {
    return 'sla';
  }
  if (eventType === 'approval.awaiting' || eventType === 'approval.withdrawn') {
    return 'approval';
  }
  if (eventType.startsWith('approval.')) return 'my_requests';
  if (eventType.startsWith('sla.')) return 'sla';
  if (eventType.startsWith('crm.')) return 'crm';
  return 'other';
}

/**
 * The stored JSON read defensively: an unknown key, a non-digestible
 * category marked daily, or a malformed entry all fall back to the default
 * (email on, immediate) rather than holding something that must not wait.
 */
export function settingOf(
  stored: unknown,
  category: NotificationCategory,
): CategorySetting {
  const entry =
    stored && typeof stored === 'object'
      ? ((stored as Record<string, unknown>)[category] as
          Record<string, unknown> | undefined)
      : undefined;
  return {
    email: entry?.email !== false,
    frequency:
      entry?.frequency === 'daily' && DIGESTIBLE.has(category)
        ? 'daily'
        : 'immediate',
  };
}

/**
 * Whether a person's digest is due now: a working day in the company's
 * calendar, at or after their hour, and not already sent today. Weekends and
 * holidays skip — what was held goes out on the next working day.
 */
export function digestDue(
  now: Date,
  digestHour: number,
  lastDigestDate: string | null,
  calendar: WorkingCalendar,
): { due: boolean; date: string } {
  const day = localDay(now, calendar);
  return {
    date: day.date,
    due:
      day.workingDay &&
      day.minuteOfDay >= digestHour * 60 &&
      lastDigestDate !== day.date,
  };
}
