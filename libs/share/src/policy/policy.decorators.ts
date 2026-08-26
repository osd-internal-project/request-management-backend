import { SetMetadata } from '@nestjs/common';
import { Permission } from './permissions';

export const PERMISSIONS_KEY = 'ctd:permissions';
export const AUTHENTICATED_KEY = 'ctd:authenticated';
export const PUBLIC_KEY = 'ctd:public';
export const SERVICE_ACCOUNT_ONLY_KEY = 'ctd:service-account-only';
export const SERVICE_ACCOUNT_ALLOWED_KEY = 'ctd:service-account-allowed';

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

/**
 * AUTH-06: only a service account may call this, and a service account may
 * call **nothing else**.
 *
 * Both directions matter. A machine credential should not be able to drive the
 * admin screens if it leaks, and a person should not be able to post as an
 * integration — `source: "system"` on a request has to mean a system really
 * raised it, or REQ-10's provenance is worthless.
 */
export const ServiceAccountOnly = () =>
  SetMetadata(SERVICE_ACCOUNT_ONLY_KEY, true);

/**
 * Permits **both** a person and a service account.
 *
 * Reserved for infrastructure endpoints that sit underneath the business
 * surface — principal resolution and the org lookups the approval engine needs.
 * A service account has to be able to resolve itself, or AUTH-06 would forbid
 * the very integrations it exists to make possible.
 *
 * Not a general-purpose escape hatch: business endpoints stay on one side of
 * the line or the other.
 */
export const ServiceAccountAllowed = () =>
  SetMetadata(SERVICE_ACCOUNT_ALLOWED_KEY, true);
