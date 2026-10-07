/**
 * CD-291 — when and whether the AI may call one number, decided without a
 * database. Every call passes `checkBeforeCall`; the reason it gives is what
 * the call list shows when a target is held back.
 */

/** One calling window on one weekday (1 = Monday … 7 = Sunday), Bangkok time. */
export interface CallWindow {
  day: number;
  from: string;
  to: string;
}

/** Mon–Fri 9:00–18:00, Sat 9:00–12:00 — the policy a company starts with. */
export const DEFAULT_WINDOWS: CallWindow[] = [
  ...[1, 2, 3, 4, 5].map((day) => ({ day, from: '09:00', to: '18:00' })),
  { day: 6, from: '09:00', to: '12:00' },
];
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MIN_GAP_DAYS = 3;
export const DEFAULT_OPENING =
  'สวัสดีค่ะ ดิฉันเป็นผู้ช่วยอัตโนมัติ (AI) โทรจาก {company} ' +
  'เพื่อแนะนำบริการที่อาจเป็นประโยชน์กับธุรกิจของท่าน ใช้เวลาไม่เกิน 2 นาที';
export const DEFAULT_OPT_OUT =
  'หากไม่ต้องการให้ติดต่ออีก กรุณาพูดว่า "ไม่ต้องติดต่ออีก" ' +
  'ระบบจะไม่โทรหาท่านอีกและวางสายทันที';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Why a set of windows cannot be saved, or null. */
export function windowsProblem(windows: CallWindow[]): string | null {
  if (!windows.length) return 'ต้องมีช่วงเวลาที่โทรได้อย่างน้อยหนึ่งช่วง';
  for (const window of windows) {
    if (!Number.isInteger(window.day) || window.day < 1 || window.day > 7) {
      return 'วันต้องเป็น 1 (จันทร์) ถึง 7 (อาทิตย์)';
    }
    if (!TIME.test(window.from) || !TIME.test(window.to)) {
      return 'เวลาต้องเป็นรูปแบบ HH:MM';
    }
    if (window.from >= window.to) return 'เวลาเริ่มต้องก่อนเวลาสิ้นสุด';
  }
  return null;
}

/** Bangkok's weekday (1–7), HH:MM and YYYY-MM-DD for `now`. */
export function bangkokClock(now: Date) {
  const local = new Date(now.getTime() + 7 * 3_600_000);
  const weekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  const iso = local.toISOString();
  return { weekday, time: iso.slice(11, 16), date: iso.slice(0, 10) };
}

export function inWindow(
  windows: CallWindow[],
  holidays: string[],
  now: Date,
): boolean {
  const clock = bangkokClock(now);
  if (holidays.includes(clock.date)) return false;
  return windows.some(
    (window) =>
      window.day === clock.weekday &&
      clock.time >= window.from &&
      clock.time < window.to,
  );
}

export type HoldReason =
  | 'policy_uncertified'
  | 'list_not_active'
  | 'do_not_contact'
  | 'no_phone'
  | 'outside_window'
  | 'attempts_used'
  | 'too_soon'
  | 'finished';

export const HOLD_LABELS: Record<HoldReason, string> = {
  policy_uncertified: 'นโยบายการโทรยังไม่ได้รับรองจากฝ่ายกฎหมาย',
  list_not_active: 'รายการโทรยังไม่เปิดใช้งาน',
  do_not_contact: 'อยู่ในทะเบียนห้ามติดต่อ',
  no_phone: 'ไม่มีเบอร์โทรที่ใช้ได้',
  outside_window: 'อยู่นอกช่วงเวลาที่โทรได้',
  attempts_used: 'โทรครบจำนวนครั้งแล้ว',
  too_soon: 'ยังไม่ครบระยะห่างจากครั้งก่อน',
  finished: 'จบรายการนี้แล้ว',
};

/**
 * Whether this target may be called now. The checks run in the order a
 * person would want to read them: the company's certification first, the
 * person's refusal before anything about timing.
 */
export function checkBeforeCall(input: {
  policyCertified: boolean;
  listStatus: string;
  targetStatus: string;
  phone: string | null;
  blocked: boolean;
  attempts: number;
  lastAttemptAt: Date | null;
  maxAttempts: number;
  minGapDays: number;
  inWindow: boolean;
  now: Date;
}): HoldReason | null {
  if (!input.policyCertified) return 'policy_uncertified';
  if (input.listStatus !== 'active') return 'list_not_active';
  if (input.targetStatus === 'blocked') return 'do_not_contact';
  if (input.targetStatus !== 'pending') return 'finished';
  if (!input.phone) return 'no_phone';
  if (input.blocked) return 'do_not_contact';
  if (input.attempts >= input.maxAttempts) return 'attempts_used';
  if (
    input.lastAttemptAt &&
    input.now.getTime() - input.lastAttemptAt.getTime() <
      input.minGapDays * 86_400_000
  ) {
    return 'too_soon';
  }
  if (!input.inWindow) return 'outside_window';
  return null;
}

/** The opening as said: the policy's text with the company's name put in. */
export function openingFor(
  policy: { openingScript: string; optOutScript: string },
  companyName: string,
): string {
  return `${policy.openingScript.split('{company}').join(companyName)} ${policy.optOutScript}`;
}
