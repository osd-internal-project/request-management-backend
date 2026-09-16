import { Module } from '@nestjs/common';
import { PrincipalModule } from '@request-management/core-service';
import { ActingUserGuard } from './acting-user.guard';

/**
 * Everything about *machine* credentials, in one module.
 *
 * This is the whole reason external-service exists as its own deployable: the
 * outward-facing API authenticates differently from the screens. A caller
 * presents either a Keycloak service-account token or an `rfk_` API key, and
 * then names the person it is acting for in `X-Acting-User`.
 *
 * The pieces:
 *
 * - `ActingUserGuard` performs the swap, asking user-service whether this
 *   credential may act as that person (§03 — it is the only verifier).
 * - `ActingPolicyGuard` (`libs/share`) then checks what *that person* may do.
 *   The pair is the two-gate model described on `ActingPermissions`.
 * - The `rfk_` → token exchange is `ApiKeyService`, imported from
 *   core-service's `PrincipalModule` along with `RemotePrincipalGuard`, which
 *   runs it. Not re-implemented here: one exchange, one place, and
 *   user-service stays the only service that verifies a token.
 *
 * Keeping all of it here is what makes the blast radius of `X-Acting-User`
 * readable — it is this module plus whichever route declares the guards.
 */
@Module({
  imports: [PrincipalModule],
  providers: [ActingUserGuard],
  exports: [ActingUserGuard],
})
export class AuthModule {}
