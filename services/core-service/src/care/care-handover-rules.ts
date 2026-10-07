import type { SeverityWords } from './care-case-rules';
import { severityOf } from './care-case-rules';

/**
 * CD-283 (CD-23 AI CARE) — when a conversation goes to a person at once:
 * the customer asks for one, the matter is severe, the customer sounds
 * unhappy, or AI CARE has not been able to answer several times in a row.
 */

export type HandoverReason =
  'asked' | 'severe' | 'displeased' | 'unanswered' | 'channel' | 'staff';

export const DEFAULT_ASK_WORDS = [
  'ขอคุยกับคน',
  'คุยกับคน',
  'คุยกับเจ้าหน้าที่',
  'ขอเจ้าหน้าที่',
  'ติดต่อเจ้าหน้าที่',
  'ขอสายเจ้าหน้าที่',
  'ให้เจ้าหน้าที่โทร',
  'โทรกลับ',
  'แอดมิน',
  'admin',
  'human',
  'agent',
];

export const DEFAULT_DISPLEASED_WORDS = [
  'ไม่พอใจ',
  'แย่มาก',
  'ห่วย',
  'ร้องเรียน',
  'ยกเลิกบริการ',
  'ยกเลิกสัญญา',
  'โกรธ',
  'ผิดหวัง',
  'รอนานมาก',
  'ไม่ไหวแล้ว',
  'เสียเวลา',
  'ไม่ได้เรื่อง',
];

/** Questions in a row AI CARE could not answer before a person takes over. */
export const DEFAULT_UNANSWERED_LIMIT = 2;
/** Minutes a handed-over conversation waits before the team is told again. */
export const DEFAULT_REMIND_MINUTES = 30;

export interface HandoverWords {
  ask: string[];
  displeased: string[];
  severity: SeverityWords;
}

/**
 * Why this message hands the conversation to a person now, if it does —
 * a request for one first, then a severe matter, then displeasure.
 */
export function handoverReason(
  text: string | null | undefined,
  words: HandoverWords,
): 'asked' | 'severe' | 'displeased' | null {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return null;
  if (words.ask.some((w) => t.includes(w))) return 'asked';
  if (severityOf([t], words.severity) === 'critical') return 'severe';
  if (words.displeased.some((w) => t.includes(w)) || /[!！]{3,}/.test(t))
    return 'displeased';
  return null;
}

/** Whether a run of unanswered questions has reached the limit. */
export function tooManyUnanswered(streak: number, limit: number): boolean {
  return limit > 0 && streak >= limit;
}

/** Whether the team should be told again about a conversation still waiting. */
export function remindDue(
  notifiedAt: Date | null,
  now: Date,
  minutes: number,
): boolean {
  return (
    minutes > 0 &&
    !!notifiedAt &&
    now.getTime() - notifiedAt.getTime() >= minutes * 60_000
  );
}

/** What the customer is told once, as the conversation goes to a person. */
export function handoverNotice(when: {
  outOfHours: boolean;
  onCall: boolean;
}): string {
  if (!when.outOfHours)
    return 'ส่งเรื่องให้เจ้าหน้าที่แล้ว เจ้าหน้าที่จะตอบกลับในแชตนี้โดยเร็ว';
  return when.onCall
    ? 'ตอนนี้นอกเวลาทำการ ส่งเรื่องให้เจ้าหน้าที่เวรแล้ว จะติดต่อกลับโดยเร็ว'
    : 'ตอนนี้นอกเวลาทำการ ส่งเรื่องให้เจ้าหน้าที่แล้ว จะติดต่อกลับในเวลาทำการถัดไป';
}

export const HANDOVER_REASON_TH: Record<HandoverReason, string> = {
  asked: 'ลูกค้าขอคุยกับเจ้าหน้าที่',
  severe: 'เหตุรุนแรง',
  displeased: 'ลูกค้าไม่พอใจ',
  unanswered: 'AI ตอบไม่ได้ซ้ำ',
  channel: 'ลูกค้ากดขอคุยกับเจ้าหน้าที่',
  staff: 'เจ้าหน้าที่รับเรื่องเอง',
};
