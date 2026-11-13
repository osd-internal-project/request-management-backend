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
};

export interface BundleInput {
  name?: unknown;
  note?: unknown;
  active?: unknown;
  items?: unknown;
}

export interface CleanBundle {
  name: string;
  note: string;
  active: boolean;
  items: BundleItemState[];
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
    });
  });
  if (items.length && items.every((item) => item.optional)) {
    // a bundle of nothing but extras would quote an empty document
    problems.push({ field: 'items', reason: 'no_mandatory_item' });
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      name,
      note: typeof input.note === 'string' ? input.note.trim() : '',
      active: input.active !== false,
      items,
    },
  };
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

/** What a bundle puts on a quotation by itself — its mandatory items. */
export function mandatoryItems(
  items: readonly BundleItemState[],
): QuotationItem[] {
  return items
    .filter((item) => !item.optional)
    .map((item) => ({
      product_code: item.productCode,
      quantity: item.quantity,
      ...(item.termMonths ? { term_months: item.termMonths } : {}),
    }));
}
