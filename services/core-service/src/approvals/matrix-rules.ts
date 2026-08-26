import { AppError } from '@request-management/share';
import {
  APPROVER_POSITIONS,
  ApproverPosition,
  MatrixTier,
} from './approval-chain';

/**
 * APV-01: validates a tier ladder before it is published.
 *
 * Takes `unknown` rather than `MatrixTier[]` on purpose — this runs against
 * data arriving as JSON from an admin screen, so claiming it is already the
 * right shape would defeat the check. Narrowing happens here, explicitly.
 *
 * Publishing is the last moment a malformed ladder can be caught. It does not
 * fail loudly later; it fails as a request that routes to nobody or skips a
 * ceiling, by which point the matrix looks authoritative and the bug looks
 * like an approval mystery.
 *
 * The rules, all from §8.1:
 *
 * - at least one tier, or nothing can be approved
 * - ceilings strictly ascending, since `selectTier` takes the *first* tier the
 *   amount fits and an out-of-order ladder silently makes later tiers dead
 * - exactly one open-ended tier (`upto: null`) and it must be last, or an
 *   amount above the highest ceiling has nowhere to go
 * - every position drawn from `APPROVER_POSITIONS`
 * - every chain starts at `team_lead` — step 1 is always the requester's
 *   supervisor, on every request
 */
export function assertValidTiers(
  tiers: unknown,
): asserts tiers is MatrixTier[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw invalid('tiers', 'ต้องมีอย่างน้อยหนึ่งชั้นอำนาจอนุมัติ');
  }

  const candidates: unknown[] = tiers;
  let previous = Number.NEGATIVE_INFINITY;

  candidates.forEach((candidate, index) => {
    const last = index === candidates.length - 1;
    const tier = asRecord(candidate);

    if (!tier) {
      throw invalid(`tiers[${index}]`, 'รูปแบบไม่ถูกต้อง');
    }

    assertChain(tier.chain, index);
    previous = assertCeiling(tier.upto, index, last, previous);
  });
}

function assertChain(value: unknown, index: number): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalid(
      `tiers[${index}].chain`,
      'ต้องระบุผู้อนุมัติอย่างน้อยหนึ่งตำแหน่ง',
    );
  }

  const positions: unknown[] = value;

  for (const position of positions) {
    if (
      typeof position !== 'string' ||
      !APPROVER_POSITIONS.includes(position as ApproverPosition)
    ) {
      throw invalid(
        `tiers[${index}].chain`,
        `ตำแหน่งผู้อนุมัติไม่ถูกต้อง: ${String(position)}`,
      );
    }
  }

  if (positions[0] !== 'team_lead') {
    throw invalid(
      `tiers[${index}].chain`,
      'ชั้นแรกต้องเป็น team_lead เสมอ (§8.1)',
    );
  }
}

/** Returns the ceiling, so the caller can check the next one is higher. */
function assertCeiling(
  value: unknown,
  index: number,
  last: boolean,
  previous: number,
): number {
  if (value === null || value === undefined) {
    if (!last) {
      throw invalid(
        `tiers[${index}].upto`,
        'ชั้นที่ไม่มีเพดานต้องเป็นชั้นสุดท้าย',
      );
    }
    return previous;
  }

  const ceiling = Number(value);

  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    throw invalid(`tiers[${index}].upto`, 'เพดานต้องเป็นตัวเลขมากกว่าศูนย์');
  }

  if (ceiling <= previous) {
    throw invalid(`tiers[${index}].upto`, 'เพดานต้องเรียงจากน้อยไปมาก');
  }

  if (last) {
    throw invalid(
      `tiers[${index}].upto`,
      'ต้องมีชั้นสุดท้ายที่ไม่มีเพดาน (upto: null)',
    );
  }

  return ceiling;
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
