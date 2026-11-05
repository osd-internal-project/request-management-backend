/**
 * งานขายอัตโนมัติ (5 พ.ย. 2569) — the rules apart from the mailbox and the
 * database: what a customer's reply means, how a plain message becomes the
 * HTML the mailbox sends, and what is kept of it.
 */

/**
 * What a reply asks the sales flow to do next. The workflow branches on these
 * codes (a trigger filters on them), so they are a contract.
 */
export const EMAIL_INTENTS = [
  /** wants to go ahead / asks for a price — open the deal and quote */
  'interested',
  /** has questions first — the salesperson answers */
  'needs_info',
  'not_interested',
  /** confirms the quotation */
  'confirmed',
  /** sends or states a purchase order */
  'purchase_order',
  /** none of the above with any confidence — a person reads it */
  'unclear',
] as const;
export type EmailIntent = (typeof EMAIL_INTENTS)[number];

export const EMAIL_INTENT_LABELS: Record<EmailIntent, string> = {
  interested: 'สนใจ',
  needs_info: 'ขอข้อมูลเพิ่ม',
  not_interested: 'ไม่สนใจ',
  confirmed: 'ยืนยันใบเสนอราคา',
  purchase_order: 'ส่ง PO',
  unclear: 'ไม่ชัดเจน',
};

export const isEmailIntent = (value: unknown): value is EmailIntent =>
  typeof value === 'string' &&
  (EMAIL_INTENTS as readonly string[]).includes(value);

/** Kept of a message's text — enough to read it, not an archive. */
export const MAX_BODY_CHARS = 20_000;
/** What the classifier is shown. */
const MAX_PROMPT_CHARS = 4_000;

export interface IntentInput {
  readonly subject: string;
  readonly text: string;
  readonly attachmentNames: readonly string[];
  /** A quotation has been sent in this thread — confirming is possible. */
  readonly quotationSent: boolean;
}

export interface IntentResult {
  readonly intent: EmailIntent;
  readonly reason: string;
}

const PO_FILE = /(^|[^a-z])(po|purchase[\s_-]?order)([^a-z]|$)|ใบสั่งซื้อ/i;
const PO_TEXT =
  /(ใบสั่งซื้อ|purchase\s*order|เลขที่\s*po|po\s*(no|number|#|เลขที่)|แนบ\s*po|ออก\s*po)/i;
const CONFIRM =
  /(ยืนยัน|ตกลง(สั่ง|ซื้อ|ตาม)|อนุมัติ(ใบเสนอราคา|ราคา)|รับข้อเสนอ|accept|approved?|confirm|go ahead)/i;
const NOT_INTERESTED =
  /(ไม่สนใจ|ยังไม่สนใจ|ไม่ต้องการ|ขอยกเลิก|ไม่ต้องส่ง|unsubscribe|not interested|no longer)/i;
const NEEDS_INFO =
  /(สอบถาม|ขอข้อมูล|ขอรายละเอียด|รายละเอียดเพิ่ม|\?|อย่างไร|ไหม|มั้ย|หรือเปล่า|question|more (info|details))/i;
const INTERESTED =
  /(สนใจ|ขอใบเสนอราคา|ขอราคา|เสนอราคา|ส่งราคา|อยากได้|ต้องการ|interested|quotation|quote|pricing)/i;

/**
 * The keyword fallback — used when the LLM is a mock, fails or answers
 * nonsense. Order matters: a PO beats a confirmation beats a refusal.
 */
export function intentByRules(input: IntentInput): IntentResult {
  // the subject is usually ours ("ขอบคุณที่สนใจ…") — only what they wrote counts
  const text = input.text;
  if (input.attachmentNames.some((name) => PO_FILE.test(name))) {
    return { intent: 'purchase_order', reason: 'แนบไฟล์ที่ชื่อเป็น PO' };
  }
  if (PO_TEXT.test(text)) {
    return { intent: 'purchase_order', reason: 'ข้อความกล่าวถึง PO' };
  }
  if (NOT_INTERESTED.test(text)) {
    return { intent: 'not_interested', reason: 'ข้อความปฏิเสธ' };
  }
  if (input.quotationSent && CONFIRM.test(text)) {
    return { intent: 'confirmed', reason: 'ข้อความยืนยันหลังได้ใบเสนอราคา' };
  }
  if (INTERESTED.test(text)) {
    return { intent: 'interested', reason: 'ข้อความแสดงความสนใจ' };
  }
  if (NEEDS_INFO.test(text)) {
    return { intent: 'needs_info', reason: 'ข้อความเป็นคำถาม' };
  }
  return { intent: 'unclear', reason: 'ไม่พบสัญญาณที่ชัดเจน' };
}

/** The classifier's instructions — answers one JSON object, nothing else. */
export function intentPrompt(input: IntentInput): {
  system: string;
  user: string;
} {
  return {
    system: [
      'You classify a customer reply to a B2B sales email from a Thai IT company.',
      'Answer with ONE JSON object only: {"intent": "...", "reason": "..."}.',
      'intent is exactly one of:',
      '- interested: wants to proceed, asks for a quotation or price',
      '- needs_info: asks questions or wants more details before deciding',
      '- not_interested: declines or asks to stop',
      input.quotationSent
        ? '- confirmed: accepts / confirms the quotation already sent'
        : '- confirmed: (not possible yet — no quotation was sent)',
      '- purchase_order: sends or states a purchase order (PO)',
      '- unclear: auto-replies, out-of-office, or anything else',
      'reason: one short sentence in Thai.',
    ].join('\n'),
    user: [
      `Subject: ${input.subject}`,
      `Attachments: ${input.attachmentNames.join(', ') || '-'}`,
      '',
      input.text.slice(0, MAX_PROMPT_CHARS),
    ].join('\n'),
  };
}

/** The LLM's answer, or null when it is not the JSON asked for. */
export function parseIntent(
  answer: string,
  quotationSent: boolean,
): IntentResult | null {
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as {
      intent?: unknown;
      reason?: unknown;
    };
    if (!isEmailIntent(parsed.intent)) return null;
    // nothing to confirm yet: the model misread it
    if (parsed.intent === 'confirmed' && !quotationSent) return null;
    return {
      intent: parsed.intent,
      reason:
        typeof parsed.reason === 'string'
          ? parsed.reason.slice(0, 500)
          : EMAIL_INTENT_LABELS[parsed.intent],
    };
  } catch {
    return null;
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ESCAPES[char]);

/**
 * The caller writes plain text (the workflow, an AI agent); the mailbox gets
 * HTML. Escaped, so nothing the caller sends becomes markup.
 */
export function textToHtml(text: string, signature?: string | null): string {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`);
  const sign = signature?.trim()
    ? `<p style="color:#555">${escapeHtml(signature.trim()).replace(/\n/g, '<br>')}</p>`
    : '';
  return `<div style="font-family:Tahoma,Arial,sans-serif;font-size:14px">${paragraphs.join('')}${sign}</div>`;
}

/** `RE: …` once, however many times the thread went round. */
export function replySubject(subject: string): string {
  const bare = subject.replace(/^((re|fw|fwd|ตอบกลับ)\s*:\s*)+/i, '').trim();
  return `RE: ${bare}`;
}

export const normalizeAddress = (value: string) => value.trim().toLowerCase();

/** A rough check — the mailbox is the real judge. */
export const looksLikeEmail = (value: string | null | undefined) =>
  !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/** A file name that is safe in a mail client and a file system. */
export const safeFileName = (value: string) =>
  value.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '-').slice(0, 120);
