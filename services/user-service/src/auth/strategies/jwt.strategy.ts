import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwksRsa from 'jwks-rsa';

export interface KeycloakJwtPayload {
  sub: string;
  preferred_username: string;
  email?: string;
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  [key: string]: unknown;
}

/**
 * Validates access tokens issued by the `enterprise-crm-uat` realm using its
 * public JWKS. Any service (in this project or Osd-service-d) pointed at the
 * same KEYCLOAK_BASE_URL/KEYCLOAK_REALM validates the same token — this is
 * what enables single sign-on across projects.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const issuer = config.get<string>('keycloak.issuer')!;
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: jwksRsa.passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: config.get<string>('keycloak.jwksUri')!,
      }),
      issuer,
      algorithms: ['RS256'],
    });
  }

  validate(payload: KeycloakJwtPayload): KeycloakJwtPayload {
    return payload;
  }

  /**
   * Reads the claims out of a token **without** verifying the signature.
   *
   * Only safe for a token this service just received directly from Keycloak's
   * token endpoint over a server-to-server call — its provenance is already
   * established. Never use this on a token that arrived from a client; those
   * go through the JWKS verification above.
   */
  static decodeClaims(accessToken: string): KeycloakJwtPayload | null {
    const segment = accessToken.split('.')[1];
    if (!segment) return null;

    try {
      const json = Buffer.from(segment, 'base64url').toString('utf8');
      const claims = JSON.parse(json) as KeycloakJwtPayload;

      return claims.sub && claims.preferred_username ? claims : null;
    } catch {
      return null;
    }
  }
}
