/**
 * CD-148 / CD-149 — the checks between a contract and the master agreement
 * it is made under, kept pure.
 */

export const NDA_DIRECTIONS = ['mutual', 'disclosing', 'receiving'] as const;

export interface PartySide {
  id?: string;
  kind: string;
  customerId: string | null;
  counterpartyName: string | null;
}

const squash = (value: string | null) =>
  (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The same customer, or the same named counterparty. */
export function sameParty(a: PartySide, b: PartySide): boolean {
  if (a.customerId || b.customerId) return a.customerId === b.customerId;
  return (
    Boolean(a.counterpartyName) &&
    squash(a.counterpartyName) === squash(b.counterpartyName)
  );
}

/**
 * Why `contract` cannot be made under `master` — or null when it can. An MSA
 * is not itself under another; the master must be an MSA, not cancelled, and
 * with the same party.
 */
export function masterProblem(
  contract: PartySide,
  master: (PartySide & { id: string; status: string }) | null,
): string | null {
  if (!master) return 'ไม่พบข้อตกลงหลักที่ระบุ';
  if (contract.id && master.id === contract.id) {
    return 'สัญญาอ้างอิงตัวเองเป็นข้อตกลงหลักไม่ได้';
  }
  if (contract.kind === 'msa') {
    return 'ข้อตกลงหลัก (MSA) อ้างอิงข้อตกลงหลักอื่นไม่ได้';
  }
  if (master.kind !== 'msa') return 'สัญญาที่อ้างอิงต้องเป็นข้อตกลงหลัก (MSA)';
  if (master.status === 'cancelled') return 'ข้อตกลงหลักนี้ถูกยกเลิกแล้ว';
  if (!sameParty(contract, master)) {
    return 'สัญญาย่อยต้องเป็นคู่สัญญาเดียวกับข้อตกลงหลัก';
  }
  return null;
}
