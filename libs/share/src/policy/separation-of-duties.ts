import { AppError } from '../errors';
import { Permission } from './permissions';

/**
 * Permissions a configuration role must never also hold (§5.4, guardrail 1).
 *
 * Approving is deciding on the business; reading margin is seeing the
 * commercial position. Someone who can rewrite the approval matrix and the
 * role table must not also be able to approve under it — otherwise a single
 * account can grant itself authority and then exercise it, and the audit trail
 * records both steps as legitimate.
 */
const FORBIDDEN_WITH_ADMIN: readonly Permission[] = [
  'approval.decide',
  'request.sensitive.read',
];

function isAdminPermission(permission: string): boolean {
  return permission.startsWith('admin.');
}

/**
 * Rejects a permission set that gives one role both configuration authority
 * and the authority it configures.
 *
 * Enforced here rather than in the admin screen because hiding a checkbox is a
 * convenience, not a control (§3) — the rule has to hold for a direct API call
 * too, including the one an admin makes for their own role.
 *
 * @param permissions the complete set the role would hold after the change
 * @throws AppError `UNPROCESSABLE` naming the conflicting permission
 */
export function assertSeparationOfDuties(permissions: readonly string[]): void {
  if (!permissions.some(isAdminPermission)) return;

  const conflict = FORBIDDEN_WITH_ADMIN.find((forbidden) =>
    permissions.includes(forbidden),
  );

  if (!conflict) return;

  // 422 rather than 400: the request is well formed and every permission in it
  // is real — it is the combination the rules refuse.
  throw new AppError(
    'UNPROCESSABLE',
    `ขัด guardrail แยกหน้าที่ (§5.4): role ที่มีสิทธิ์ admin.* ถือ ${conflict} ไม่ได้`,
  );
}
