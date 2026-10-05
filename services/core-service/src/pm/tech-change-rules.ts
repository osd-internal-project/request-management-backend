/**
 * CD-224 ปรับแก้ทางเทคนิค — the rules, apart from the database: a change's
 * BOQ lines and what they cost, what it needs before it is submitted, when
 * it is in force, and what it leaves in the as-built and in a change
 * request.
 */
import { readBoq } from '../presales/solution-rules';

export const MAX_TECH_TEXT = 4000;
export const MAX_TECH_LINES = 100;

/** One BOQ line the change touches — a baseline line (`boq:i`) or a new one. */
export interface TechLine {
  ref: string | null;
  name: string;
  unit: string;
  quantityFrom: number;
  quantityTo: number;
  unitCost: number;
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Lines as stored, defended against what JSON may hold. */
export function readTechLines(value: unknown): TechLine[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    return [
      {
        ref: typeof row.ref === 'string' && row.ref ? row.ref : null,
        name: typeof row.name === 'string' ? row.name.trim() : '',
        unit: typeof row.unit === 'string' ? row.unit.trim() : '',
        quantityFrom: num(row.quantityFrom),
        quantityTo: num(row.quantityTo),
        unitCost: num(row.unitCost),
      },
    ];
  });
}

/**
 * Lines as sent, completed from the baseline BOQ: a baseline line keeps its
 * name, unit, quantity sold and reference cost unless given; a new line
 * starts from nothing.
 */
export function techLinesFrom(
  input: readonly {
    ref?: string | null;
    name?: string;
    unit?: string;
    quantity_to?: number;
    unit_cost?: number | null;
  }[],
  baseline: unknown,
): { lines: TechLine[]; problems: string[] } {
  const boq = readBoq((baseline as { boq?: unknown } | null)?.boq);
  const problems: string[] = [];
  if (input.length > MAX_TECH_LINES) {
    problems.push(`รายการ BOQ ได้ไม่เกิน ${MAX_TECH_LINES} บรรทัด`);
  }
  const seen = new Set<string>();
  const lines = input.slice(0, MAX_TECH_LINES).map((row, index) => {
    const ref = row.ref || null;
    const match = ref?.match(/^boq:(\d+)$/);
    const sold = match ? boq[Number(match[1])] : undefined;
    if (ref && !sold)
      problems.push(`บรรทัด ${index + 1}: ไม่พบรายการนี้ใน BOQ`);
    if (ref && seen.has(ref)) {
      problems.push(`บรรทัด ${index + 1}: รายการ BOQ นี้ซ้ำ`);
    }
    if (ref) seen.add(ref);
    const name =
      (row.name ?? '').trim() || sold?.name || sold?.productCode || '';
    if (!name) problems.push(`บรรทัด ${index + 1}: ต้องระบุรายการ`);
    const quantityTo = num(row.quantity_to);
    if (quantityTo < 0) {
      problems.push(`บรรทัด ${index + 1}: จำนวนต้องไม่ติดลบ`);
    }
    const unitCost = row.unit_cost ?? sold?.refUnitCost ?? 0;
    if (unitCost < 0) problems.push(`บรรทัด ${index + 1}: ต้นทุนต้องไม่ติดลบ`);
    const quantityFrom = sold?.quantity ?? 0;
    if (quantityTo === quantityFrom) {
      problems.push(`บรรทัด ${index + 1}: จำนวนไม่เปลี่ยน`);
    }
    return {
      ref,
      name,
      unit: (row.unit ?? '').trim() || sold?.unit || '',
      quantityFrom,
      quantityTo,
      unitCost,
    };
  });
  return { lines, problems };
}

/** What the change does to cost: Σ (to − from) × unit cost. */
export function costChangeOf(lines: readonly TechLine[]): number {
  const total = lines.reduce(
    (sum, line) => sum + (line.quantityTo - line.quantityFrom) * line.unitCost,
    0,
  );
  return Math.round(total * 100) / 100;
}

/** What stops a submission, in Thai. */
export function techSubmitProblems(input: {
  title: string;
  reason: string | null;
  description: string | null;
  lines: number;
  affectsScope: boolean;
  scopeAdded: string | null;
  scopeRemoved: string | null;
  changeRequestId: string | null;
}): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องตั้งชื่อการปรับแก้');
  if (!input.reason?.trim()) problems.push('ต้องระบุเหตุผลที่ต้องปรับแก้');
  if (!input.lines && !input.description?.trim()) {
    problems.push('ต้องระบุว่าปรับแก้อะไร หรือรายการ BOQ ที่เปลี่ยน');
  }
  if (input.affectsScope) {
    if (!input.scopeAdded?.trim() && !input.scopeRemoved?.trim()) {
      problems.push('กระทบขอบเขต: ต้องระบุขอบเขตที่เพิ่มหรือลด');
    }
    if (!input.changeRequestId) {
      problems.push('กระทบขอบเขต: ต้องเปิดคำขอเปลี่ยนแปลง (CR) ก่อนยื่น');
    }
  }
  return problems;
}

/** In force: approved, and its change request approved when it has to. */
export function inForce(input: {
  status: string;
  affectsScope: boolean;
  changeStatus: string | null;
}): boolean {
  return (
    input.status === 'approved' &&
    (!input.affectsScope || input.changeStatus === 'approved')
  );
}

const qty = (value: number, unit: string) =>
  `${value}${unit ? ` ${unit}` : ''}`;

/** The as-built deviations an approved change leaves (CD-226). */
export function deviationsOf(input: {
  label: string;
  title: string;
  reason: string | null;
  affectsScope: boolean;
  changeRequestId: string | null;
  lines: readonly TechLine[];
}) {
  const why = `${input.label} ${input.title}${input.reason ? `: ${input.reason}` : ''}`;
  return input.lines.map((line) => ({
    reference: line.ref,
    planned: line.ref
      ? `${line.name} × ${qty(line.quantityFrom, line.unit)}`
      : 'ไม่มีใน BOQ',
    built: `${line.name} × ${qty(line.quantityTo, line.unit)}`,
    reason: why.slice(0, MAX_TECH_TEXT),
    affectsScope: input.affectsScope,
    changeRequestId: input.changeRequestId,
  }));
}

/** The change request a scope-changing change opens (CD-185), as a draft. */
export function changeFromTech(input: {
  label: string;
  title: string;
  reason: string | null;
  scopeAdded: string | null;
  scopeRemoved: string | null;
  lines: readonly TechLine[];
}) {
  const title = `${input.label}: ${input.title}`;
  return {
    title: title.length > 255 ? `${title.slice(0, 252)}...` : title,
    reason: `ปรับแก้ทางเทคนิค ${input.label}: ${input.reason ?? input.title}`,
    ...(input.scopeAdded ? { scope_added: input.scopeAdded } : {}),
    ...(input.scopeRemoved ? { scope_removed: input.scopeRemoved } : {}),
    // only what is added costs money; removals are left to the manager
    cost_lines: input.lines
      .filter((line) => line.quantityTo > line.quantityFrom)
      .map((line) => ({
        category: 'material',
        description: line.name,
        quantity: line.quantityTo - line.quantityFrom,
        ...(line.unit ? { unit: line.unit } : {}),
        unit_cost: line.unitCost,
      })),
  };
}
