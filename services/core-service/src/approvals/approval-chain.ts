import { AppError } from '@request-management/share';

/**
 * The approval positions a matrix tier can name (§8.1). `team_lead` resolves
 * against the org chart; the rest resolve to whoever holds that role in the
 * active company.
 */
export const APPROVER_POSITIONS = ['team_lead', 'cfo', 'ceo'] as const;
export type ApproverPosition = (typeof APPROVER_POSITIONS)[number];

/**
 * One rung of a ladder.
 *
 * Two ways to name an approver, because the organisations using this have both
 * kinds. `org` resolves a position through the chart — the §8.1 behaviour, and
 * the right answer where the chart is maintained. `user` names a person
 * outright, which is what a company with no supervisor data can actually
 * configure today, and what the source's own logs look like: approvals signed
 * by named people in different departments rather than by a fixed office.
 */
export type ApprovalLevel =
  | { readonly resolve: 'org'; readonly position: ApproverPosition }
  | { readonly resolve: 'user'; readonly userId: string };

/**
 * A rung as it may appear in stored `tiers` JSON.
 *
 * The bare string is the original shape and is still written by the seed and by
 * every matrix published before this change. Reading both is what lets an
 * existing company keep working without a data migration — `tiers` is `jsonb`,
 * so there is nothing to migrate *to* except a rewrite of live configuration.
 */
export type StoredApprovalLevel = ApproverPosition | ApprovalLevel;

/** Normalises either stored shape into one thing the resolver understands. */
export function toApprovalLevel(stored: StoredApprovalLevel): ApprovalLevel {
  return typeof stored === 'string'
    ? { resolve: 'org', position: stored }
    : stored;
}

/** One ceiling in an `ApprovalMatrix.tiers` array. */
export interface MatrixTier {
  /** Decimal string; `null` is the top tier (no ceiling). */
  readonly upto: string | null;
  readonly chain: readonly StoredApprovalLevel[];
}

/** How a rung was turned into a person. */
export interface ResolvedApprover {
  /** `named` when the matrix pointed at a person rather than at a position. */
  readonly position: ApproverPosition | 'named';
  readonly userId: string | null;
}

/**
 * Picks the first tier whose ceiling the amount does not exceed.
 *
 * Tiers are compared as decimal strings via `Number` — amounts here are
 * currency values well inside the exact-integer range, and the matrix is
 * authored by hand with round ceilings.
 */
export function selectTier(
  tiers: readonly MatrixTier[],
  amount: string | null,
): MatrixTier {
  if (!tiers.length) {
    throw new AppError(
      'APV_MATRIX_NOT_FOUND',
      'ยังไม่ได้ตั้งค่าตารางอำนาจอนุมัติของบริษัทและประเภทงานนี้',
    );
  }

  // No monetary dimension (e.g. lead handover) uses the lowest tier — §8.1's
  // "requests with no amount use step 1 only".
  if (amount === null) return tiers[0];

  const value = Number(amount);
  const tier = tiers.find(
    (candidate) => candidate.upto === null || value <= Number(candidate.upto),
  );

  return tier ?? tiers[tiers.length - 1];
}

/**
 * The amount a request must exceed before this position joins the chain.
 *
 * §16 หน้าที่ 3 explains an absent approver rather than leaving a gap — "CEO
 * ไม่อยู่ในเส้นทาง — วงเงินไม่เกินเพดานระดับ 2 (1,000,000 บาท)". That number is
 * the ceiling of the tier *below* the first one this position appears in.
 *
 * `null` means the position never appears in this ladder at all, which is a
 * different statement and must not be shown as a threshold of zero.
 */
export function ceilingIntroducing(
  tiers: readonly MatrixTier[],
  position: ApproverPosition,
): string | null {
  const index = tiers.findIndex((tier) => tier.chain.includes(position));

  if (index <= 0) return null;

  return tiers[index - 1]?.upto ?? null;
}

/**
 * APV-02: turns a tier's chain into concrete approvers, then drops any step
 * the requester would be approving for themselves.
 *
 * That last rule is the subtle one. §8.1: a team lead who raises the request
 * starts at *their own* supervisor, and a CFO or CEO raising one has their own
 * level skipped. Steps shift up rather than being left empty, so a request
 * never waits on somebody to approve their own submission.
 *
 * @param roleHolders Who currently holds each position in the active company.
 * @param supervisorOf Walks the org chart upward from the requester.
 */
export function resolveChain(input: {
  chain: readonly StoredApprovalLevel[];
  requesterId: string;
  requesterSupervisorId: string | null;
  roleHolders: Readonly<Partial<Record<ApproverPosition, string>>>;
  supervisorOf: (userId: string) => string | null;
}): ResolvedApprover[] {
  const resolved: ResolvedApprover[] = [];

  for (const stored of input.chain) {
    const level = toApprovalLevel(stored);

    /*
      A rung naming a person needs no chart at all — that is the point of it.
      The self-approval rule still applies: a step whose named approver is the
      requester is dropped rather than handed to them, exactly as a named
      office is.
    */
    if (level.resolve === 'user') {
      if (level.userId === input.requesterId) continue;
      resolved.push({ position: 'named', userId: level.userId });
      continue;
    }

    const position = level.position;

    let userId: string | null =
      position === 'team_lead'
        ? input.requesterSupervisorId
        : (input.roleHolders[position] ?? null);

    // The requester cannot approve their own request: for team_lead, climb to
    // the next supervisor up; for a named office, skip the step entirely.
    if (userId === input.requesterId) {
      userId = position === 'team_lead' ? input.supervisorOf(userId) : null;
      if (userId === null && position !== 'team_lead') continue;
    }

    resolved.push({ position, userId });
  }

  return resolved;
}

/**
 * §8.1: a request whose author has no supervisor in the org chart cannot be
 * submitted — there would be nobody to perform the step-1 eligibility check.
 * Surfaced as `ORG_SUPERVISOR_MISSING` so the UI can tell the user to contact
 * an admin rather than showing a generic failure.
 */
export function assertStepOneResolvable(
  chain: readonly ResolvedApprover[],
): void {
  const first = chain[0];

  if (!first || first.userId === null) {
    throw new AppError(
      'ORG_SUPERVISOR_MISSING',
      'ยังไม่มีหัวหน้าในผังทีม กรุณาติดต่อผู้ดูแลระบบ',
      [{ field: 'supervisor_user_id', reason: 'not assigned' }],
    );
  }
}
