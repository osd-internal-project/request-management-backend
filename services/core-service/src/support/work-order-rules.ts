/**
 * CD-239 ใบสั่งงานบริการ — the rules, apart from the database: what the
 * system suggests from an asset's cover, what confirming needs, what a
 * billed job needs before work starts, and what closing needs.
 */

export const WORK_KINDS = ['corrective', 'preventive'] as const;
export const BILLINGS = ['in_contract', 'billable'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
export type Billing = (typeof BILLINGS)[number];

interface Cover {
  id: string;
  title: string;
  correctiveLeft: number | null;
  preventiveLeft: number | null;
}

/**
 * In contract when an entitlement in force has visits left of this kind
 * (none counted = unlimited); billed otherwise — with why, in Thai.
 */
export function suggestBilling(
  cover: readonly Cover[],
  kind: WorkKind,
): { billing: Billing; entitlementId: string | null; note: string } {
  if (!cover.length) {
    return {
      billing: 'billable',
      entitlementId: null,
      note: 'ไม่มีสิทธิ์บริการที่มีผลวันนี้',
    };
  }
  const left = (row: Cover) =>
    kind === 'corrective' ? row.correctiveLeft : row.preventiveLeft;
  const usable = cover.find((row) => left(row) === null || left(row)! > 0);
  if (usable) {
    return {
      billing: 'in_contract',
      entitlementId: usable.id,
      note: `อยู่ใน ${usable.title}`,
    };
  }
  return {
    billing: 'billable',
    entitlementId: cover[0].id,
    note: `โควตา${kind === 'corrective' ? 'แก้เหตุ' : 'บำรุงรักษา'}ของ ${cover[0].title} หมดแล้ว`,
  };
}

/** Confirming: a known answer; a different one from the system's says why. */
export function confirmProblems(input: {
  billing: string;
  suggested: string;
  reason: string;
  entitlementId: string | null;
}): string[] {
  const problems: string[] = [];
  if (!(BILLINGS as readonly string[]).includes(input.billing)) {
    problems.push('ต้องเลือก อยู่ในสัญญา หรือ เก็บเงินเพิ่ม');
    return problems;
  }
  if (input.billing !== input.suggested && !input.reason.trim()) {
    problems.push('เลือกต่างจากที่ระบบเสนอ ต้องระบุเหตุผล');
  }
  if (input.billing === 'in_contract' && !input.entitlementId) {
    problems.push('อยู่ในสัญญา ต้องระบุสิทธิ์บริการที่ครอบคลุม');
  }
  return problems;
}

/** A billed job: who agreed for the customer, when, for how much. */
export function ackProblems(input: {
  name: string;
  on: string;
  estimate: number | null;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!input.name.trim()) problems.push('ต้องระบุผู้ยินยอมฝั่งลูกค้า');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.on)) {
    problems.push('ต้องระบุวันที่ลูกค้ายินยอม');
  } else if (input.on > input.today) {
    problems.push('วันที่ยินยอมต้องไม่เกินวันนี้');
  }
  if (input.estimate !== null && !(input.estimate >= 0)) {
    problems.push('ประมาณการค่าใช้จ่ายต้องไม่ติดลบ');
  }
  return problems;
}

/** Why work may not start yet, or null. */
export function startBlocker(order: {
  billing: string | null;
  ackOn: Date | string | null;
}): string | null {
  if (!order.billing) {
    return 'ใบสั่งงานบริการยังไม่ได้ยืนยันว่าอยู่ในสัญญาหรือเก็บเงินเพิ่ม';
  }
  if (order.billing === 'billable' && !order.ackOn) {
    return 'งานเก็บเงินเพิ่ม ต้องบันทึกว่าลูกค้ารับทราบค่าใช้จ่ายก่อนเริ่มงาน';
  }
  return null;
}

/** Why it may not close yet, or null. */
export function closeBlocker(order: {
  cause: string | null;
  resolution: string | null;
}): string | null {
  if (!order.cause?.trim() || !order.resolution?.trim()) {
    return 'ปิดใบสั่งงานบริการต้องบันทึกสาเหตุและวิธีแก้';
  }
  return null;
}
