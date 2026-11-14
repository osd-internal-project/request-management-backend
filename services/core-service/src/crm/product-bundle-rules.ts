/**
 * ชุดรายการของ product (12 พ.ย. 2569) — pure, so it is tested on its own.
 *
 * A "product" is what the salesperson says the customer wants (D-DEBT,
 * IP-PHONE …); a bundle lists the SAP items a quotation for it carries.
 * Mandatory items always go in; optional ones only when the salesperson
 * ticks them on the Lead, which writes the Lead's own list.
 */

export const MAX_BUNDLE_ITEMS = 50;
export const MAX_BUNDLE_QUANTITY = 1_000_000;
export const MAX_TERM_MONTHS = 120;
export const MAX_BUNDLE_REQUIREMENTS = 15;
/** The key of the one question every product has: how many. */
export const QUANTITY_KEY = 'quantity';

export interface QuotationItem {
  product_code: string;
  quantity: number;
  term_months?: number;
}

// a type, not an interface: it is written into the audit log's JSON as it is
export type BundleItemState = {
  productCode: string;
  quantity: number;
  termMonths: number | null;
  optional: boolean;
  /** stays as written however many the customer asks for (a one-off fee) */
  fixedQuantity: boolean;
};

/**
 * Something to know from the customer before quoting this product
 * (13 พ.ย. 2569). `hints` are words whose presence in a reply counts as an
 * answer when no LLM reads it.
 */
export type BundleRequirement = {
  key: string;
  question: string;
  hints: string[];
};

export interface BundleInput {
  name?: unknown;
  note?: unknown;
  active?: unknown;
  items?: unknown;
  requirements?: unknown;
}

export interface CleanBundle {
  name: string;
  note: string;
  active: boolean;
  items: BundleItemState[];
  requirements: BundleRequirement[];
}

interface Problem {
  field: string;
  reason: string;
}

/** Product names are compared without case or stray spaces. */
export function bundleKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cleanBundle(
  input: BundleInput,
): { ok: true; value: CleanBundle } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  const name =
    typeof input.name === 'string'
      ? input.name.trim().replace(/\s+/g, ' ')
      : '';
  if (!name) problems.push({ field: 'name', reason: 'required' });
  else if (name.length > 120) {
    problems.push({ field: 'name', reason: 'too_long' });
  }

  const rows = Array.isArray(input.items) ? input.items : [];
  if (!rows.length) problems.push({ field: 'items', reason: 'required' });
  if (rows.length > MAX_BUNDLE_ITEMS) {
    problems.push({ field: 'items', reason: 'too_many' });
  }

  const seen = new Set<string>();
  const items: BundleItemState[] = [];
  rows.forEach((raw, index) => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<
      string,
      unknown
    >;
    const code =
      typeof row.productCode === 'string' ? row.productCode.trim() : '';
    const quantity = Number(row.quantity ?? 1);
    const term =
      row.termMonths === null || row.termMonths === undefined
        ? null
        : Number(row.termMonths);
    if (!code) {
      problems.push({
        field: `items[${index}].product_code`,
        reason: 'required',
      });
    } else if (seen.has(code)) {
      problems.push({
        field: `items[${index}].product_code`,
        reason: 'duplicate',
      });
    }
    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      quantity > MAX_BUNDLE_QUANTITY
    ) {
      problems.push({
        field: `items[${index}].quantity`,
        reason: 'out_of_range',
      });
    }
    if (
      term !== null &&
      (!Number.isInteger(term) || term < 1 || term > MAX_TERM_MONTHS)
    ) {
      problems.push({
        field: `items[${index}].term_months`,
        reason: 'out_of_range',
      });
    }
    seen.add(code);
    items.push({
      productCode: code,
      quantity,
      termMonths: term,
      optional: row.optional === true,
      fixedQuantity: row.fixedQuantity === true,
    });
  });
  if (items.length && items.every((item) => item.optional)) {
    // a bundle of nothing but extras would quote an empty document
    problems.push({ field: 'items', reason: 'no_mandatory_item' });
  }

  const requirements = cleanRequirements(input.requirements, problems);

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      name,
      note: typeof input.note === 'string' ? input.note.trim() : '',
      active: input.active !== false,
      items,
      requirements,
    },
  };
}

/** A key for a question with none given: `q1`, `q2` … by position. */
const REQUIREMENT_KEY = /^[a-z0-9_]{1,40}$/;

