import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { AppError } from '@request-management/share';
import { AxiosError } from 'axios';
import { createHash, randomBytes } from 'node:crypto';
import { firstValueFrom } from 'rxjs';
import {
  KeycloakTokenResponse,
  KeycloakUserInfo,
} from './interfaces/keycloak-token.interface';

/** What the BFF needs to start a login (AUTH-01). */
export interface AuthorizationRequest {
  authorizeUrl: string;
  state: string;
  codeVerifier: string;
}

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

/**
 * AuthService owns every conversation with Keycloak (the `enterprise-crm-uat`
 * realm, shared with the other projects on this issuer).
 *
 * AUTH-01 mandates **OIDC Authorization Code + PKCE**: the user's password is
 * typed into Keycloak's own login page, so it never reaches this service. The
 * older resource-owner password grant is deliberately gone — there is no code
 * path here that accepts a password.
 *
 * The verifier is generated here rather than in the frontend so realm and
 * client configuration stays a backend concern; the BFF only carries the
 * opaque verifier in an httpOnly cookie between the two legs of the flow.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  private setting(key: string): string {
    return this.config.get<string>(`keycloak.${key}`)!;
  }

  private baseParams(): URLSearchParams {
    const params = new URLSearchParams();
    params.set('client_id', this.setting('clientId'));

    const secret = this.setting('clientSecret');
    if (secret) params.set('client_secret', secret);

    return params;
  }

  /**
   * Leg 1: build the URL the browser is redirected to, plus the PKCE verifier
   * and CSRF state the BFF must store and hand back on the callback.
   */
  createAuthorization(redirectUri?: string): AuthorizationRequest {
    const codeVerifier = base64Url(randomBytes(64));
    const codeChallenge = base64Url(
      createHash('sha256').update(codeVerifier).digest(),
    );
    const state = base64Url(randomBytes(32));

    const params = new URLSearchParams({
      client_id: this.setting('clientId'),
      response_type: 'code',
      scope: 'openid profile email',
      redirect_uri: redirectUri ?? this.setting('redirectUri'),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return {
      authorizeUrl: `${this.setting('authorizeUrl')}?${params.toString()}`,
      state,
      codeVerifier,
    };
  }

  /** Leg 2: trade the authorization code plus verifier for a token set. */
  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
  }): Promise<KeycloakTokenResponse> {
    const params = this.baseParams();
    params.set('grant_type', 'authorization_code');
    params.set('code', input.code);
    params.set('code_verifier', input.codeVerifier);
    params.set(
      'redirect_uri',
      input.redirectUri ?? this.setting('redirectUri'),
    );

    return this.requestToken(params);
  }

  async refresh(refreshToken: string): Promise<KeycloakTokenResponse> {
    const params = this.baseParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refreshToken);

    return this.requestToken(params);
  }

  /**
   * AUTH-03: single logout. Revoking the refresh token alone would leave the
   * Keycloak SSO session alive, so the next login would silently skip the
   * password prompt — which is not what "log out" means to a user on a shared
   * machine.
   */
  async logout(refreshToken: string): Promise<void> {
    const params = this.baseParams();
    params.set('refresh_token', refreshToken);

    try {
      await firstValueFrom(
        this.http.post(this.setting('logoutUrl'), params, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
    } catch (error) {
      this.handleKeycloakError(error);
    }
  }

  /** The URL that also ends the browser's Keycloak SSO session. */
  endSessionUrl(idToken?: string): string {
    const params = new URLSearchParams({
      post_logout_redirect_uri: this.setting('postLogoutRedirectUri'),
      client_id: this.setting('clientId'),
    });
    if (idToken) params.set('id_token_hint', idToken);

    return `${this.setting('logoutUrl')}?${params.toString()}`;
  }

  /** AUTH-06: service accounts for system-to-system calls. */
  async clientCredentials(
    clientId: string,
    clientSecret: string,
  ): Promise<KeycloakTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    return this.requestToken(params);
  }

  async getUserInfo(accessToken: string): Promise<KeycloakUserInfo> {
    try {
      const { data } = await firstValueFrom(
        this.http.get<KeycloakUserInfo>(this.setting('userInfoUrl'), {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
      );
      return data;
    } catch (error) {
      this.handleKeycloakError(error);
    }
  }

  private async requestToken(
    params: URLSearchParams,
  ): Promise<KeycloakTokenResponse> {
    try {
      const { data } = await firstValueFrom(
        this.http.post<KeycloakTokenResponse>(
          this.setting('tokenUrl'),
          params,
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          },
        ),
      );
      return data;
    } catch (error) {
      this.handleKeycloakError(error);
    }
  }

  private handleKeycloakError(error: unknown): never {
    const axiosError = error as AxiosError<{
      error?: string;
      error_description?: string;
    }>;

    if (axiosError.response) {
      const description =
        axiosError.response.data?.error_description ??
        axiosError.response.data?.error ??
        'Keycloak authentication failed';

      this.logger.warn(
        `Keycloak error ${axiosError.response.status}: ${description}`,
      );
      throw new AppError('UNAUTHORIZED', description);
    }

    this.logger.error('Unable to reach Keycloak', axiosError.stack);
    throw new AppError('UNKNOWN', 'Unable to reach Keycloak');
  }
}
