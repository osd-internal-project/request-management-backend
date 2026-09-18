import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  Authenticated,
  CurrentPrincipal,
  Public,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Request } from 'express';
import { AuditService } from '../audit/audit.service';
import { AuditEvent } from '../audit/audit-events';
import { PrincipalService } from '../principal/principal.service';
import { AuthService } from './auth.service';
import { CallbackDto } from './dto/callback.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { SwitchCompanyDto } from './dto/switch-company.dto';
import { JwtStrategy } from './strategies/jwt.strategy';

/** The §11.2 shape of `GET /auth/me`, which the frontend reads once per login. */
interface MeResponse {
  user: {
    id: string;
    username: string;
    display_name: string;
    email: string | null;
    org_unit_id: string | null;
    supervisor_user_id: string | null;
    pending_org_assignment: boolean;
  };
  companies: {
    id: string;
    name: string;
    doc_prefix: string;
    is_primary: boolean;
  }[];
  active_company_id: string;
  roles: string[];
  permissions: string[];
  /**
   * Whether this person heads any group. The menu hides "งานทั้งหมด" without
   * it — a page that can only ever be empty reads as one that failed to load.
   *
   * A boolean rather than the id list: the frontend never filters by unit
   * itself, and shipping the list would invite it to start.
   */
  leads_units: boolean;
  sensitive_fields_visible: string[];
}

function present(principal: Principal): MeResponse {
  return {
    user: {
      id: principal.userId,
      username: principal.username,
      display_name: principal.displayName,
      email: principal.email,
      org_unit_id: principal.orgUnitId,
      supervisor_user_id: principal.supervisorUserId,
      pending_org_assignment: principal.pendingOrgAssignment,
    },
    companies: principal.companies.map((company) => ({
      id: company.id,
      name: company.name,
      doc_prefix: company.docPrefix,
      is_primary: company.isPrimary,
    })),
    active_company_id: principal.activeCompanyId,
    roles: [...principal.roles],
    permissions: [...principal.permissions],
    leads_units: principal.ledUnitIds.length > 0,
    sensitive_fields_visible: [...principal.sensitiveFieldsVisible],
  };
}

/**
 * AUTH-01…07. Login is **OIDC Authorization Code + PKCE**: there is no
 * endpoint here that accepts a password, by design — credentials are typed
 * into Keycloak's own page and never reach this service.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly principals: PrincipalService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Leg 1. The BFF calls this, stores `state` and `code_verifier` in httpOnly
   * cookies, then redirects the browser to `authorize_url`.
   */
  @Post('authorize')
  @Public()
  @HttpCode(HttpStatus.OK)
  authorize(@Query('redirect_uri') redirectUri?: string) {
    const authorization = this.authService.createAuthorization(redirectUri);

    return {
      authorize_url: authorization.authorizeUrl,
      state: authorization.state,
      code_verifier: authorization.codeVerifier,
    };
  }

  /** Leg 2. The BFF posts the code plus the verifier it stored in leg 1. */
  @Post('callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  async callback(@Body() dto: CallbackDto, @Req() request: Request) {
    const tokens = await this.authService.exchangeCode({
      code: dto.code,
      codeVerifier: dto.codeVerifier,
      redirectUri: dto.redirectUri,
    });

    // AUTH-04/AUTH-07: provision the profile and record the login now, so a
    // first-time user shows up in the "รอจัดสังกัด" queue immediately rather
    // than only once they happen to call another endpoint.
    await this.recordLogin(tokens.access_token, request);

    return tokens;
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  /** AUTH-03: revoke the app session *and* end the Keycloak SSO session. */
  @Post('logout')
  @Public()
  @HttpCode(HttpStatus.OK)
  async logout(@Body() dto: RefreshTokenDto) {
    await this.authService.logout(dto.refreshToken);

    return { end_session_url: this.authService.endSessionUrl() };
  }

  @Get('me')
  @Authenticated()
  @ApiBearerAuth()
  me(@CurrentPrincipal() principal: Principal): MeResponse {
    return present(principal);
  }

  /** AUTH-05: swap the active company without re-authenticating. */
  @Post('switch-company')
  @Authenticated()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  async switchCompany(
    @Body() dto: SwitchCompanyDto,
    @CurrentPrincipal() principal: Principal,
    @Req() request: Request & { user?: unknown },
  ): Promise<MeResponse> {
    const target = principal.companies.find(
      (company) => company.id === dto.company_id,
    );

    if (!target) {
      throw new AppError(
        'COMPANY_FORBIDDEN',
        'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้',
        [{ field: 'company_id', reason: dto.company_id }],
      );
    }

    // Re-resolve rather than patching the id: roles, scopes, and visible
    // sensitive fields are all per company (ROLE-04), so they must be
    // recomputed, not carried over from the previous one.
    const switched = await this.principals.resolve(
      request.user as Parameters<PrincipalService['resolve']>[0],
      dto.company_id,
    );

    // จำไว้ให้ login ครั้งถัดไปเข้าบริษัทนี้ — cookie ฝั่ง frontend ถูกลบตอน logout
    // จึงจำข้ามรอบ login ไม่ได้ด้วยตัวเอง
    await this.principals.rememberActiveCompany(
      principal.userId,
      dto.company_id,
    );

    await this.audit.record({
      eventType: AuditEvent.COMPANY_SWITCHED,
      companyId: dto.company_id,
      actorId: principal.userId,
      actorUsername: principal.username,
      resourceType: 'company',
      resourceId: dto.company_id,
      before: { activeCompanyId: principal.activeCompanyId },
      after: { activeCompanyId: dto.company_id },
    });

    return present(switched);
  }

  /** AUTH-07 plus AUTH-04 provisioning, off the freshly issued token. */
  private async recordLogin(
    accessToken: string,
    request: Request,
  ): Promise<void> {
    try {
      const claims = JwtStrategy.decodeClaims(accessToken);
      if (!claims) return;

      const principal = await this.principals.resolve(claims);

      await this.audit.record({
        eventType: AuditEvent.LOGIN_SUCCEEDED,
        companyId: principal.activeCompanyId || null,
        actorId: principal.userId,
        actorUsername: principal.username,
        resourceType: 'user',
        resourceId: principal.userId,
        ip: request.ip,
        userAgent: request.get('user-agent') ?? undefined,
        after: { pendingOrgAssignment: principal.pendingOrgAssignment },
      });
    } catch {
      // The token is already valid — a bookkeeping failure must not turn a
      // successful login into an error for the user.
    }
  }
}
