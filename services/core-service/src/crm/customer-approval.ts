/**
 * CD-62 — which request type approves a new customer, by customer type.
 * Pure, so the rule "no type configured = no approval needed" is tested on
 * its own.
 */
export type CustomerTypeKey = 'corporate' | 'individual' | 'government';

export const CUSTOMER_TYPE_KEYS: readonly CustomerTypeKey[] = [
  'corporate',
  'individual',
  'government',
];

export const CUSTOMER_TYPE_LABELS: Record<CustomerTypeKey, string> = {
  corporate: 'นิติบุคคล',
  individual: 'บุคคลธรรมดา',
  government: 'หน่วยงานรัฐ',
};

const CODE = /^[A-Z0-9_-]{1,20}$/;

/**
 * `CrmCompanyConfig.customerApprovalTypes` read defensively: it is JSON an
 * admin saved, so anything that is not a valid code for a known customer type
 * is ignored rather than trusted.
 */
export function readApprovalTypes(
  value: unknown,
): Partial<Record<CustomerTypeKey, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const result: Partial<Record<CustomerTypeKey, string>> = {};
  for (const key of CUSTOMER_TYPE_KEYS) {
    const code = source[key];
    if (typeof code === 'string' && CODE.test(code)) result[key] = code;
  }
  return result;
}

/** The request type a new customer of this type must be approved through, or null. */
export function approvalTypeFor(
  configured: unknown,
  customerType: string,
): string | null {
  return readApprovalTypes(configured)[customerType as CustomerTypeKey] ?? null;
}
