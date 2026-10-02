/**
 * CD-209 วางแผนงานเทคนิค — the rules, apart from the database: the
 * equipment a task needs, handoff 7 (PM → Engineer: every task has an
 * owner, and every task that needs equipment says which), and the
 * equipment needed week by week.
 */
import { weekStart } from './health-rules';

export const MAX_EQUIPMENT_LINES = 50;

export interface EquipmentLine {
  boqIndex: number | null;
  name: string;
  quantity: number;
  unit: string | null;
  note: string | null;
}

/** Equipment as entered, checked against the baseline's BOQ. */
export function cleanEquipment(
  rows: readonly {
    boq_index?: unknown;
    name?: unknown;
    quantity?: unknown;
    unit?: unknown;
    note?: unknown;
  }[],
  boq: readonly { name: string; unit: string }[],
): { lines: EquipmentLine[]; problems: string[] } {
  const problems: string[] = [];
  const lines: EquipmentLine[] = [];
  rows.forEach((row, index) => {
    const at = `อุปกรณ์ข้อ ${index + 1}`;
    const boqIndex =
      row.boq_index === null ||
      row.boq_index === undefined ||
      row.boq_index === ''
        ? null
        : Number(row.boq_index);
    if (boqIndex !== null && (!Number.isInteger(boqIndex) || !boq[boqIndex])) {
      problems.push(`${at}: บรรทัด BOQ ไม่อยู่ในฐานตั้งต้น`);
      return;
    }
    const name =
      (typeof row.name === 'string' ? row.name.trim() : '') ||
      (boqIndex !== null ? boq[boqIndex].name : '');
    const quantity = Number(row.quantity);
    if (!name) problems.push(`${at}: ต้องระบุชื่ออุปกรณ์หรือเลือกบรรทัด BOQ`);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      problems.push(`${at}: จำนวนต้องมากกว่า 0`);
    }
    if (name && Number.isFinite(quantity) && quantity > 0) {
      lines.push({
        boqIndex,
        name: name.slice(0, 255),
        quantity: Math.round(quantity * 100) / 100,
        unit:
          (typeof row.unit === 'string' && row.unit.trim()) ||
          (boqIndex !== null ? boq[boqIndex].unit || null : null),
        note:
          typeof row.note === 'string' && row.note.trim()
            ? row.note.trim()
            : null,
      });
    }
  });
  if (rows.length > MAX_EQUIPMENT_LINES) {
    problems.push(`อุปกรณ์ได้ไม่เกิน ${MAX_EQUIPMENT_LINES} รายการต่องาน`);
  }
  return { lines, problems };
}

/** Handoff 7: what still keeps technical work from starting, in Thai. */
export function handoffBlockers(
  tasks: readonly {
    label: string;
    ownerUserId: string | null;
    needsEquipment: boolean;
    equipment: number;
    status: string;
  }[],
): string[] {
  const live = tasks.filter((task) => task.status !== 'cancelled');
  const noOwner = live
    .filter((task) => !task.ownerUserId)
    .map((task) => task.label);
  const noEquipment = live
    .filter((task) => task.needsEquipment && task.equipment === 0)
    .map((task) => task.label);
  return [
    ...(noOwner.length
      ? [`งานที่ยังไม่มีผู้รับผิดชอบ: ${noOwner.join(', ')}`]
      : []),
    ...(noEquipment.length
      ? [`งานที่ต้องใช้อุปกรณ์แต่ยังไม่ระบุ: ${noEquipment.join(', ')}`]
      : []),
  ];
}

/** The equipment needed in each week a task runs, summed by name and unit. */
export function weeklyEquipment(
  tasks: readonly {
    start: string | null;
    finish: string | null;
    equipment: readonly {
      name: string;
      quantity: number;
      unit: string | null;
    }[];
  }[],
) {
  const weeks = new Map<
    string,
    Map<string, { name: string; unit: string | null; quantity: number }>
  >();
  for (const task of tasks) {
    if (!task.start || !task.finish || !task.equipment.length) continue;
    let week = weekStart(task.start);
    const last = weekStart(task.finish);
    for (let guard = 0; week <= last && guard < 260; guard++) {
      const items =
        weeks.get(week) ??
        new Map<
          string,
          { name: string; unit: string | null; quantity: number }
        >();
      for (const line of task.equipment) {
        const key = `${line.name}|${line.unit ?? ''}`;
        const current = items.get(key) ?? {
          name: line.name,
          unit: line.unit,
          quantity: 0,
        };
        current.quantity =
          Math.round((current.quantity + line.quantity) * 100) / 100;
        items.set(key, current);
      }
      weeks.set(week, items);
      week = new Date(new Date(`${week}T00:00:00Z`).getTime() + 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([week, items]) => ({
      week,
      items: [...items.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
