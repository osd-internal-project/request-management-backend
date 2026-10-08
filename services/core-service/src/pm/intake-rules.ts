/**
 * CD-176 รับมอบงาน — the project manager's receipt of the work, apart from
 * the database: the lines composed from what the project holds, the
 * manager's verdicts carried over while a line's detail stays the same, and
 * who is told about which gaps when the work is sent back.
 *
 * The lines come in four groups, by who answers for them:
 *  - sales: the CD-84 handover and each line the salesperson confirmed;
 *  - technical: the approved Solution, its scope and its BOQ (CD-144);
 *  - contract: signed, its value, its period and its billing installments;
 *  - company: the lines the company adds in CRM settings.
 */

export const INTAKE_GROUPS = [
  'sales',
  'technical',
  'contract',
  'company',
] as const;
export type IntakeGroup = (typeof INTAKE_GROUPS)[number];

export const INTAKE_RESULTS = ['ok', 'incomplete'] as const;
export type IntakeResult = (typeof INTAKE_RESULTS)[number];

export const MAX_INTAKE_NOTE = 1000;

/** A line as composed from the sources — what the manager is asked about. */
export interface IntakeLine {
  code: string;
  group: IntakeGroup;
  label: string;
  detail: string;
  /** The source itself says something is missing here. */
  warn: boolean;
}

/** The manager's verdict on a line, with the detail it was given on. */
export interface IntakeAnswer {
  code: string;
  detail: string;
  result: IntakeResult;
  note: string | null;
  by: string;
  at: string;
}

export interface IntakeLineState extends IntakeLine {
  result: IntakeResult | null;
  note: string | null;
  by: string | null;
  at: string | null;
  /** Answered before, but the detail has changed since — asked again. */
  changed: boolean;
}

export interface IntakeSources {
  handover: {
    status: string;
    round: number;
    items: readonly {
      code: string;
      label: string;
      checked: boolean;
      detail: string | null;
    }[];
  } | null;
  baseline: {
    contract?: {
      contractNo?: string | null;
      value?: number | null;
      currency?: string | null;
      startOn?: string | null;
      endOn?: string | null;
      signedOn?: string | null;
    } | null;
    solution?: { title?: string | null; versionNo?: number | null } | null;
    scope?: {
      inScope?: readonly unknown[];
      outOfScope?: readonly unknown[];
      deliverables?: readonly unknown[];
    } | null;
    boq?: readonly unknown[];
    cost?: { total?: number | null; missingCost?: number | null } | null;
    installments?: readonly { amount?: number | null }[];
  };
  /** The project's own record of what the baseline could not find. */
  missing: readonly string[];
  companyLines: readonly string[];
}

const HANDOVER_STATUS: Record<string, string> = {
  draft: 'ยังไม่ได้ส่ง',
  submitted: 'ส่งแล้ว รอทีมรับ',
  accepted: 'ทีมรับแล้ว',
  returned: 'ถูกตีกลับ',
};

const money = (value: number) =>
  value.toLocaleString('th-TH', { maximumFractionDigits: 2 });

const count = (list: readonly unknown[] | undefined) => list?.length ?? 0;

