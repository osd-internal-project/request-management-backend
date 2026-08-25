import { SetMetadata } from '@nestjs/common';
import { Permission } from './permissions';

export const PERMISSIONS_KEY = 'ctd:permissions';
export const AUTHENTICATED_KEY = 'ctd:authenticated';
export const PUBLIC_KEY = 'ctd:public';

/**
 * Declares the permissions an endpoint requires. The caller must hold **all**
 * of them, evaluated against the active company.
 *
 * ROLE-01 requires every endpoint to declare its access explicitly — see
 * `PolicyGuard`, which denies anything carrying none of the three markers.
 */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Any signed-in user, no particular permission (e.g. `GET /auth/me`). */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);

/**
 * No token at all — health checks and the login redirect only. Every use is a
 * deliberate hole in the wall, so keep them countable.
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
