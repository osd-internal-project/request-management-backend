import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  IdempotencyInterceptor,
  CompanyGuard,
  DirectoryModule,
  PolicyGuard,
  PrismaModule,
  SENSITIVE_READ_RECORDER,
  SensitiveFieldInterceptor,
} from '@request-management/share';
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { KeycloakAdminModule } from './keycloak-admin/keycloak-admin.module';
import { OrgModule } from './org/org.module';
import { PolicyModule } from './policy/policy.module';
import { PolicyService } from './policy/policy.service';
import { PrincipalGuard } from './principal/principal.guard';
import { PrincipalModule } from './principal/principal.module';
import { RolesModule } from './roles/roles.module';
import { UsersModule } from './users/users.module';
import keycloakConfig from './auth/keycloak.config';
import configs from './configs';

/**
 * Guard order is load-bearing and matches the order below (Nest applies
 * `APP_GUARD` providers in registration order):
 *
 *   1. JwtAuthGuard   — is the token valid?
 *   2. PrincipalGuard — who is that, in which company, with what rights?
 *   3. CompanyGuard   — is the requested X-Company-Id one of theirs?
 *   4. PolicyGuard    — does this endpoint's declared permission hold?
 *
 * All four are global, so ROLE-01's "no endpoint is open by default" is a
 * property of the wiring rather than of anyone's diligence.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [configs, keycloakConfig],
    }),
    PrismaModule,
    AuditModule,
    DirectoryModule,
    UsersModule,
    OrgModule,
    RolesModule,
    PolicyModule,
    KeycloakAdminModule,
    PrincipalModule,
    AuthModule,
  ],
  controllers: [UserServiceController],
  providers: [
    UserServiceService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PrincipalGuard },
    { provide: APP_GUARD, useClass: CompanyGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    // SCOPE-04: strips fields the caller may not see from the response body.
    /**
     * NFR-03: registered globally but inert unless the caller sends
     * `Idempotency-Key`, so a double-tapped submit cannot issue two document
     * numbers while ordinary reads pay nothing.
     */
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: SensitiveFieldInterceptor },
    // SCOPE-05: the interceptor records an unmasked read through this.
    { provide: SENSITIVE_READ_RECORDER, useExisting: PolicyService },
  ],
})
export class UserServiceModule {}
