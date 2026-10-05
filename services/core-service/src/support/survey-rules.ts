import { createHash, randomBytes } from 'node:crypto';

/**
 * CD-248 ความพึงพอใจหลังปิดงานบริการ — the pure part: the link's secret, what
 * an answer must be, a survey's state, a low score, and the team's figures.
 */

export const SURVEY_DAYS = 14;
/** Overall at or below this tells the account owner to follow up. */
export const LOW_SCORE = 2;
const DAY_MS = 86_400_000;

/** A fresh secret for the link; only its hash is kept. */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('base64url');
  return { token, hash: tokenHash(token) };
}

export function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function expiryFrom(at: Date) {
  return new Date(at.getTime() + SURVEY_DAYS * DAY_MS);
}

export function surveyState(
  row: { answeredAt: Date | null; expiresAt: Date },
  now: Date,
): 'answered' | 'expired' | 'open' {
  if (row.answeredAt) return 'answered';
  return row.expiresAt <= now ? 'expired' : 'open';
}

export interface SurveyAnswer {
  overall: number;
  speed?: number | null;
  technician?: number | null;
  outcome?: number | null;
  comment?: string | null;
}

const score = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;

export function answerProblems(answer: SurveyAnswer): string[] {
  const problems: string[] = [];
  if (!score(answer.overall))
    problems.push('กรุณาให้คะแนนความพึงพอใจโดยรวม 1–5');
  for (const key of ['speed', 'technician', 'outcome'] as const) {
    const value = answer[key];
    if (value !== undefined && value !== null && !score(value)) {
      problems.push('คะแนนต้องอยู่ระหว่าง 1–5');
      break;
    }
  }
  if ((answer.comment ?? '').length > 2000) {
    problems.push('ความเห็นยาวเกิน 2,000 ตัวอักษร');
  }
  return problems;
}

export const isLow = (overall: number) => overall <= LOW_SCORE;

export interface SurveyFact {
  sentAt: Date | null;
  answeredAt: Date | null;
  overall: number | null;
  speed: number | null;
  technician: number | null;
  outcome: number | null;
  assigneeUserId: string | null;
  month: string;
}

const avg = (values: number[]) =>
  values.length
    ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10
    : null;

/** Response rate and averages, overall and per aspect. */
export function surveyFigures(rows: readonly SurveyFact[]) {
  const sent = rows.length;
  const answered = rows.filter((row) => row.answeredAt && row.overall !== null);
  const pick = (key: 'overall' | 'speed' | 'technician' | 'outcome') =>
    avg(
      answered
        .map((row) => row[key])
        .filter((value): value is number => value !== null),
    );
  return {
    sent,
    answered: answered.length,
    responsePct: sent ? Math.round((answered.length / sent) * 1000) / 10 : null,
    overall: pick('overall'),
    speed: pick('speed'),
    technician: pick('technician'),
    outcome: pick('outcome'),
    low: answered.filter((row) => isLow(row.overall!)).length,
  };
}

/** The same figures grouped (by month, or by technician). */
export function groupFigures(
  rows: readonly SurveyFact[],
  keyOf: (row: SurveyFact) => string | null,
) {
  const groups = new Map<string, SurveyFact[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, list]) => ({ key, ...surveyFigures(list) }));
}
