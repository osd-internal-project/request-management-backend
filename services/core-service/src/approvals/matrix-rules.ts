import { AppError } from '@request-management/share';
import type { MatrixLevel } from '../access/access.service';

/**
 * APV-01: validates an approval ladder before it is published.
 *
 * **Declared amendment to §8.1 and APV-01, 31 Aug 2026.** The specification
 * describes a matrix of amount ceilings — team lead below T1, CFO above it,
 * CEO above T2 — and this file used to enforce exactly that. The ladder is now
 * a list of *levels* with no amounts in it at all.
 *
 * Why, stated rather than done quietly:
 *
 *   - **T1 and T2 were never confirmed.** They are still open question A,
 *     unanswered by Finance since 24 Aug 2026, and every environment has been
 *     running placeholder numbers that nobody agreed to.
 *   - **The positions were fixed at three.** `team_lead`, `cfo`, `ceo` is not
 *     how the departments approve: they route to the head of a named group, or
 *     to a named person, and neither had any way to be expressed.
 *   - **A level can be several people.** Two group heads, or a list chosen on
 *     screen A1, any one of whom may decide.
 *
 * What replaced each ceiling rule is below. Versions published before the
 * change keep their `tiers` and are still read by `planChain`; nothing in
 * flight is re-judged (§7 — running work keeps the rules it started under).
 *
 * Takes `unknown` on purpose: this runs against JSON from an admin screen, so
 * claiming it is already the right shape would defeat the check. Publishing is
 * the last moment a malformed ladder can be caught — after it, the failure is
 * a request that routes to nobody, which looks like an approval mystery rather
 * than a configuration error.
 *
 * The rules:
 *
 * - at least one level, or nothing can be approved
 * - every level is `supervisor` or `org`, and nothing else
 * - `supervisor.up` is a whole number ≥ 1 — which level of the chart above the
 *   requester, `1` being the head of the group they sit in
 * - an `org` level names at least one group; naming none would resolve to
 *   nobody on every request, which is a ladder that cannot be climbed
 */
export function assertValidLevels(
  levels: unknown,
): asserts levels is MatrixLevel[] {
  if (!Array.isArray(levels) || levels.length === 0) {
    throw invalid('levels', 'ต้องมีอย่างน้อยหนึ่งชั้นอำนาจอนุมัติ');
  }

  const candidates: unknown[] = levels;

  candidates.forEach((candidate, index) => {
    const level = asRecord(candidate);

    if (!level) {
      throw invalid(`levels[${index}]`, 'รูปแบบไม่ถูกต้อง');
    }

    assertLevelOptions(level, index);

    if (level.type === 'supervisor') {
      assertUp(level.up, index);
      return;
    }

    if (level.type === 'org') {
      assertOrgLevel(level, index);
      return;
    }

    throw invalid(
      `levels[${index}].type`,
      'ชนิดของชั้นต้องเป็น supervisor หรือ org',
    );
  });
}

const CONDITION_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'in'];

/** mode / noteRequired / condition / slaHours — each optional, each checked when present. */
function assertLevelOptions(
  level: Record<string, unknown>,
  index: number,
): void {
  const at = (key: string) => `levels[${index}].${key}`;

  if (
    level.mode !== undefined &&
    level.mode !== 'any' &&
    level.mode !== 'all'
  ) {
    throw invalid(at('mode'), 'ต้องเป็น any หรือ all');
  }
  if (
    level.noteRequired !== undefined &&
    level.noteRequired !== 'always' &&
    level.noteRequired !== 'reject_or_return'
  ) {
    throw invalid(at('noteRequired'), 'ต้องเป็น always หรือ reject_or_return');
  }
  if (
    level.slaHours !== undefined &&
    (typeof level.slaHours !== 'number' ||
      !Number.isInteger(level.slaHours) ||
      level.slaHours < 1)
  ) {
    throw invalid(at('slaHours'), 'ต้องเป็นจำนวนชั่วโมงเต็มตั้งแต่ 1');
  }
  if (
    level.chartOf !== undefined &&
    level.chartOf !== 'requester' &&
    level.chartOf !== 'worker'
  ) {
    throw invalid(at('chartOf'), 'ต้องเป็น requester หรือ worker');
  }
  if (level.condition !== undefined) {
    const condition = asRecord(level.condition);
    if (
      !condition ||
      typeof condition.field !== 'string' ||
      !condition.field ||
      !CONDITION_OPS.includes(String(condition.op)) ||
      condition.value === undefined
    ) {
      throw invalid(at('condition'), 'เงื่อนไขต้องมี field, op และ value');
    }
  }
}

/** Condition fields a ladder names that the request type's form does not ask for. */
export function unknownConditionFields(
  levels: readonly MatrixLevel[],
  knownFields: readonly string[],
): string[] {
  return levels
    .map((level) => level.condition?.field)
    .filter((field): field is string => typeof field === 'string')
    .filter((field) => !knownFields.includes(field));
}

function assertUp(value: unknown, index: number): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw invalid(
      `levels[${index}].up`,
      'ระดับหัวหน้าต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป',
    );
  }
}

function assertOrgLevel(level: Record<string, unknown>, index: number): void {
  const units = level.orgUnitIds;

  if (!Array.isArray(units) || units.length === 0) {
    throw invalid(
      `levels[${index}].orgUnitIds`,
      'ต้องเลือกหน่วยงานอย่างน้อยหนึ่งหน่วย',
    );
  }

  if (!units.every((unit) => typeof unit === 'string' && unit.length > 0)) {
    throw invalid(`levels[${index}].orgUnitIds`, 'รหัสหน่วยงานไม่ถูกต้อง');
  }

  const users = level.userIds;
  if (users === undefined || users === null) return;

  if (
    !Array.isArray(users) ||
    !users.every((user) => typeof user === 'string' && user.length > 0)
  ) {
    throw invalid(`levels[${index}].userIds`, 'รหัสผู้ใช้ไม่ถูกต้อง');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalid(field: string, reason: string): AppError {
  return new AppError('VALIDATION_FAILED', 'ตารางอำนาจอนุมัติไม่ถูกต้อง', [
    { field, reason },
  ]);
}
