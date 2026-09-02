import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AppError } from '@request-management/share';
import { AxiosError, AxiosRequestConfig } from 'axios';
import { firstValueFrom } from 'rxjs';

export interface KeycloakUser {
  id: string;
  username: string;
  enabled: boolean;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export interface KeycloakRole {
  id: string;
  name: string;
  description?: string;
  composite?: boolean;
}

export interface KeycloakGroup {
  id: string;
  name: string;
  path: string;
  subGroups?: KeycloakGroup[];
}

/**
 * Realm roles this API refuses to grant.
 *
 * `realm-management` roles and `realm-admin` confer control of Keycloak
 * itself. Without this guard an application admin could grant themselves
 * full administration of a realm shared with other projects — turning a
 * permission over *this* system into a permission over everything on it.
 * Escalation has to be impossible through the API, not merely discouraged.
 */
const PROTECTED_ROLE_PATTERNS = [
  /^realm-admin$/i,
  /^manage-realm$/i,
  /^manage-users$/i,
  /^manage-clients$/i,
  /^manage-authorization$/i,
  /^create-client$/i,
  /^realm-management$/i,
];

export function isProtectedRole(name: string): boolean {
  return PROTECTED_ROLE_PATTERNS.some((pattern) => pattern.test(name));
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Refresh this long before expiry so a call never rides an expiring token. */
const TOKEN_SKEW_MS = 30_000;

/**
 * The only code in this service that talks to the Keycloak Admin REST API.
 *
 * Authenticates as the application client's own service account — the same
 * confidential client used for login, so there is one client and one secret
 * rather than a second identity to keep in sync. The admin token is cached
 * here and **never** returned to a caller.
 *
 * Everything this service exposes is an *enrichment* of screen A3. When the
 * service account is missing its realm-management roles the calls raise
 * `KEYCLOAK_ADMIN_UNAVAILABLE` (503) so the UI can say "not configured", and
 * the rest of A3 — the org tree, the queue, roles and scope — still renders
 * from our own database.
 */
@Injectable()
export class KeycloakAdminService {
  private readonly logger = new Logger(KeycloakAdminService.name);
  private cached: CachedToken | null = null;

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private setting(key: string): string {
    return this.config.get<string>(`keycloak.${key}`) ?? '';
  }

  /** True when a client secret is configured at all. */
  get isConfigured(): boolean {
    return Boolean(this.setting('clientSecret'));
  }

  private async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.value;
    }

    if (!this.isConfigured) {
      throw new AppError(
        'KEYCLOAK_ADMIN_UNAVAILABLE',
        'ยังไม่ได้ตั้งค่าการเชื่อมต่อ Keycloak Admin API',
        [{ field: 'KEYCLOAK_CLIENT_SECRET', reason: 'not set' }],
      );
    }

    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.setting('clientId'),
      client_secret: this.setting('clientSecret'),
    });

    try {
      const { data } = await firstValueFrom(
        this.http.post<{ access_token: string; expires_in: number }>(
          this.setting('tokenUrl'),
          params,
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        ),
      );

      this.cached = {
        value: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000 - TOKEN_SKEW_MS,
      };

      return this.cached.value;
    } catch (error) {
      this.fail(error, 'could not obtain an admin token');
    }
  }

  private async call<T>(
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.token();
    const config: AxiosRequestConfig = {
      headers: { Authorization: `Bearer ${token}` },
    };

    try {
      const url = `${this.setting('adminBaseUrl')}${path}`;
      const response =
        method === 'get'
          ? await firstValueFrom(this.http.get<T>(url, config))
          : method === 'delete'
            ? await firstValueFrom(this.http.delete<T>(url, config))
            : method === 'put'
              ? await firstValueFrom(this.http.put<T>(url, body, config))
              : await firstValueFrom(this.http.post<T>(url, body, config));

      return response.data;
    } catch (error) {
      this.fail(error, `admin call failed: ${method.toUpperCase()} ${path}`);
    }
  }

  // --- users -------------------------------------------------------------

  async findUserByUsername(username: string): Promise<KeycloakUser | null> {
    const users = await this.call<KeycloakUser[]>(
      'get',
      `/users?username=${encodeURIComponent(username)}&exact=true`,
    );

    return users[0] ?? null;
  }

  async searchUsers(
    query: string,
    first = 0,
    max = 50,
  ): Promise<KeycloakUser[]> {
    const search = query ? `search=${encodeURIComponent(query)}&` : '';
    const users = await this.call<KeycloakUser[]>(
      'get',
      `/users?${search}first=${first}&max=${max}`,
    );
    return users;
  }

  countUsers(query: string): Promise<number> {
    const search = query ? `?search=${encodeURIComponent(query)}` : '';
    return this.call<number>('get', `/users/count${search}`);
  }

  // --- realm roles -------------------------------------------------------

  listRealmRoles(): Promise<KeycloakRole[]> {
    return this.call<KeycloakRole[]>('get', '/roles');
  }

  /** Realm roles currently granted to a user. */
  listUserRoles(userId: string): Promise<KeycloakRole[]> {
    return this.call<KeycloakRole[]>(
      'get',
      `/users/${userId}/role-mappings/realm`,
    );
  }

  async grantRealmRole(userId: string, roleName: string): Promise<void> {
    this.assertGrantable(roleName);

    const role = await this.findRealmRole(roleName);
    await this.call('post', `/users/${userId}/role-mappings/realm`, [role]);
  }

  async revokeRealmRole(userId: string, roleName: string): Promise<void> {
    const role = await this.findRealmRole(roleName);
    await this.call('delete', `/users/${userId}/role-mappings/realm`, [role]);
  }

  // --- groups ------------------------------------------------------------

  listGroups(): Promise<KeycloakGroup[]> {
    return this.call<KeycloakGroup[]>('get', '/groups');
  }

  listUserGroups(userId: string): Promise<KeycloakGroup[]> {
    return this.call<KeycloakGroup[]>('get', `/users/${userId}/groups`);
  }

  async joinGroup(userId: string, groupId: string): Promise<void> {
    await this.call('put', `/users/${userId}/groups/${groupId}`, {});
  }

  async leaveGroup(userId: string, groupId: string): Promise<void> {
    await this.call('delete', `/users/${userId}/groups/${groupId}`);
  }

  // --- internals ---------------------------------------------------------

  private assertGrantable(roleName: string): void {
    if (isProtectedRole(roleName)) {
      throw new AppError(
        'KEYCLOAK_ROLE_FORBIDDEN',
        'ไม่อนุญาตให้กำหนดบทบาทที่ควบคุม Keycloak เอง',
        [{ field: 'role', reason: roleName }],
      );
    }
  }

  private async findRealmRole(name: string): Promise<KeycloakRole> {
    const roles = await this.listRealmRoles();
    const role = roles.find((candidate) => candidate.name === name);

    if (!role) {
      throw new AppError('NOT_FOUND', 'ไม่พบบทบาทใน Keycloak', [
        { field: 'role', reason: name },
      ]);
    }

    return role;
  }

  /**
   * Maps a transport failure onto `KEYCLOAK_ADMIN_UNAVAILABLE`.
   *
   * A 403 here is the interesting case: the service account authenticated
   * fine but has no realm-management roles, so the token looks perfectly
   * valid while every call is refused. Reporting it as "unavailable" points at
   * the real fix rather than looking like the caller's permission problem.
   */
  private fail(error: unknown, context: string): never {
    if (error instanceof AppError) throw error;

    const axiosError = error as AxiosError<{ error?: string }>;
    const status = axiosError.response?.status;

    this.logger.warn(
      `Keycloak admin: ${context}${status ? ` (HTTP ${status})` : ''}`,
    );

    if (status === 401 || status === 403) {
      throw new AppError(
        'KEYCLOAK_ADMIN_UNAVAILABLE',
        'บัญชีบริการยังไม่มีสิทธิ์เรียก Keycloak Admin API',
        [
          {
            field: 'service-account',
            reason:
              'needs realm-management roles: view-users, query-users, query-groups, manage-users, view-realm',
          },
        ],
      );
    }

    throw new AppError(
      'KEYCLOAK_ADMIN_UNAVAILABLE',
      'ไม่สามารถติดต่อ Keycloak Admin API ได้ในขณะนี้',
    );
  }
}
