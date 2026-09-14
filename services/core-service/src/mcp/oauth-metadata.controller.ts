import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '@request-management/share';

/**
 * OAuth discovery for the MCP endpoint (RFC 9728).
 *
 * An MCP client that meets a `401` is supposed to find out *where to log in*
 * without being told by hand. It reads this document, learns which
 * authorization server guards the resource, and drives the login itself — the
 * "connect" button in a chat client is this, and nothing more.
 *
 * **It names Keycloak rather than answering for it.** This service issues no
 * tokens and verifies none (§03); it points at the realm and gets out of the
 * way, so `/realms/<realm>/.well-known/openid-configuration` stays the one
 * description of how to authenticate.
 *
 * Served at the site root, not under `api/v1`: well-known URIs are defined
 * relative to the origin, and a client will not look anywhere else. `main.ts`
 * excludes these two paths from the global prefix for exactly this reason.
 *
 * `@Public()` because a document whose purpose is telling an *unauthenticated*
 * caller how to authenticate cannot itself require authentication. It discloses
 * only the realm URL, which is already public in every login redirect.
 */
@ApiExcludeController()
@Controller()
export class OAuthMetadataController {
  constructor(private readonly config: ConfigService) {}

  /**
   * Both spellings, because clients disagree about which to ask for.
   *
   * RFC 9728 derives the path from the resource's own path —
   * `/.well-known/oauth-protected-resource/api/v1/mcp` — while several clients
   * only ever try the bare root. Serving both is two lines; guessing wrong is
   * a connect button that fails with nothing in the log to say why.
   */
  @Get('.well-known/oauth-protected-resource')
  @Public()
  root(): Record<string, unknown> {
    return this.metadata();
  }

  @Get('.well-known/oauth-protected-resource/api/v1/mcp')
  @Public()
  forMcp(): Record<string, unknown> {
    return this.metadata();
  }

  private metadata(): Record<string, unknown> {
    const base = this.config.get<string>('publicBaseUrl') ?? '';
    const keycloak = this.config.get<string>('keycloak.baseUrl') ?? '';
    const realm = this.config.get<string>('keycloak.realm') ?? '';

    return {
      resource: `${base}/api/v1/mcp`,
      authorization_servers: [`${keycloak}/realms/${realm}`],
      bearer_methods_supported: ['header'],
      /*
        The scopes Keycloak is asked for at login. Permissions do not come from
        scopes here — they come from the caller's realm roles, resolved by
        user-service — so this is only what makes the token carry an identity.
      */
      scopes_supported: ['openid', 'profile', 'email'],
      resource_documentation: `${base}/api/docs`,
    };
  }
}
