/**
 * CD-250 แผนส่งมอบ — the rules, apart from the database. A delivery is one
 * trip of a milestone (a milestone may take several): when, where, who
 * receives, and which BOQ lines of the project's baseline in what quantity.
 * Each line carries whether the goods are ready — typed in until SAP stock
 * can be read (CD-28) — and a line not ready (or only partly) needs a
 * fallback plan.
 */

export const READINESS = ['unknown', 'ready', 'partial', 'not_ready'] as const;
export type Readiness = (typeof READINESS)[number];
export const MAX_DELIVERY_TEXT = 1000;
/** Days before the planned date a line that is not ready is warned about. */
export const DEFAULT_WARN_DAYS = 7;

export interface BoqRef {
  index: number;
  label: string;
  quantity: number;
  unit: string | null;
}

export interface LineInput {
  boqIndex: number;
  quantity: number;
  readiness: string;
  readyQty: number | null;
  expectedOn: string | null;
  fallbackPlan: string;
}

/** A delivery's own problems, in Thai. */
export function deliveryProblems(input: {
  plannedOn: string;
  location: string;
  lines: LineInput[];
  boq: BoqRef[];
}): string[] {
  const problems: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.plannedOn))
    problems.push('วันที่ส่งไม่ถูกต้อง');
  if (!input.location.trim()) problems.push('ต้องระบุสถานที่ส่ง');
  if (input.location.length > MAX_DELIVERY_TEXT)
    problems.push(`สถานที่ยาวเกิน ${MAX_DELIVERY_TEXT} ตัวอักษร`);
  if (!input.lines.length) problems.push('ต้องมีอย่างน้อยหนึ่งบรรทัด');
  const seen = new Set<number>();
  for (const line of input.lines) {
    const ref = input.boq.find((b) => b.index === line.boqIndex);
    const name = ref?.label ?? `BOQ ${line.boqIndex + 1}`;
    if (!ref) {
      problems.push(`${name}: ไม่อยู่ในฐานตั้งต้นของโครงการ`);
      continue;
    }
    if (seen.has(line.boqIndex)) problems.push(`${name}: ซ้ำในรอบเดียวกัน`);
    seen.add(line.boqIndex);
    if (!(line.quantity > 0)) problems.push(`${name}: จำนวนต้องมากกว่า 0`);
    if (!(READINESS as readonly string[]).includes(line.readiness))
      problems.push(`${name}: สถานะความพร้อมไม่ถูกต้อง`);
    if (line.readiness === 'partial') {
      if (
        line.readyQty === null ||
        !(line.readyQty > 0) ||
        line.readyQty >= line.quantity
      )
        problems.push(
          `${name}: พร้อมบางส่วนต้องระบุจำนวนที่พร้อม (น้อยกว่าที่ส่ง)`,
        );
    }
    if (
      (line.readiness === 'partial' || line.readiness === 'not_ready') &&
      !line.fallbackPlan.trim()
    )
      problems.push(`${name}: ของยังไม่พร้อมต้องมีแผนสำรอง`);
    if (line.expectedOn && !/^\d{4}-\d{2}-\d{2}$/.test(line.expectedOn))
      problems.push(`${name}: วันที่คาดว่าของพร้อมไม่ถูกต้อง`);
  }
  return problems;
}

/**
 * Planned quantity per BOQ line across the project's live deliveries, against
 * the BOQ: what is over (a problem) and what is not planned yet.
 */
export function boqCoverage(
  boq: BoqRef[],
  planned: { boqIndex: number; quantity: number }[],
) {
  return boq.map((ref) => {
    const total = planned
      .filter((p) => p.boqIndex === ref.index)
      .reduce((sum, p) => sum + p.quantity, 0);
    return {
      ...ref,
      planned: round2(total),
      remaining: round2(ref.quantity - total),
      over: total > ref.quantity + 1e-9,
    };
  });
}

/** Whether a delivery needs the not-ready warning on `today`. */
export function needsWarning(
  delivery: {
    plannedOn: string;
    status: string;
    lines: { readiness: string }[];
  },
  today: string,
  warnDays: number,
) {
  if (delivery.status !== 'planned') return false;
  const days = daysBetween(today, delivery.plannedOn);
  return (
    days >= 0 &&
    days <= warnDays &&
    delivery.lines.some((line) => line.readiness !== 'ready')
  );
}

/** Ready, partly ready, not ready, or unknown — the worst line wins. */
export function deliveryReadiness(lines: { readiness: string }[]): Readiness {
  const kinds = new Set(lines.map((line) => line.readiness));
  if (kinds.has('not_ready')) return 'not_ready';
  if (kinds.has('unknown')) return 'unknown';
  if (kinds.has('partial')) return 'partial';
  return 'ready';
}

export function daysBetween(from: string, to: string) {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

const round2 = (value: number) => Math.round(value * 100) / 100;