/** The lines, in their groups' order. */
export function intakeLines(sources: IntakeSources): IntakeLine[] {
  const lines: IntakeLine[] = [];
  const { handover, baseline } = sources;

  // sales — the CD-84 handover, and what the salesperson confirmed in it
  lines.push({
    code: 'sales.handover',
    group: 'sales',
    label: 'งานส่งมอบจากทีมขาย',
    detail: handover
      ? `${HANDOVER_STATUS[handover.status] ?? handover.status} · ส่งครั้งที่ ${handover.round}`
      : 'ไม่พบงานส่งมอบจากทีมขายของดีลนี้',
    warn: !handover || handover.status !== 'accepted',
  });
  for (const item of handover?.items ?? []) {
    lines.push({
      code: `sales.item.${item.code}`,
      group: 'sales',
      label: item.label,
      detail: item.checked
        ? (item.detail ?? 'ทีมขายยืนยันแล้ว')
        : 'ทีมขายยังไม่ได้ยืนยัน',
      warn: !item.checked,
    });
  }

  // technical — the approved Solution, its scope and its BOQ
  const solution = baseline.solution;
  lines.push({
    code: 'technical.solution',
    group: 'technical',
    label: 'Solution ที่อนุมัติแล้ว',
    detail: solution?.title
      ? `${solution.title}${solution.versionNo ? ` · เวอร์ชัน ${solution.versionNo}` : ''}`
      : 'ไม่พบ Solution ที่อนุมัติแล้ว',
    warn: !solution?.title,
  });
  const scope = baseline.scope;
  const inScope = count(scope?.inScope);
  const deliverables = count(scope?.deliverables);
  lines.push({
    code: 'technical.scope',
    group: 'technical',
    label: 'ขอบเขตงานและสิ่งส่งมอบ',
    detail: `ในขอบเขต ${inScope} ข้อ · นอกขอบเขต ${count(scope?.outOfScope)} ข้อ · สิ่งส่งมอบ ${deliverables} รายการ`,
    warn: !inScope || !deliverables,
  });
  const boq = count(baseline.boq);
  const missingCost = baseline.cost?.missingCost ?? 0;
  lines.push({
    code: 'technical.boq',
    group: 'technical',
    label: 'BOQ และต้นทุน',
    detail: boq
      ? `BOQ ${boq} รายการ${
          baseline.cost?.total != null
            ? ` · ต้นทุนรวม ${money(baseline.cost.total)}`
            : ''
        }${missingCost ? ` · ยังไม่มีต้นทุน ${missingCost} รายการ` : ''}`
      : 'ไม่มี BOQ',
    warn: !boq || missingCost > 0,
  });

  // contract — signed, its value, its period, its installments
  const contract = baseline.contract ?? {};
  lines.push({
    code: 'contract.signed',
    group: 'contract',
    label: 'สัญญาที่ลงนามแล้ว',
    detail: contract.signedOn
      ? `${contract.contractNo ?? ''} · ลงนาม ${contract.signedOn}`.trim()
      : `${contract.contractNo ?? ''} · ไม่พบวันที่ลงนาม`.trim(),
    warn: !contract.signedOn,
  });
  lines.push({
    code: 'contract.value',
    group: 'contract',
    label: 'มูลค่าสัญญาและระยะเวลา',
    detail: `${
      contract.value != null
        ? `${money(contract.value)} ${contract.currency ?? ''}`.trim()
        : 'ไม่ได้ระบุมูลค่า'
    } · ${contract.startOn ?? '—'} ถึง ${contract.endOn ?? '—'}`,
    warn: contract.value == null,
  });
  const installments = baseline.installments ?? [];
  const billed = installments.reduce(
    (sum, row) => sum + (Number(row.amount) || 0),
    0,
  );
  lines.push({
    code: 'contract.installments',
    group: 'contract',
    label: 'แผนงวดวางบิล',
    detail: installments.length
      ? `${installments.length} งวด · รวม ${money(billed)}`
      : 'ไม่มีแผนงวดวางบิล',
    warn: !installments.length,
  });

  // company — the company's own lines, each once
  for (const text of [...new Set(sources.companyLines.map((t) => t.trim()))]) {
    if (!text) continue;
    lines.push({
      code: `company.${text}`,
      group: 'company',
      label: text,
      detail: '',
      warn: false,
    });
  }
  return lines;
}

/**
 * The lines with the manager's verdicts. A verdict stands while the line's
 * detail is the one it was given on; otherwise the line is asked again.
 * Verdicts on lines that no longer exist are dropped.
 */
export function withAnswers(
  lines: readonly IntakeLine[],
  answers: readonly IntakeAnswer[],
): IntakeLineState[] {
  const byCode = new Map(answers.map((answer) => [answer.code, answer]));
  return lines.map((line) => {
    const answer = byCode.get(line.code);
    const current = answer && answer.detail === line.detail ? answer : null;
    return {
      ...line,
      result: current?.result ?? null,
      note: current?.note ?? null,
      by: current?.by ?? null,
      at: current?.at ?? null,
      changed: Boolean(answer) && !current,
    };
  });
}

/** Why the work cannot be received yet — every line not confirmed, named. */
export function acceptProblems(lines: readonly IntakeLineState[]): string[] {
  return lines
    .filter((line) => line.result !== 'ok')
    .map((line) =>
      line.result === 'incomplete'
        ? `ไม่ครบ: ${line.label}`
        : `ยังไม่ได้ตรวจ: ${line.label}`,
    );
}

/** The lines marked incomplete, by the group that answers for them. */
export function gapsByGroup(
  lines: readonly IntakeLineState[],
): Map<IntakeGroup, IntakeLineState[]> {
  const groups = new Map<IntakeGroup, IntakeLineState[]>();
  for (const line of lines) {
    if (line.result !== 'incomplete') continue;
    const list = groups.get(line.group) ?? [];
    list.push(line);
    groups.set(line.group, list);
  }
  return groups;
}

/** One gap as told to the side that answers for it. */
export const gapText = (line: IntakeLineState) =>
  line.note ? `${line.label} — ${line.note}` : line.label;

/** A new verdict replacing any earlier one on the same line. */
export function answer(
  answers: readonly IntakeAnswer[],
  next: IntakeAnswer,
): IntakeAnswer[] {
  return [...answers.filter((row) => row.code !== next.code), next];
}

/** Answers as stored, tolerating anything malformed. */
export function readAnswers(value: unknown): IntakeAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is IntakeAnswer =>
      Boolean(row) &&
      typeof (row as IntakeAnswer).code === 'string' &&
      typeof (row as IntakeAnswer).detail === 'string' &&
      INTAKE_RESULTS.includes((row as IntakeAnswer).result),
  );
}
