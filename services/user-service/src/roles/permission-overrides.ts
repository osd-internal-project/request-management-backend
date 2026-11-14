import type { Permission } from '@request-management/share';
import type { PermissionEffect } from '@prisma/client';

export interface OverrideLike {
  readonly permissionCode: string;
  readonly effect: PermissionEffect;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
}

export function isLive(override: OverrideLike, now: Date): boolean {
  return (
    override.revokedAt === null &&
    (override.expiresAt === null || override.expiresAt > now)
  );
}

/** P7: what a person holds in one company = (roles ∪ live GRANT) − live REVOKE. */
export function applyOverrides(
  fromRoles: readonly Permission[],
  overrides: readonly OverrideLike[],
  now: Date,
): Permission[] {
  const held = new Set<string>(fromRoles);
  const live = overrides.filter((override) => isLive(override, now));
  for (const o of live) if (o.effect === 'GRANT') held.add(o.permissionCode);
  for (const o of live)
    if (o.effect === 'REVOKE') held.delete(o.permissionCode);
  // Every code came from the catalog: role rows are FK'd to it and the DTO checks `@IsIn`.
  return [...held] as Permission[];
}
