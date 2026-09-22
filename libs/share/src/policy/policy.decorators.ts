import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Permission } from './permissions';

export const PERMISSIONS_KEY = 'ctd:permissions';
export const ANY_PERMISSION_KEY = 'ctd:any-permission';
export const AUTHENTICATED_KEY = 'ctd:authenticated';
export const PUBLIC_KEY = 'ctd:public';
export const SERVICE_ACCOUNT_ONLY_KEY = 'ctd:service-account-only';
export const SERVICE_ACCOUNT_ALLOWED_KEY = 'ctd:service-account-allowed';
export const ACTING_PERMISSIONS_KEY = 'ctd:acting-permissions';
export const INTERNAL_SERVICE_KEY = 'ctd:internal-service';

/**
 * Declares the permissions an endpoint requires. The caller must hold **all**
 * of them, evaluated against the active company.
 *
 * ROLE-01 requires every endpoint to declare its access explicitly — see
 * `PolicyGuard`, which denies anything carrying none of the three markers.
 */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * Declares that **any one** of these permissions is enough.
 *
 * For a read that two different jobs legitimately need. The company directory
 * is the case that produced it: an administrator reads it because they manage
 * people (`user.read`), and a requester reads it because §16 หน้าที่ 3 makes
 * them name a receiver (`request.create`). Requiring both would lock out
 * whichever one you were not.
 *
 * Deliberately **not** a general loosening. `@Permissions` stays the default
 * and stays all-of; use this only where the endpoint genuinely serves two
 * audiences, and never to paper over a role that is missing a grant it should
 * have.
 *
 * Row visibility is unaffected either way — that is `access-rules.ts`'s job,
 * and it pins the company however the caller got in (SCOPE-03).
 */
export const AnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ANY_PERMISSION_KEY, permissions);

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

/**
 * เรียกโดย service ในระบบด้วยกันเท่านั้น ด้วย token ของ service เอง.
 * บัญชีบริการที่ไม่มี API key ผ่านได้เฉพาะที่นี่ และได้สิทธิ์ว่าง — docs/run-number.md.
 */
export const InternalService = () =>
  applyDecorators(
    SetMetadata(INTERNAL_SERVICE_KEY, true),
    ServiceAccountAllowed(),
  );

/**
 * Declares the permissions the **person an integration is acting for** must
 * hold, checked after the acting-user swap. The caller must hold all of them.
 *
 * This is the second of two gates, and the two answer different questions:
 *
 * - `@Permissions('integration.…')` asks *may this machine call this
 *   endpoint at all* — evaluated by the global `PolicyGuard`, which runs
 *   before any route guard and therefore sees the service account.
 * - `@ActingPermissions('crm.customer.manage')` asks *may this person do
 *   this* — evaluated by `ActingPolicyGuard`, declared after the guard that
 *   performs the swap, and therefore sees the human.
 *
 * The ordering `PolicyGuard` → swap → this is deliberate and is explained in
 * the swap guard itself: swapping any earlier would test the human against the
 * integration's gate, letting anyone holding `request.create` through a door
 * meant only for the robot. This decorator adds the gate that was missing on
 * the other side of the swap rather than moving the swap.
 *
 * **Why it is not optional on a route that swaps.** Before it existed, the
 * human's own permissions were never checked by a guard at all. The request
 * API survived that because `RequestsService` re-checks with `assertMayAct`,
 * but CRM enforces `crm.*` only on its controllers — so an integration could
 * act as somebody who may not do what it was asking for. Declare the same
 * permission the equivalent screen route declares.
 */
export const ActingPermissions = (...permissions: Permission[]) =>
  SetMetadata(ACTING_PERMISSIONS_KEY, permissions);
