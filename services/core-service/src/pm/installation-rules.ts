/**
 * CD-216 ติดตั้ง — the rules, apart from the database: an installation
 * point's own problems, and installed units against the BOQ.
 */
import { readBoq } from '../presales/solution-rules';

export const MAX_INSTALL_TEXT = 1000;

/** The equipment lines of the baseline's BOQ — what is counted unit by unit. */
export function equipmentLines(baseline: unknown) {
  const boq = readBoq((baseline as { boq?: unknown } | null)?.boq);
  return boq.flatMap((line, index) =>
    line.kind === 'equipment'
      ? [
          {
            index,
            ref: `boq:${index}`,
            label: `BOQ ${index + 1}: ${line.name || line.productCode}`,
            quantity: line.quantity,
          },
        ]
      : [],
  );
}

/** Every BOQ line a point may install, equipment or not. */
export function boqChoices(baseline: unknown) {
  const boq = readBoq((baseline as { boq?: unknown } | null)?.boq);
  return boq.map((line, index) => ({
    index,
    label: `BOQ ${index + 1}: ${line.name || line.productCode} × ${line.quantity}${line.unit ? ` ${line.unit}` : ''}`,
    equipment: line.kind === 'equipment',
  }));
}

/** A point's own problems, in Thai. */
export function pointProblems(input: {
  location: string;
  boqIndex: number | null;
  boqCount: number;
  equipment: boolean;
  serialNo: string | null;
  installedOn: string | null;
  hasAfter: boolean;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!input.location.trim()) problems.push('ต้องระบุตำแหน่งที่ติดตั้ง');
  if (input.location.length > MAX_INSTALL_TEXT) {
    problems.push(`ตำแหน่งยาวเกิน ${MAX_INSTALL_TEXT} ตัวอักษร`);
  }
  if (
    input.boqIndex !== null &&
    (input.boqIndex < 0 || input.boqIndex >= input.boqCount)
  ) {
    problems.push('บรรทัด BOQ ไม่อยู่ในฐานตั้งต้นของโครงการ');
  }
  if (input.installedOn) {
    if (input.installedOn > input.today) {
      problems.push('วันที่ติดตั้งต้องไม่เกินวันนี้');
    }
    if (!input.hasAfter) problems.push('ติดตั้งแล้วต้องแนบรูปหลังติดตั้ง');
    if (input.equipment && !input.serialNo?.trim()) {
      problems.push('อุปกรณ์ที่ติดตั้งแล้วต้องมีหมายเลขเครื่อง');
    }
  }
  return problems;
}

export interface BoqMatchLine {
  index: number;
  ref: string;
  label: string;
  quantity: number;
  installed: number;
  matches: boolean;
}

/** Installed units of each equipment line against what the BOQ sold. */
export function boqMatch(
  baseline: unknown,
  points: readonly { boqIndex: number | null; installedOn: unknown }[],
): BoqMatchLine[] {
  return equipmentLines(baseline).map((line) => {
    const installed = points.filter(
      (point) => point.boqIndex === line.index && point.installedOn,
    ).length;
    return { ...line, installed, matches: installed === line.quantity };
  });
}

/**
 * The lines that do not match and have no as-built deviation pointing at
 * them — what keeps the as-built incomplete (CD-226).
 */
export function unexplainedMismatches(
  lines: readonly BoqMatchLine[],
  deviationRefs: readonly (string | null)[],
): string[] {
  const explained = new Set(deviationRefs.filter(Boolean));
  return lines
    .filter((line) => !line.matches && !explained.has(line.ref))
    .map(
      (line) =>
        `${line.label}: ติดตั้ง ${line.installed} จาก ${line.quantity} — ต้องบันทึกจุดที่ต่างอ้างบรรทัดนี้`,
    );
}
