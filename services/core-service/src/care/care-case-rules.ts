import { questionTerms } from '../kb/kb-rules';

/**
 * CD-282 (CD-23 AI CARE) — a service case from a conversation: when the
 * customer's reply means "yes, open it", how serious it sounds, and what the
 * service team reads on the case.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';

/** Words that raise or lower a case's severity; the rest is medium. */
export interface SeverityWords {
  critical: string[];
  high: string[];
  low: string[];
}

export const DEFAULT_SEVERITY_WORDS: SeverityWords = {
  critical: [
    'ใช้งานไม่ได้ทั้งหมด',
    'ล่มทั้งหมด',
    'ระบบล่ม',
    'ทั้งบริษัท',
    'ทั้งสาขา',
    'ทุกเครื่อง',
    'ฉุกเฉิน',
    'ไฟไหม้',
  ],
  high: [
    'ใช้งานไม่ได้',
    'ใช้ไม่ได้',
    'โทรออกไม่ได้',
    'โทรเข้าไม่ได้',
    'เน็ตไม่ได้',
    'อินเทอร์เน็ตไม่ได้',
    'ล่ม',
    'ดับ',
    'เสีย',
  ],
  low: ['สอบถาม', 'ขอข้อมูล', 'ขอคู่มือ', 'อยากทราบ', 'แนะนำ', 'ขอเพิ่ม'],
};

/** A word list from the environment ("a,b,c"), else the standard one. */
export function wordsFrom(env: string | undefined, fallback: string[]) {
  const words = (env ?? '')
    .split(',')
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  return words.length ? words : fallback;
}

/** The most serious level any of the customer's messages calls for. */
export function severityOf(
  texts: (string | null)[],
  words: SeverityWords = DEFAULT_SEVERITY_WORDS,
): Severity {
  const all = texts.filter(Boolean).join('\n').toLowerCase();
  if (words.critical.some((w) => all.includes(w))) return 'critical';
  if (words.high.some((w) => all.includes(w))) return 'high';
  if (words.low.some((w) => all.includes(w))) return 'low';
  return 'medium';
}

const YES =
  /^(เปิดเรื่อง|เปิดเคส|แจ้งซ่อม|ตกลง|ได้เลย|ได้ครับ|ได้ค่ะ|ได้คะ|ได้|ใช่|ใช่ครับ|ใช่ค่ะ|โอเค|ok|okay|yes|เอา|เอาครับ|เอาค่ะ|รบกวนด้วย|ขอเปิด|ขอแจ้ง|เปิดเลย|ช่วยเปิด)/i;

/**
 * A short reply that accepts the offer to open a case — "เปิดเรื่องเลยครับ",
 * "ตกลง", "ok". A longer message is a new question, and any "no" wins.
 */
export function acceptsCase(text: string | null | undefined): boolean {
  const t = (text ?? '').trim().replace(/[!.~ๆ\s]+$/u, '');
  if (!t || t.length > 40) return false;
  if (/ไม่|ไหม|มั้ย|\?|no\b|ยังก่อน/i.test(t)) return false;
  return YES.test(t.replace(/\s+/g, ''));
}

export interface CaseMessage {
  direction: string;
  author: string;
  text: string | null;
}

/** The case's subject: the customer's first message that says something. */
export function caseSubject(messages: CaseMessage[]): string {
  const first = messages.find(
    (m) => m.direction === 'in' && m.text && questionTerms(m.text).length > 0,
  );
  const text = (first?.text ?? 'แจ้งผ่าน AI CARE').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

const AUTHOR: Record<string, string> = {
  customer: 'ลูกค้า',
  ai: 'AI CARE',
  agent: 'เจ้าหน้าที่',
  system: 'ระบบ',
};

/** What the service team reads: where it came from, a summary, the conversation. */
export function caseDetail(input: {
  channel: string;
  sender: string;
  summary: string | null;
  messages: CaseMessage[];
}): string {
  const lines = input.messages
    .filter((m) => m.text)
    .map((m) => `${AUTHOR[m.author] ?? m.author}: ${m.text!.trim()}`);
  let transcript = lines.join('\n');
  if (transcript.length > 3500) transcript = `…\n${transcript.slice(-3500)}`;
  return [
    `แจ้งผ่าน AI CARE · ช่องทาง ${input.channel} · ผู้ส่ง ${input.sender}`,
    input.summary ? `สรุป: ${input.summary.trim()}` : null,
    `บทสนทนา:\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const CASE_FAILED_TEXT =
  'ขออภัย ยังเปิดเรื่องอัตโนมัติไม่ได้ในขณะนี้ — แจ้งได้เลยว่าต้องการคุยกับเจ้าหน้าที่';

const SEVERITY_TH: Record<Severity, string> = {
  critical: 'วิกฤต',
  high: 'สูง',
  medium: 'ปานกลาง',
  low: 'ต่ำ',
};

/** What the customer is told once the case is open. */
export function caseNotice(input: {
  requestNo: string | null;
  severity: Severity;
  statusLink: string | null;
}): string {
  return [
    `เปิดเรื่องให้ทีมบริการแล้ว${input.requestNo ? ` เลขที่ ${input.requestNo}` : ''} (ความเร่งด่วน: ${SEVERITY_TH[input.severity]})`,
    'ทีมบริการจะติดต่อกลับโดยเร็ว',
    input.statusLink ? `ติดตามสถานะได้ที่ ${input.statusLink}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}
