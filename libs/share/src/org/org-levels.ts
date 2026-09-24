/**
 * The shape of the org chart: five levels, each hanging directly off the one
 * above it.
 *
 *   บริษัท → ฝ่าย → แผนก → ทีม → ตำแหน่ง
 *
 * **This file is the authority on the order, not the `OrgUnitKind` enum.** The
 * enum lists the same five values, but `TEAM` sits last in it — it predates
 * `DIVISION` and `POSITION`, which were appended as the chart grew, and
 * Postgres cannot reorder an enum without swapping the whole type. Nothing
 * reads the enum's own order, so the ranking lives here instead, where it is
 * one array and a unit test rather than a migration.
 *
 * Two rules follow from the order, and both are enforced in `OrgService`:
 *
 *   1. **No level may be skipped.** A unit's parent is the level immediately
 *      above it, and a unit with no parent is a `COMPANY`. A chart that skips
 *      ฝ่าย for one branch and not another makes "the department above this
 *      person" mean different things in different places, which is exactly
 *      what approval step 1 and data scope walk.
 *   2. **People sit at แผนก or below.** ทีม and ตำแหน่ง are optional — somebody
 *      whose chart stops at their department is correctly placed. Nobody sits
 *      on a บริษัท or ฝ่าย, because a unit that holds both people and
 *      sub-departments has no answer to "who is my supervisor".
 *
 * Charts predating these rules are left alone; see `OrgService` for why the
 * checks run on write only.
 */
import { OrgUnitKind } from '@prisma/client';

/** Widest first. The index in this array *is* the level. */
export const ORG_UNIT_LEVELS = [
  'COMPANY',
  'DIVISION',
  'DEPARTMENT',
  'TEAM',
  'POSITION',
] as const satisfies readonly OrgUnitKind[];

/** The shallowest level a person may be placed in. */
const MEMBER_LEVEL_FROM: OrgUnitKind = 'DEPARTMENT';

/** The levels a user may be assigned to, widest first. */
export const MEMBER_LEVELS: readonly OrgUnitKind[] = ORG_UNIT_LEVELS.slice(
  ORG_UNIT_LEVELS.indexOf(MEMBER_LEVEL_FROM),
);

/** How deep a level sits, `COMPANY` being 0. */
export function orgLevelIndex(kind: OrgUnitKind): number {
  return ORG_UNIT_LEVELS.indexOf(kind);
}

/** The level a unit of this kind must hang under, `null` for the root level. */
export function parentKindOf(kind: OrgUnitKind): OrgUnitKind | null {
  const index = orgLevelIndex(kind);
  return index > 0 ? ORG_UNIT_LEVELS[index - 1] : null;
}

/** The only level allowed directly under this one, `null` at the deepest. */
export function childKindOf(kind: OrgUnitKind): OrgUnitKind | null {
  const index = orgLevelIndex(kind);
  return index >= 0 && index < ORG_UNIT_LEVELS.length - 1
    ? ORG_UNIT_LEVELS[index + 1]
    : null;
}

/** Whether a unit of this kind may hold people. */
export function canHoldMembers(kind: OrgUnitKind): boolean {
  return orgLevelIndex(kind) >= orgLevelIndex(MEMBER_LEVEL_FROM);
}

/**
 * Whether `kind` may hang directly under `parentKind` — or, with no parent,
 * whether it may stand as a root.
 */
export function isValidChildOf(
  kind: OrgUnitKind,
  parentKind: OrgUnitKind | null,
): boolean {
  return parentKindOf(kind) === parentKind;
}
