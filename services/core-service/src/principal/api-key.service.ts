import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AppError } from '@request-management/share';
import { ApiKeyRepository } from './api-key.repository';

/**
 * What every issued key starts with.
 *
 * A prefix rather than "try it as a JWT and fall back": the two credentials
 * are told apart by declaration, not by shape. Guessing would mean a malformed
 * token quietly taking the API-key path and failing with the wrong error, and
 * would make the branch impossible to reason about the day a third credential
 * type appears.
 */
export const API_KEY_PREFIX = 'rfk_';

/** Refresh a minted token before it actually lapses, not after. */
const RENEW_BEFORE_MS = 30_000;

interface MintedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

interface KeycloakTokenResponse {
  access_token?: string;
  expires_in?: number;
}

/**
 * AUTH-06 — turns a long-lived API key into a short-lived Keycloak token.
 *
 * The exchange is the whole design. A static string presented straight to
 * user-service would be rejected: it verifies bearers against Keycloak's JWKS
 * and is deliberately the only service that verifies anything (§03). Rather
 * than teach it a second credential format — two verifiers that can disagree
 * about who a caller is — core-service swaps the key for a genuine
 * client-credentials token and forwards that. Everything downstream, including
 * `ActingUserGuard` and the approval-context lookup that `submit` and
 * `complete` make, keeps working untouched.
 *
 * What the key buys, then, is not authority. It is that the integration holds
 * one credential that does not expire and **can be revoked** — which the
 * alternative on the table, a Keycloak token with a very long lifespan, cannot
 * be without rotating the client secret for every integration at once.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);
  private minted: MintedToken | null = null;

  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly config: ConfigService,
  ) {}

  /** Whether this bearer is an API key at all, without touching the database. */
  static looksLikeKey(authorization: string): boolean {
    return bearerValue(authorization).startsWith(API_KEY_PREFIX);
  }

  /**
   * The access token this key stands for, or null when it is not a key.
   *
   * Throws `UNAUTHORIZED` for a key that is real but unusable — unknown,
   * switched off, revoked or past its expiry. The message does not say which:
   * telling an unauthenticated caller that a key *exists* but is revoked is a
   * fact they have not earned, and it is the same 401 either way.
   */
  async resolve(authorization: string): Promise<string | null> {
    const presented = bearerValue(authorization);
    if (!presented.startsWith(API_KEY_PREFIX)) return null;

    const keyHash = createHash('sha256').update(presented).digest('hex');
    const key = await this.keys.findByHash(keyHash);

    if (!key || !key.active || key.revokedAt) {
      throw new AppError(
        'UNAUTHORIZED',
        'API key ไม่ถูกต้องหรือถูกเพิกถอนแล้ว',
      );
    }

    if (key.expiresAt && key.expiresAt.getTime() <= Date.now()) {
      throw new AppError('UNAUTHORIZED', 'API key หมดอายุแล้ว');
    }

    /*
      Not awaited into the request's critical path, and a failure here must not
      fail the call: a last-used stamp is bookkeeping, and losing one is a
      smaller problem than refusing a valid request because a write contended.
    */
    void this.keys
      .touch(key.id, key.lastUsedAt)
      .catch((error: unknown) =>
        this.logger.warn(
          `could not stamp lastUsedAt for ${key.prefix}: ${String(error)}`,
        ),
      );

    return this.integrationToken();
  }

  /**
   * A client-credentials token for the integration client, reused until it is
   * nearly spent.
   *
   * One token serves every key, because the key decides *whether* a caller may
   * in, and the token carries *what* they may do — which is the integration
   * client's roles, the same set the chatbot has always had. Per-key
   * permissions would need a second permission source; there is exactly one
   * today (`libs/share/src/policy/permissions.ts` via the token's roles) and
   * adding another is how two answers to "may they?" start to differ.
   */
  private async integrationToken(): Promise<string> {
    if (this.minted && this.minted.expiresAt - RENEW_BEFORE_MS > Date.now()) {
      return this.minted.accessToken;
    }

    const clientId = this.config.get<string>('integration.clientId') ?? '';
    const clientSecret =
      this.config.get<string>('integration.clientSecret') ?? '';

    if (!clientId || !clientSecret) {
      // Configuration, not credentials: a key that cannot be exchanged is a
      // deployment mistake, and saying so beats a puzzling 401.
      throw new AppError(
        'UNKNOWN',
        'ระบบยังไม่ได้ตั้งค่า INTEGRATION_CLIENT_ID / INTEGRATION_CLIENT_SECRET',
      );
    }

    const baseUrl = this.config.get<string>('keycloak.baseUrl') ?? '';
    const realm = this.config.get<string>('keycloak.realm') ?? '';
    const url = `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      this.logger.error(
        `client_credentials failed: ${response.status} ${await response.text()}`,
      );
      throw new AppError('UNKNOWN', 'แลก API key เป็น token ไม่สำเร็จ');
    }

    const body = (await response.json()) as KeycloakTokenResponse;
    if (!body.access_token) {
      throw new AppError('UNKNOWN', 'แลก API key เป็น token ไม่สำเร็จ');
    }

    this.minted = {
      accessToken: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 60) * 1000,
    };

    return this.minted.accessToken;
  }
}

/** The credential out of an `Authorization` header, with or without `Bearer`. */
function bearerValue(authorization: string): string {
  const trimmed = authorization.trim();
  const [scheme, ...rest] = trimmed.split(/\s+/);

  return scheme.toLowerCase() === 'bearer' ? rest.join(' ') : trimmed;
}
