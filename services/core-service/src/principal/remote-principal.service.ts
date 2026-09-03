import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, Principal } from '@request-management/share';
import { createHash } from 'node:crypto';

interface CacheEntry {
  principal: Principal;
  expiresAt: number;
}

/**
 * How long a resolved principal is reused.
 *
 * Deliberately far shorter than the access token: ROLE-03 wants a role
 * revoked in Keycloak to lose effect within one token lifetime, and SCOPE-01
 * wants an admin's scope change to apply without a deploy. A minute keeps the
 * per-request hop off the hot path while staying well inside both.
 */
const CACHE_TTL_MS = 60_000;

/**
 * Resolves the caller by asking `user-service`, which owns identity, roles,
 * and scope (§03: services own their data and talk over internal APIs — no
 * cross-service table reads).
 *
 * Token verification is delegated too. `/internal/policy/resolve` sits behind
 * `user-service`'s JWKS guard, so a forged or expired token fails there and
 * this service never sees a principal for it. That keeps one JWKS
 * verification path in the system instead of two that can drift.
 */
@Injectable()
export class RemotePrincipalService {
  private readonly logger = new Logger(RemotePrincipalService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: ConfigService) {}

  async resolve(authorization: string, companyId?: string): Promise<Principal> {
    const key = createHash('sha256')
      .update(`${authorization}|${companyId ?? ''}`)
      .digest('hex');

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.principal;
    }

    const principal = await this.fetchPrincipal(authorization, companyId);

    this.cache.set(key, {
      principal,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    this.evictExpired();

    return principal;
  }

  /**
   * The principal of somebody named by **email**, for the external API.
   *
   * The chatbot holds one service-account credential and says who it is acting
   * for; from here on the request is that person's, so every rule downstream —
   * row visibility, `assertMayAct`, the SLA clock, the name on the timeline —
   * applies to them rather than to the robot.
   *
   * Cached on the same short TTL as `resolve`, keyed on the email and company
   * rather than the token: a chatbot conversation is a burst of calls for one
   * person, and each would otherwise pay the hop.
   */
  async resolveActingUser(
    authorization: string,
    email: string,
    companyId?: string,
  ): Promise<Principal> {
    const key = createHash('sha256')
      .update(`acting|${email}|${companyId ?? ''}`)
      .digest('hex');

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.principal;
    }

    const query = new URLSearchParams({ email });
    if (companyId) query.set('company_id', companyId);

    const principal = await this.get(
      `internal/principal/resolve-by-email?${query.toString()}`,
      authorization,
    );

    this.cache.set(key, { principal, expiresAt: Date.now() + CACHE_TTL_MS });
    this.evictExpired();

    return principal;
  }

  private fetchPrincipal(
    authorization: string,
    companyId?: string,
  ): Promise<Principal> {
    return this.get('internal/policy/resolve', authorization, companyId);
  }

  /**
   * One GET against user-service, with the whole error vocabulary in one
   * place.
   *
   * Both resolves come through here. They used to be one method and one
   * caller; a second caller with its own copy of the status handling would be
   * a second chance to turn a `404` into "ไม่สามารถตรวจสอบสิทธิ์ได้".
   */
  private async get(
    path: string,
    authorization: string,
    companyId?: string,
  ): Promise<Principal> {
    const baseUrl = this.config.get<string>('userServiceUrl')!;
    const url = `${baseUrl}/${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          authorization,
          ...(companyId ? { 'x-company-id': companyId } : {}),
        },
        /**
         * Generous on purpose. The first resolve after a restart pays for the
         * connection pool and the whole org walk at once — measured at 17s
         * against a remote database before the org lookup was flattened, and
         * a timeout shorter than that turns a slow start into "ไม่สามารถ
         * ตรวจสอบสิทธิ์ได้" on every screen. Later calls are cached for the
         * token's lifetime, so this ceiling is paid once per session.
         */
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      this.logger.error(
        `Cannot reach user-service at ${url}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new AppError('UNKNOWN', 'ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้');
    }

    if (response.status === 401) {
      throw new AppError('UNAUTHORIZED', 'ต้องเข้าสู่ระบบก่อนใช้งาน');
    }

    if (response.status === 403) {
      throw new AppError(
        'COMPANY_FORBIDDEN',
        'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้',
      );
    }

    /*
      Passed through as a 404 rather than folded into UNKNOWN. This is the
      answer for an acting-user email nobody in the system holds, and the
      caller can only fix it if it is told which of the two problems it has.
    */
    if (response.status === 404) {
      throw new AppError(
        'NOT_FOUND',
        'ไม่พบผู้ใช้ที่ระบุ หรือผู้ใช้ยังไม่เคยเข้าสู่ระบบ',
      );
    }

    if (!response.ok) {
      this.logger.error(`user-service ${path} returned ${response.status}`);
      throw new AppError('UNKNOWN', 'ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้');
    }

    return (await response.json()) as Principal;
  }

  /** Keeps the map from growing without bound on a long-running process. */
  private evictExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