function cleanRequirements(
  input: unknown,
  problems: Problem[],
): BundleRequirement[] {
  const rows = Array.isArray(input) ? input : [];
  if (rows.length > MAX_BUNDLE_REQUIREMENTS) {
    problems.push({ field: 'requirements', reason: 'too_many' });
  }
  const seen = new Set<string>([QUANTITY_KEY]);
  return rows.map((raw, index) => {
    const row = (raw && typeof raw === 'object' ? raw : {}) as Record<
      string,
      unknown
    >;
    const question =
      typeof row.question === 'string'
        ? row.question.trim().replace(/\s+/g, ' ')
        : '';
    if (!question) {
      problems.push({
        field: `requirements[${index}].question`,
        reason: 'required',
      });
    } else if (question.length > 300) {
      problems.push({
        field: `requirements[${index}].question`,
        reason: 'too_long',
      });
    }
    let key = typeof row.key === 'string' ? row.key.trim().toLowerCase() : '';
    if (!key) {
      let n = index + 1;
      while (seen.has(`q${n}`)) n += 1;
      key = `q${n}`;
    } else if (!REQUIREMENT_KEY.test(key)) {
      problems.push({
        field: `requirements[${index}].key`,
        reason: 'invalid',
      });
    } else if (seen.has(key)) {
      problems.push({
        field: `requirements[${index}].key`,
        reason: 'duplicate',
      });
    }
    seen.add(key);
    const hints = (Array.isArray(row.hints) ? row.hints : [])
      .filter((hint): hint is string => typeof hint === 'string')
      .map((hint) => hint.trim().toLowerCase())
      .filter((hint) => hint.length >= 2 && hint.length <= 40)
      .slice(0, 10);
    return { key, question, hints: [...new Set(hints)] };
  });
}

/** Stored requirements read back — anything malformed is dropped. */
export function requirementsOf(stored: unknown): BundleRequirement[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((raw): BundleRequirement[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    if (typeof row.key !== 'string' || typeof row.question !== 'string') {
      return [];
    }
    return [
      {
        key: row.key,
        question: row.question,
        hints: Array.isArray(row.hints)
          ? row.hints.filter((h): h is string => typeof h === 'string')
          : [],
      },
    ];
  });
}

interface LeadProducts {
  subProduct: string | null;
  intakeData: unknown;
}

const intakeOf = (lead: LeadProducts | null): Record<string, unknown> =>
  lead?.intakeData && typeof lead.intakeData === 'object'
    ? (lead.intakeData as Record<string, unknown>)
    : {};

/**
 * The Lead's own list — `intake_data.products`, written by Vuvagent or by the
 * salesperson adjusting a bundle on the Lead. It wins over any bundle.
 */
export function listedItemsOfLead(lead: LeadProducts | null): QuotationItem[] {
  const listed = intakeOf(lead).products;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry): QuotationItem[] => {
    if (typeof entry === 'string' && entry.trim()) {
      return [{ product_code: entry.trim(), quantity: 1 }];
    }
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const code = row.product_code ?? row.code;
    if (typeof code !== 'string' || !code.trim()) return [];
    const quantity = Number(row.quantity ?? row.qty ?? 1);
    const term = Number(row.term_months);
    return [
      {
        product_code: code.trim(),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
        ...(Number.isInteger(term) && term >= 1 && term <= MAX_TERM_MONTHS
          ? { term_months: term }
          : {}),
      },
    ];
  });
}

/**
 * The product the customer wants: the one the salesperson picked on the
 * proposal card (`intake_data.selected_product`), else the Lead's Sub Product.
 */
export function productNameOfLead(lead: LeadProducts | null): string | null {
  const picked = intakeOf(lead).selected_product;
  if (typeof picked === 'string' && picked.trim()) return picked.trim();
  return lead?.subProduct?.trim() || null;
}

/**
 * The bundle the salesperson picked for this Lead by name
 * (`intake_data.selected_bundle`, 13 พ.ย. 2569) — a product sold in several
 * sizes has one bundle per size, so the product name alone cannot choose.
 */
export function bundleNameOfLead(lead: LeadProducts | null): string | null {
  const picked = intakeOf(lead).selected_bundle;
  return typeof picked === 'string' && picked.trim() ? picked.trim() : null;
}

/**
 * What the customer told the sales automation so far
 * (`intake_data.requirements`, 13 พ.ย. 2569): the product they named, how
 * many, and their answers to the product's questions by key.
 */
export interface LeadRequirements {
  product: string | null;
  quantity: number | null;
  answers: Record<string, string>;
}

export function requirementsOfLead(
  lead: LeadProducts | null,
): LeadRequirements {
  const raw = intakeOf(lead).requirements;
  const row = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const quantity = Number(row.quantity);
  const answers: Record<string, string> = {};
  if (row.answers && typeof row.answers === 'object') {
    for (const [key, value] of Object.entries(row.answers)) {
      if (typeof value === 'string' && value.trim()) answers[key] = value;
    }
  }
  return {
    product:
      typeof row.product === 'string' && row.product.trim()
        ? row.product.trim()
        : null,
    quantity:
      Number.isFinite(quantity) &&
      quantity > 0 &&
      quantity <= MAX_BUNDLE_QUANTITY
        ? quantity
        : null,
    answers,
  };
}

/**
 * What a bundle puts on a quotation by itself — its mandatory items, written
 * for one unit: `units` (how many the customer asked for) multiplies every
 * line except those marked `fixedQuantity`.
 */
export function mandatoryItems(
  items: readonly BundleItemState[],
  units = 1,
): QuotationItem[] {
  return items
    .filter((item) => !item.optional)
    .map((item) => ({
      product_code: item.productCode,
      quantity: item.fixedQuantity ? item.quantity : item.quantity * units,
      ...(item.termMonths ? { term_months: item.termMonths } : {}),
    }));
}
