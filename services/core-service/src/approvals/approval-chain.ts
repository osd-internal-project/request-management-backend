import { AppError } from '@request-management/share';

/**
 * The step list an approval case is opened from.
 *
 * **The amount machinery is gone (31 Aug 2026).** This file used to hold the
 * §8.1 ladder: three fixed positions (`team_lead` / `cfo` / `ceo`), a tier
 * selected by comparing the request's amount against a ceiling, and a resolver
 * that walked the org chart looking for each position. All of it went with the
 * ceilings — see the declared amendment in §8 of
 * `docs/ctd-foundation-spec.md`, the publish rules in `matrix-rules.ts`, and
 * the resolution itself in `access.service.ts`.
 *
 * What is left is the shape a resolved ladder has, and the one rule about it
 * that cannot be expressed as data.
 */

/** How a level of the ladder was turned into people. */
export interface ResolvedApprover {
  /**
   * What the ladder said, for display and for the history: `supervisor:N` or
   * `org`. Stored on `ApprovalStep.approverRole`.
   */
  readonly position: string;
  /** The first candidate — what `ApprovalStep.approverUserId` keeps. */
  readonly userId: string | null;
  /**
   * Everyone allowed to decide this step; any one of them is enough.
   *
   * A level can name several people — the heads of two groups, or a list
   * chosen on screen A1 — which the three fixed positions never could.
   */
  readonly candidateUserIds: readonly string[];
  /** The level's rules, copied onto the step (see `LevelOptions`). */
  readonly mode?: 'any' | 'all';
  readonly noteRequired?: 'always' | 'reject_or_return';
  readonly slaHours?: number | null;
  /** Set when the level is recorded but never asked. */
  readonly skipReason?: 'condition' | 'same_approver' | null;
}

/**
 * §8.1: a request whose ladder resolves to nobody at step 1 cannot be
 * submitted — there would be nobody to perform the first check.
 *
 * Surfaced as `ORG_SUPERVISOR_MISSING` so the UI can say "there is no head
 * above you in the chart, ask an admin" rather than showing a generic failure.
 * The message still names the chart because that is what is actually missing:
 * a `supervisor` level ran out of groups to climb, or an `org` level named
 * groups nobody heads.
 */
export function assertStepOneResolvable(
  chain: readonly ResolvedApprover[],
): void {
  // Every level skipped by its condition means nothing to approve, not a missing head.
  if (chain.length && chain.every((step) => step.skipReason)) return;

  const first = chain.find((step) => !step.skipReason);

  if (!first || !first.candidateUserIds.length) {
    throw new AppError(
      'ORG_SUPERVISOR_MISSING',
      'ยังไม่มีหัวหน้าในผังทีม กรุณาติดต่อผู้ดูแลระบบ',
      [{ field: 'supervisor_user_id', reason: 'not assigned' }],
    );
  }
}
