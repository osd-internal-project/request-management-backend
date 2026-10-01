/**
 * CD-200 — markup rules, pure so they are tested on their own. A rule's empty
 * condition matches anything; the lowest priority number wins, and a tie
 * goes to the rule naming more conditions.
 */
import { WORK_TYPES, type WorkType } from '../crm/quotation-math';

export { WORK_TYPES, type WorkType };

export interface MarkupRuleState {
  id: string;
  priority: number;
  workType: string | null;
  productGroupCode: string | null;
  segmentValueId: string | null;
  markupPct: number;
  active: boolean;
}

export interface MarkupContext {
  workType?: string | null;
  groupCode?: string | null;
  /** Segment values the deal's customer sits in. */
  segmentValueIds: readonly string[];
}

const specificity = (rule: MarkupRuleState) =>
  [rule.workType, rule.productGroupCode, rule.segmentValueId].filter(
    (value) => value !== null,
  ).length;

export function pickMarkup<T extends MarkupRuleState>(
  rules: readonly T[],
  context: MarkupContext,
): T | null {
  const matching = rules.filter(
    (rule) =>
      rule.active &&
      (rule.workType === null || rule.workType === context.workType) &&
      (rule.productGroupCode === null ||
        rule.productGroupCode === context.groupCode) &&
      (rule.segmentValueId === null ||
        context.segmentValueIds.includes(rule.segmentValueId)),
  );
  return (
    matching.sort(
      (a, b) =>
        a.priority - b.priority ||
        specificity(b) - specificity(a) ||
        a.id.localeCompare(b.id),
    )[0] ?? null
  );
}

export const MAX_MARKUP_PCT = 1000;

export interface MarkupInput {
  priority?: unknown;
  workType?: unknown;
  productGroupCode?: unknown;
  segmentValueId?: unknown;
  markupPct?: unknown;
  note?: unknown;
  active?: unknown;
}

export interface CleanMarkup {
  priority: number;
  workType: WorkType | null;
  productGroupCode: string | null;
  segmentValueId: string | null;
  markupPct: number;
  note: string;
  active: boolean;
}

const optional = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function cleanMarkup(
  input: MarkupInput,
):
  | { ok: true; value: CleanMarkup }
  | { ok: false; problems: { field: string; reason: string }[] } {
  const problems: { field: string; reason: string }[] = [];
  const priority = input.priority ?? 100;
  if (
    typeof priority !== 'number' ||
    !Number.isInteger(priority) ||
    priority < 0 ||
    priority > 10_000
  ) {
    problems.push({ field: 'priority', reason: 'invalid' });
  }
  const workType = optional(input.workType);
  if (workType !== null && !WORK_TYPES.includes(workType as WorkType)) {
    problems.push({ field: 'work_type', reason: 'invalid' });
  }
  const pct = input.markupPct;
  if (
    typeof pct !== 'number' ||
    !Number.isFinite(pct) ||
    pct < 0 ||
    pct > MAX_MARKUP_PCT
  ) {
    problems.push({ field: 'markup_pct', reason: 'invalid' });
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 500) problems.push({ field: 'note', reason: 'too_long' });
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    value: {
      priority: priority as number,
      workType: workType as WorkType | null,
      productGroupCode: optional(input.productGroupCode),
      segmentValueId: optional(input.segmentValueId),
      markupPct: Math.round((pct as number) * 100) / 100,
      note,
      active: input.active === undefined ? true : Boolean(input.active),
    },
  };
}
