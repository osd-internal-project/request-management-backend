/**
 * งานขายอัตโนมัติ — requirement ก่อนออกใบเสนอราคา (13 พ.ย. 2569, ผู้ใช้ตัดสิน).
 *
 * A customer who answers "interested" is not quoted at once any more. What
 * they wrote is read for the product, how many, and the answers to the
 * product's own questions (`product_bundles.requirements`):
 *
 * - something still unknown → an email asks for exactly that (`ask`);
 * - all known and the product has priced items → quote (`ready`);
 * - the product has nothing to quote from in the system → the salesperson
 *   asks Pricing for a price or Pre-Sales for a solution (`no_solution`);
 * - asked twice and still incomplete → the salesperson takes over (`handover`).
 *
 * Pure: no mailbox, no database — tested on its own.
 */
import {
  QUANTITY_KEY,
  bundleKey,
  type BundleRequirement,
  type LeadRequirements,
} from '../crm/product-bundle-rules';

export const REQUIREMENT_OUTCOMES = [
  'ready',
  'ask',
  'no_solution',
  'handover',
] as const;
export type RequirementOutcome = (typeof REQUIREMENT_OUTCOMES)[number];

/** Emails asking for requirements one Lead gets before a person steps in. */
export const MAX_REQUIREMENT_ASKS = 2;
/** The key of the built-in question "which product". */
export const PRODUCT_KEY = 'product';

const MAX_ANSWER_CHARS = 500;
const MAX_PROMPT_CHARS = 4_000;

export interface MissingRequirement {
  key: string;
  question: string;
}

/** What one reply says, before it is merged with what was known. */
export interface Extracted {
  product: string | null;
  quantity: number | null;
  answers: Record<string, string>;
}

const UNIT =
  '(?:เครื่อง|ชุด|ตัว|ชิ้น|จุด|คน|ท่าน|ผู้ใช้(?:งาน)?|เลขหมาย|คู่สาย|ไลเซนส์|ที่นั่ง|สาขา|users?|licen[sc]es?|seats?|units?|pcs|sets?|agents?|extensions?)';
const QUANTITY_PATTERNS = [
  new RegExp(`จำนวน\\s*[:：]?\\s*(\\d[\\d,]*)`, 'i'),
  new RegExp(`(\\d[\\d,]*)\\s*${UNIT}`, 'i'),
  /(?:qty|quantity)\s*[:：]?\s*(\d[\d,]*)/i,
];

export function quantityIn(text: string): number | null {
  for (const pattern of QUANTITY_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ''));
    if (Number.isFinite(value) && value > 0 && value <= 1_000_000) return value;
  }
  return null;
}

/** The longest known product name the text mentions, else null. */
export function productIn(
  text: string,
  names: readonly string[],
): string | null {
  const haystack = bundleKey(text);
  return (
    [...names]
      .sort((a, b) => b.length - a.length)
      .find((name) => bundleKey(name) && haystack.includes(bundleKey(name))) ??
    null
  );
}

/**
 * The keyword reading — used when the LLM is a mock or answers nonsense.
 * A question counts as answered when one of its hints appears (the line that
 * carries it is kept as the answer). When the customer is answering our own
 * requirement email and a question has no hints to go by, their whole message
 * is taken as its answer: a person reads it on the quotation, and the
 * customer is not asked the same thing twice.
 */
export function extractByRules(input: {
  text: string;
  productNames: readonly string[];
  questions: readonly BundleRequirement[];
  answeringAsk: boolean;
}): Extracted {
  const text = input.text.trim();
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const answers: Record<string, string> = {};
  for (const question of input.questions) {
    const line = lines.find((candidate) => {
      const lower = candidate.toLowerCase();
      return question.hints.some((hint) => lower.includes(hint));
    });
    if (line) answers[question.key] = line.slice(0, MAX_ANSWER_CHARS);
    else if (input.answeringAsk && !question.hints.length && text) {
      answers[question.key] = text.slice(0, MAX_ANSWER_CHARS);
    }
  }
  return {
    product: productIn(text, input.productNames),
    quantity: quantityIn(text),
    answers,
  };
}

/** The reader's instructions — answers one JSON object, nothing else. */
export function requirementPrompt(input: {
  text: string;
  productNames: readonly string[];
  questions: readonly BundleRequirement[];
}): { system: string; user: string } {
  return {
    system: [
      'You read a customer reply to a B2B sales email from a Thai IT company and extract what they ask for.',
      'Answer with ONE JSON object only: {"product": ..., "quantity": ..., "answers": {...}}.',
      `product: exactly one of ${JSON.stringify(input.productNames)} when the customer names it (or an obvious spelling of it); otherwise the product name as the customer wrote it; null when none is named.`,
      'quantity: the number of units/users/licences asked for, as a number; null when not stated.',
      "answers: for each key below, the customer's answer copied or summarised in Thai (max 200 characters), or null when the reply does not answer it. Never guess.",
      ...input.questions.map((q) => `- ${q.key}: ${q.question}`),
    ].join('\n'),
    user: input.text.slice(0, MAX_PROMPT_CHARS),
  };
}

