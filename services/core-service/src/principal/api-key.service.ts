import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { AppError, RequestWithPrincipal } from '@request-management/share';
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
 * What a key says about itself, for the guard that acts on it.
 *
 * Only the fields that change how the request is handled — the row also holds
 * bookkeeping (`lastUsedAt`, `revokedBy`) that nothing downstream may branch on.
 */
export interface ApiKeyContext {
  readonly id: string;
  readonly prefix: string;
  readonly name: string;
  /** บริษัทที่ key นี้ผูกไว้ — null = ผู้เรียกต้องส่ง `X-Company-Id` เอง. */
  readonly companyId: string | null;
  /** ช่องทางที่ key นี้เป็นตัวแทน — ประทับลง Lead ทุกใบที่เข้ามาด้วย key นี้. */
  readonly sourceCode: string | null;
  /** สิทธิ์ที่ key นี้ใช้ได้ — ว่าง = เต็มชุดของบัญชีบริการ. */
  readonly scopes: readonly string[];
}

/** The exchange's answer: a usable bearer, plus what the key it came from says. */
export interface ResolvedApiKey {
  readonly accessToken: string;
  readonly key: ApiKeyContext;
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
 *
 * **14 ก.ย. 2569 — หนึ่ง key ต่อหนึ่งช่องทาง.** ตอนที่ช่องทางรับ Lead ต้องยิงได้
 * ด้วย "API key อย่างเดียว" กุญแจเลยได้เก็บ `companyId`, `sourceCode` และ
 * `scopes` ของตัวเอง. สองอันแรกคือ *บริบท* — ข้อเท็จจริงที่เคยให้ผู้เรียกกรอกมา
 * เอง ซึ่งกรอกผิดแล้วข้อมูลไปผิดบริษัท/ผิดช่องทาง.
 *
 * อันที่สาม `scopes` คือสิ่งที่ย่อหน้าบนเคยบอกว่าไม่ทำ — และยังไม่ทำอยู่ดี
 * ตราบใดที่มันเป็น **intersect**: คำตอบว่า "ทำอะไรได้" ยังมาจาก role ของบัญชี
 * บริการที่เดียว, `scopes` ตัดออกจากชุดนั้นได้อย่างเดียว เพิ่มไม่ได้เลย. สิทธิ์
 * สองแหล่งที่ *ขัดกัน* ได้จึงยังไม่มี — มีแต่กุญแจที่ถือได้น้อยกว่าประตูที่เปิดอยู่
 * ซึ่งคือสิ่งที่ทำให้ key ของเว็บฟอร์มหลุดออกไปแล้วเปิดได้แค่ Lead ไม่ใช่ทั้งระบบ.
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
  async resolve(authorization: string): Promise<ResolvedApiKey | null> {
    const presented = bearerValue(authorization);
    if (!presented.startsWith(API_KEY_PREFIX)) return null;

    const keyHash = createHash('sha256').update(presented).digest('hex');
    const key = (await this.keys.findByHash(keyHash)) as
      | (ApiKeyContext & {
          active: boolean;
          revokedAt: Date | null;
          expiresAt: Date | null;
          lastUsedAt: Date | null;
        })
      | null;

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

    return {
      accessToken: await this.integrationToken(),
      key: {
        id: key.id,
        prefix: key.prefix,
        name: key.name,
        companyId: key.companyId,
        sourceCode: key.sourceCode,
        scopes: key.scopes ?? [],
      },
    };
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
  /**
   * token แบบ client_credentials ของ client นี้ พร้อม cache.
   * public เพราะ `RunNumberClient` ใช้ตัวเดียวกัน — ไม่แลก token สองที่.
   */
  async integrationToken(): Promise<string> {
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

/**
 * Where the resolved key lives on the request, beside the principal.
 *
 * Carried rather than re-read: the key is looked up once in
 * `RemotePrincipalGuard`, and a handler that wants to know which channel called
 * it must not hash the bearer a second time — by then the header has been
 * rewritten with the exchanged token and the key is gone.
 */
const API_KEY_CONTEXT = 'apiKey' as const;

type RequestWithApiKey = RequestWithPrincipal & {
  [API_KEY_CONTEXT]?: ApiKeyContext;
};

export function setApiKey(
  request: RequestWithPrincipal,
  key: ApiKeyContext,
): void {
  (request as RequestWithApiKey)[API_KEY_CONTEXT] = key;
}

export function getApiKey(
  request: RequestWithPrincipal,
): ApiKeyContext | undefined {
  return (request as RequestWithApiKey)[API_KEY_CONTEXT];
}

/**
 * The API key this request came in on, or `undefined` for a person's own token.
 *
 * `undefined` is a real answer, not a failure: the same route can be reached by
 * a service account holding a Keycloak token directly. A handler that needs the
 * key must say what it does without one.
 */
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ApiKeyContext | undefined =>
    getApiKey(context.switchToHttp().getRequest<RequestWithPrincipal>()),
);

/** The credential out of an `Authorization` header, with or without `Bearer`. */
function bearerValue(authorization: string): string {
  const trimmed = authorization.trim();
  const [scheme, ...rest] = trimmed.split(/\s+/);

  return scheme.toLowerCase() === 'bearer' ? rest.join(' ') : trimmed;
}
