/**
 * CD-188 ติดตามความคืบหน้า — progress worked out from what actually
 * closed, not typed in: the share of the work done (each piece weighted
 * by its working days), the milestones achieved, and where the plan says
 * the work should be by now.
 */
import { isWorkday, type WorkCalendar } from './plan-rules';

/** A reported figure further than this from the computed one needs a reason. */
export const PROGRESS_REASON_THRESHOLD = 10;

export interface WorkPiece {
  durationDays: number;
  status: string;
  /** Planned dates (CD-177), when the plan can be dated. */
  start: string | null;
  finish: string | null;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
/** A point in time still counts for something. */
const weightOf = (piece: WorkPiece) => Math.max(piece.durationDays, 1);

/** Done work over all work, by working days; null with no work planned. */
export function workProgress(pieces: readonly WorkPiece[]): number | null {
  const live = pieces.filter((piece) => piece.status !== 'cancelled');
  const total = live.reduce((sum, piece) => sum + weightOf(piece), 0);
  if (!total) return null;
  const done = live
    .filter((piece) => piece.status === 'done')
    .reduce((sum, piece) => sum + weightOf(piece), 0);
  return round1((done / total) * 100);
}

/** Working days from `start` to `end`, both included. */
export function workdaysBetween(
  start: string,
  end: string,
  calendar: WorkCalendar,
): number {
  let count = 0;
  let day = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  for (let guard = 0; day <= last && guard < 7320; guard++) {
    if (isWorkday(day.toISOString().slice(0, 10), calendar)) count++;
    day = new Date(day.getTime() + 86_400_000);
  }
  return count;
}

/**
 * Where the plan says the work should be by `today`: each piece counts in
 * full once its planned finish has passed, in part while it runs (the
 * working days elapsed of its duration), not at all before it starts.
 */
export function plannedProgress(
  pieces: readonly WorkPiece[],
  today: string,
  calendar: WorkCalendar,
): number | null {
  const live = pieces.filter((piece) => piece.status !== 'cancelled');
  const total = live.reduce((sum, piece) => sum + weightOf(piece), 0);
  if (!total || live.some((piece) => !piece.start || !piece.finish)) {
    return null;
  }
  let due = 0;
  for (const piece of live) {
    if (piece.finish! <= today) {
      due += weightOf(piece);
    } else if (piece.start! <= today) {
      const elapsed = workdaysBetween(piece.start!, today, calendar);
      due += Math.min(elapsed, weightOf(piece));
    }
  }
  return round1((due / total) * 100);
}

/** Achieved milestones over all (cancelled left out); null with none. */
export function milestoneProgress(milestones: readonly { status: string }[]): {
  achieved: number;
  total: number;
  pct: number | null;
} {
  const live = milestones.filter((row) => row.status !== 'cancelled');
  const achieved = live.filter((row) => row.status === 'achieved').length;
  return {
    achieved,
    total: live.length,
    pct: live.length ? round1((achieved / live.length) * 100) : null,
  };
}

/** What stops a reported figure from being recorded, in Thai. */
export function reportedProblems(input: {
  reportedPct: number;
  computedPct: number | null;
  reason: string;
}): string[] {
  const problems: string[] = [];
  if (
    !Number.isFinite(input.reportedPct) ||
    input.reportedPct < 0 ||
    input.reportedPct > 100
  ) {
    problems.push('ความคืบหน้าต้องอยู่ระหว่าง 0 ถึง 100');
  }
  if (
    input.computedPct !== null &&
    Math.abs(input.reportedPct - input.computedPct) >
      PROGRESS_REASON_THRESHOLD &&
    !input.reason.trim()
  ) {
    problems.push(
      `ตัวเลขต่างจากที่ระบบคำนวณ (${input.computedPct}%) เกิน ${PROGRESS_REASON_THRESHOLD} จุด — ต้องระบุเหตุผล`,
    );
  }
  return problems;
}
