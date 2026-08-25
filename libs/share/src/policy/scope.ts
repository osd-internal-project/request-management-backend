import { AppError } from '../errors/app-error';

/**
 * How much of a resource a role may see — CTD spec §6.1. Orthogonal to
 * permissions: two people with identical permissions can see different rows.
 */
export const SCOPE_LEVELS = [
  'own',
  'team',
  'department',
  'company',
  'all',
] as const;

export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export function isScopeLevel(value: unknown): value is ScopeLevel {
  return (
    typeof value === 'string' && SCOPE_LEVELS.includes(value as ScopeLevel)
  );
}

/**
 * Which columns on a given table carry ownership, org placement, and company.
 * Names differ per resource, so each caller declares its own mapping.
 */
export interface ScopeColumns {
  /** Column holding the owning user's id, e.g. `requesterId`. */
  readonly owner: string;
  /** Column holding the owner's org unit id at the time of writing. */
  readonly orgUnit: string;
  /** Column holding the owning company id. */
  readonly company: string;
}

/**
 * Everything about the caller that scope resolution needs. The org-unit id
 * sets are read from `OrgClosure`, precomputed on org edits so a list query
 * never walks the tree (§6.2 note).
 */
export interface ScopeSubject {
  readonly userId: string;
  readonly activeCompanyId: string;
  /** The caller's own org unit plus every unit beneath it. */
  readonly teamOrgUnitIds: readonly string[];
  /** The caller's department subtree. */
  readonly departmentOrgUnitIds: readonly string[];
}

/** A Prisma `where` fragment. Shape is per-model, so this stays open. */
export type ScopeWhere = Record<string, unknown>;

/**
 * Translates a scope level into the `where` fragment that enforces it.
 *
 * SCOPE-02 requires this to be the *only* place row visibility is decided —
 * lists, single reads, and dashboard counts all pass through here, which is
 * what keeps a summary number and the rows behind it in agreement.
 *
 * SCOPE-03 makes the company boundary absolute: every level except `all`
 * pins `companyId` to the active company, so "forgot to filter by company"
 * cannot happen by omission.
 *
 * @param involved Optional extra predicate OR-ed onto the result, for
 *   per-record relatedness (SCOPE-06: an approver in the chain sees the
 *   request even when it sits outside their normal scope).
 */
export function buildScopeWhere(
  scope: ScopeLevel,
  columns: ScopeColumns,
  subject: ScopeSubject,
  involved?: ScopeWhere,
): ScopeWhere {
  const base = scopeClause(scope, columns, subject);

  if (!involved) return base;
  if (scope === 'all') return base;

  return { OR: [base, { ...involved, [columns.company]: undefined }] };
}

function scopeClause(
  scope: ScopeLevel,
  columns: ScopeColumns,
  subject: ScopeSubject,
): ScopeWhere {
  const company = { [columns.company]: subject.activeCompanyId };

  switch (scope) {
    case 'own':
      return { ...company, [columns.owner]: subject.userId };

    case 'team':
      return { ...company, [columns.orgUnit]: { in: subject.teamOrgUnitIds } };

    case 'department':
      return {
        ...company,
        [columns.orgUnit]: { in: subject.departmentOrgUnitIds },
      };

    case 'company':
      return company;

    case 'all':
      // Reserved for group executives and auditors — the only level that
      // crosses the company boundary.
      return {};

    default: {
      // Exhaustiveness guard: a new level must be handled explicitly rather
      // than silently widening what a caller can see.
      const unreachable: never = scope;
      throw new AppError(
        'UNKNOWN',
        `Unhandled scope level: ${String(unreachable)}`,
      );
    }
  }
}
