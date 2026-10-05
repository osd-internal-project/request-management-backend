/**
 * CD-189 เตรียมการตรวจรับ — the rules, apart from the database: when an
 * acceptance may be booked, what a result needs, and where its open points
 * stand.
 */

export const ACCEPTANCE_RESULTS = [
  'accepted',
  'conditional',
  'rejected',
] as const;
export type AcceptanceResult = (typeof ACCEPTANCE_RESULTS)[number];
export const MAX_ACCEPTANCE_ITEMS = 50;
export const MAX_ACCEPTANCE_TEXT = 2000;

/** What stops a round from being booked, in Thai. */
export function bookProblems(input: {
  ready: boolean;
  blockers: readonly string[];
  scheduledAt: Date | null;
  now: Date;
  /** Another round still booked for the same milestone (or the project). */
  openRound: string | null;
  milestoneStatus: string | null;
}): string[] {
  const problems: string[] = [];
  if (!input.ready) {
    problems.push(
      `ยังนัดตรวจรับไม่ได้ — ตรวจความพร้อมยังไม่ผ่าน: ${input.blockers.join(' · ')}`,
    );
  }
  if (!input.scheduledAt || Number.isNaN(input.scheduledAt.getTime())) {
    problems.push('ต้องระบุวันเวลานัดตรวจรับ');
  } else if (input.scheduledAt.getTime() < input.now.getTime()) {
    problems.push('วันเวลานัดต้องไม่อยู่ในอดีต');
  }
  if (input.openRound) {
    problems.push(`มีนัดตรวจรับที่ยังไม่บันทึกผลอยู่แล้ว (${input.openRound})`);
  }
  if (input.milestoneStatus && input.milestoneStatus !== 'planned') {
    problems.push('milestone นี้บรรลุหรือยกเลิกไปแล้ว');
  }
  return problems;
}

export interface ResultInput {
  result: string;
  decidedOn: string | null;
  note: string;
  hasCertificate: boolean;
  /** CD-252 — signed electronically afterwards: nothing to attach now. */
  certificateViaEsign?: boolean;
  items: readonly { text: string; dueOn: string | null }[];
  today: string;
}

/** What a result needs, in Thai. */
export function resultProblems(input: ResultInput): string[] {
  const problems: string[] = [];
  if (!(ACCEPTANCE_RESULTS as readonly string[]).includes(input.result)) {
    problems.push('ผลตรวจรับต้องเป็น ผ่าน ผ่านแบบมีเงื่อนไข หรือไม่ผ่าน');
  }
  if (!input.decidedOn) problems.push('ต้องระบุวันที่ตรวจรับ');
  else if (input.decidedOn > input.today) {
    problems.push('วันที่ตรวจรับต้องไม่เกินวันนี้');
  }
  if (
    (input.result === 'accepted' || input.result === 'conditional') &&
    !input.hasCertificate &&
    !input.certificateViaEsign
  ) {
    problems.push('ต้องแนบใบตรวจรับที่ลูกค้าลงนามแล้ว');
  }
  if (input.result === 'conditional' && !input.items.length) {
    problems.push('ผ่านแบบมีเงื่อนไข: ต้องระบุรายการค้างอย่างน้อย 1 ข้อ');
  }
  if (input.result === 'rejected' && !input.note.trim()) {
    problems.push('ไม่ผ่าน: ต้องระบุเหตุผล');
  }
  if (input.items.length > MAX_ACCEPTANCE_ITEMS) {
    problems.push(`รายการค้างได้ไม่เกิน ${MAX_ACCEPTANCE_ITEMS} ข้อ`);
  }
  input.items.forEach((item, index) => {
    if (!item.text.trim())
      problems.push(`รายการค้างข้อ ${index + 1}: ต้องระบุ`);
    if (!item.dueOn) {
      problems.push(`รายการค้างข้อ ${index + 1}: ต้องระบุวันแก้ไข`);
    }
  });
  return problems;
}

/** A round's open points: how many, how many late. */
export function followUp(
  items: readonly { status: string; dueOn: string }[],
  today: string,
) {
  const open = items.filter((item) => item.status === 'open');
  return {
    open: open.length,
    overdue: open.filter((item) => item.dueOn < today).length,
    closed: open.length === 0,
  };
}

/** The milestone's criteria, all met by the customer's acceptance. */
export function criteriaAccepted(
  criteria: readonly {
    text: string;
    met: boolean;
    metAt?: string | null;
    metBy?: string | null;
  }[],
  by: string,
  at: string,
) {
  return criteria.map((criterion) =>
    criterion.met
      ? criterion
      : { ...criterion, met: true, metAt: at, metBy: by },
  );
}
