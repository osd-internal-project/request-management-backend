/**
 * CD-210 สำรวจหน้างาน — the rules, apart from the database: the Solution's
 * assumptions a survey checks, what a survey needs, and when it may be
 * completed.
 */
export const MAX_SURVEY_TEXT = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SurveyAssumption {
  index: number;
  text: string;
  /** null = not checked yet. */
  holds: boolean | null;
  note: string | null;
  changeRequestId: string | null;
}

/** The Solution's assumptions from the baseline, in their order. */
export function baselineAssumptions(baseline: unknown): string[] {
  const scope = (baseline as { scope?: { assumptions?: unknown } } | null)
    ?.scope;
  const raw: unknown[] = Array.isArray(scope?.assumptions)
    ? scope.assumptions
    : [];
  return raw
    .map((row) =>
      typeof row === 'string'
        ? row
        : row && typeof (row as { text?: unknown }).text === 'string'
          ? (row as { text: string }).text
          : '',
    )
    .map((text) => text.trim())
    .filter(Boolean);
}

/**
 * The survey's answers laid over the baseline's assumptions: answers kept
 * by index, links to change requests never lost.
 */
export function mergeAssumptions(
  texts: readonly string[],
  stored: unknown,
  answers?: readonly { index?: unknown; holds?: unknown; note?: unknown }[],
): SurveyAssumption[] {
  const before = Array.isArray(stored)
    ? (stored as Partial<SurveyAssumption>[])
    : [];
  return texts.map((text, index) => {
    const old = before.find((row) => row.index === index);
    const answer = answers?.find((row) => Number(row.index) === index);
    const holds =
      answer && 'holds' in answer
        ? typeof answer.holds === 'boolean'
          ? answer.holds
          : null
        : (old?.holds ?? null);
    const note =
      answer && 'note' in answer
        ? typeof answer.note === 'string' && answer.note.trim()
          ? answer.note.trim().slice(0, MAX_SURVEY_TEXT)
          : null
        : (old?.note ?? null);
    return {
      index,
      text,
      holds,
      note,
      changeRequestId: old?.changeRequestId ?? null,
    };
  });
}

/** A survey's own problems as it is synced, in Thai. */
export function surveyProblems(input: {
  id: string;
  site: string;
  surveyedOn: string | null;
  latitude: number | null;
  longitude: number | null;
  today: string;
}): string[] {
  const problems: string[] = [];
  if (!UUID.test(input.id))
    problems.push('รหัสการสำรวจต้องเป็น UUID ที่เครื่องสร้าง');
  if (!input.site.trim()) problems.push('ต้องระบุสถานที่สำรวจ');
  if (!input.surveyedOn) problems.push('ต้องระบุวันที่สำรวจ');
  else if (input.surveyedOn > input.today) {
    problems.push('วันที่สำรวจต้องไม่เกินวันนี้');
  }
  if (
    input.latitude !== null &&
    (input.latitude < -90 || input.latitude > 90)
  ) {
    problems.push('ละติจูดไม่ถูกต้อง');
  }
  if (
    input.longitude !== null &&
    (input.longitude < -180 || input.longitude > 180)
  ) {
    problems.push('ลองจิจูดไม่ถูกต้อง');
  }
  return problems;
}

/** What keeps a survey from being completed, in Thai. */
export function completeProblems(assumptions: readonly SurveyAssumption[]) {
  const unchecked = assumptions.filter((row) => row.holds === null);
  const unconverted = assumptions.filter(
    (row) => row.holds === false && !row.changeRequestId,
  );
  const noNote = assumptions.filter((row) => row.holds === false && !row.note);
  return [
    ...(unchecked.length
      ? [
          `ยังไม่ได้ตรวจสมมติฐานข้อ ${unchecked.map((row) => row.index + 1).join(', ')}`,
        ]
      : []),
    ...(noNote.length
      ? [
          `สมมติฐานที่ไม่ตรงต้องบอกว่าไม่ตรงอย่างไร: ข้อ ${noNote.map((row) => row.index + 1).join(', ')}`,
        ]
      : []),
    ...(unconverted.length
      ? [
          `สมมติฐานที่ไม่ตรงต้องแปลงเป็นคำขอเปลี่ยนแปลงก่อน: ข้อ ${unconverted.map((row) => row.index + 1).join(', ')}`,
        ]
      : []),
  ];
}

/** The change request a differing assumption becomes. */
export function changeFromAssumption(input: {
  survey: string;
  site: string;
  text: string;
  note: string;
}) {
  const title = `${input.survey}: สมมติฐานไม่ตรงหน้างาน — ${input.text}`;
  return {
    title: title.length > 255 ? `${title.slice(0, 252)}...` : title,
    reason: `สำรวจหน้างาน ${input.site}: ${input.note}`,
  };
}
