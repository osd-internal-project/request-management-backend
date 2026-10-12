import type { BillingLineInput } from './billing-rules';

/**
 * CD-243 บันทึกเวลาและวัสดุงานบริการ — the pure part: a job's time (from
 * timesheets) and materials turned into charge lines, and how a charge's
 * lines are rebuilt from them without losing what a person typed.
 */

export interface ServiceTime {
  userId: string;
  workTypeId: string;
  hours: number;
  billable: boolean;
  approved: boolean;
}

export interface LabourRate {
  workTypeId: string;
  hourlyRate: number;
  productCode: string | null;
}

export interface MaterialUse {
  productCode: string;
  description: string;
  quantity: number;
  unit: string | null;
  serialNo: string | null;
  billable: boolean;
  unitPrice: number | null;
  unitCost: number | null;
}

export type ChargeLine = BillingLineInput & {
  /** CD-228 — `extra`: out-of-contract work the customer agreed to. */
  source: 'estimate' | 'manual' | 'labour' | 'material' | 'extra';
};

const round = (value: number, places: number) =>
  Math.round(value * 10 ** places) / 10 ** places;

/** Hours by state: what may be charged (approved, billable), and the rest. */
export function timeTotals(time: readonly ServiceTime[]) {
  let approved = 0;
  let pending = 0;
  let billable = 0;
  for (const row of time) {
    if (row.approved) approved += row.hours;
    else pending += row.hours;
    if (row.approved && row.billable) billable += row.hours;
  }
  return {
    approved: round(approved, 1),
    pending: round(pending, 1),
    billable: round(billable, 1),
  };
}

/**
 * One labour line per work type: approved, billable hours × the type's
 * selling rate. A type with no rate is not guessed at — it is named back so
 * the screen can say which rate to set.
 */
export function labourLines(
  time: readonly ServiceTime[],
  rates: readonly LabourRate[],
  workTypeName: (id: string) => string,
): { lines: ChargeLine[]; unrated: string[] } {
  const hours = new Map<string, number>();
  for (const row of time) {
    if (!row.approved || !row.billable) continue;
    hours.set(row.workTypeId, (hours.get(row.workTypeId) ?? 0) + row.hours);
  }
  const lines: ChargeLine[] = [];
  const unrated: string[] = [];
  for (const [workTypeId, total] of hours) {
    const rate = rates.find((row) => row.workTypeId === workTypeId);
    if (!rate) {
      unrated.push(workTypeName(workTypeId));
      continue;
    }
    lines.push({
      productCode: rate.productCode,
      description: `ค่าแรง ${workTypeName(workTypeId)}`,
      quantity: round(total, 3),
      unit: 'ชม.',
      unitPrice: rate.hourlyRate,
      discountPct: 0,
      source: 'labour',
    });
  }
  return { lines, unrated };
}

/** Billable materials with a price; one without a price is named back. */
export function materialLines(materials: readonly MaterialUse[]): {
  lines: ChargeLine[];
  unpriced: string[];
} {
  const lines: ChargeLine[] = [];
  const unpriced: string[] = [];
  for (const row of materials) {
    if (!row.billable) continue;
    if (row.unitPrice === null) {
      unpriced.push(row.productCode);
      continue;
    }
    lines.push({
      productCode: row.productCode,
      description: [row.description, row.serialNo && `S/N ${row.serialNo}`]
        .filter(Boolean)
        .join(' · ')
        .slice(0, 200),
      quantity: row.quantity,
      unit: row.unit,
      unitPrice: row.unitPrice,
      discountPct: 0,
      source: 'material',
    });
  }
  return { lines, unpriced };
}

/**
 * A charge's lines rebuilt: what a person typed stays, earlier labour and
 * material lines are replaced by the fresh ones, and the estimate line goes
 * once there is actual time or material to charge instead.
 */
export function rebuildLines(
  existing: readonly ChargeLine[],
  fresh: readonly ChargeLine[],
): ChargeLine[] {
  // CD-228 — agreed extras are rebuilt too, but do not replace the estimate
  const actual = fresh.some(
    (line) => line.source === 'labour' || line.source === 'material',
  );
  const kept = existing.filter(
    (line) =>
      line.source === 'manual' || (line.source === 'estimate' && !actual),
  );
  return [...kept, ...fresh];
}

/** Material cost of the job (all of it, billed or covered). */
export function materialCost(materials: readonly MaterialUse[]) {
  let cost = 0;
  let unknown = 0;
  for (const row of materials) {
    if (row.unitCost === null) unknown += 1;
    else cost += row.unitCost * row.quantity;
  }
  return { cost: round(cost, 2), unknownCost: unknown };
}

/** Revenue less labour and material cost, and the margin on revenue. */
export function jobMargin(input: {
  revenue: number;
  labourCost: number;
  materialCost: number;
}) {
  const cost = round(input.labourCost + input.materialCost, 2);
  const profit = round(input.revenue - cost, 2);
  return {
    cost,
    profit,
    marginPct:
      input.revenue > 0 ? round((profit / input.revenue) * 100, 1) : null,
  };
}