/** The LLM's answer, or null when it is not the JSON asked for. */
export function parseRequirementAnswer(
  answer: string,
  questions: readonly BundleRequirement[],
): Extracted | null {
  const match = answer.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const quantity = Number(parsed.quantity);
    const given =
      parsed.answers && typeof parsed.answers === 'object'
        ? (parsed.answers as Record<string, unknown>)
        : {};
    const answers: Record<string, string> = {};
    for (const question of questions) {
      const value = given[question.key];
      if (typeof value === 'string' && value.trim()) {
        answers[question.key] = value.trim().slice(0, MAX_ANSWER_CHARS);
      }
    }
    return {
      product:
        typeof parsed.product === 'string' && parsed.product.trim()
          ? parsed.product.trim().slice(0, 120)
          : null,
      quantity:
        parsed.quantity !== null &&
        Number.isFinite(quantity) &&
        quantity > 0 &&
        quantity <= 1_000_000
          ? quantity
          : null,
      answers,
    };
  } catch {
    return null;
  }
}

/** What was known plus what this reply adds — a newer answer replaces an older one. */
export function mergeRequirements(
  known: LeadRequirements,
  found: Extracted,
): LeadRequirements {
  return {
    product: found.product ?? known.product,
    quantity: found.quantity ?? known.quantity,
    answers: { ...known.answers, ...found.answers },
  };
}

export interface Decision {
  outcome: RequirementOutcome;
  missing: MissingRequirement[];
  reason: string;
}

/**
 * - `product`: the product the Lead is about (picked by the salesperson, or
 *   named by the customer) — null when nobody said;
 * - `hasItems` / `unpriced`: what `itemsForLead` + the price list say;
 * - `quantityKnown`: the Lead's own item list already carries quantities, or
 *   the customer stated one.
 */
export function decide(input: {
  product: string | null;
  productNames: readonly string[];
  hasItems: boolean;
  unpriced: readonly string[];
  quantityKnown: boolean;
  questions: readonly BundleRequirement[];
  answers: Record<string, string>;
  asksSent: number;
}): Decision {
  const missing: MissingRequirement[] = [];
  if (!input.product && !input.hasItems) {
    if (!input.productNames.length) {
      return {
        outcome: 'no_solution',
        missing: [],
        reason:
          'ไม่รู้ว่าลูกค้าสนใจ product ใด และบริษัทยังไม่มีชุดรายการของ product ให้เลือก',
      };
    }
    missing.push({
      key: PRODUCT_KEY,
      question: `สนใจผลิตภัณฑ์/บริการใด (${input.productNames.slice(0, 10).join(', ')})`,
    });
  } else if (!input.hasItems) {
    return {
      outcome: 'no_solution',
      missing: [],
      reason: `"${input.product}" ยังไม่มีชุดรายการหรือรายการสินค้าในระบบ`,
    };
  } else if (input.unpriced.length) {
    return {
      outcome: 'no_solution',
      missing: [],
      reason: `ไม่มีราคามาตรฐานที่มีผลวันนี้: ${input.unpriced.join(', ')}`,
    };
  }

  if (!input.quantityKnown) {
    missing.push({ key: QUANTITY_KEY, question: 'จำนวนที่ต้องการ' });
  }
  for (const question of input.questions) {
    if (!input.answers[question.key]) {
      missing.push({ key: question.key, question: question.question });
    }
  }

  if (!missing.length) {
    return { outcome: 'ready', missing, reason: 'ข้อมูลครบ ออกใบเสนอราคาได้' };
  }
  const labels = missing.map((item) => item.question).join(' · ');
  if (input.asksSent >= MAX_REQUIREMENT_ASKS) {
    return {
      outcome: 'handover',
      missing,
      reason: `ถามลูกค้าไปแล้ว ${input.asksSent} ครั้ง ยังขาด: ${labels}`,
    };
  }
  return { outcome: 'ask', missing, reason: `ยังขาด: ${labels}` };
}

/** The email that asks — plain text; the mailbox turns it into HTML. */
export function requirementEmailBody(
  missing: readonly MissingRequirement[],
  product: string | null,
  intro?: string | null,
): string {
  const opening =
    intro?.trim() ||
    [
      'เรียน ลูกค้า',
      `ขอบคุณที่สนใจ${product ? ` ${product}` : 'บริการของเรา'} เพื่อจัดทำใบเสนอราคาให้ตรงกับความต้องการ รบกวนขอข้อมูลเพิ่มเติมดังนี้`,
    ].join('\n\n');
  const list = missing
    .map((item, index) => `${index + 1}. ${item.question}`)
    .join('\n');
  return [
    opening,
    list,
    'ตอบกลับอีเมลนี้ได้เลย เมื่อได้รับข้อมูลครบ บริษัทจะส่งใบเสนอราคาให้ทันที',
    'ขอบคุณครับ/ค่ะ',
  ].join('\n\n');
}
