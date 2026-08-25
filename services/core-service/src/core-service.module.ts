import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  CompanyGuard,
  PolicyGuard,
  PrismaModule,
} from '@request-management/share';
import { CoreServiceController } from './core-service.controller';
import { CoreServiceService } from './core-service.service';
import { ApprovalsModule } from './approvals/approvals.module';
import { HealthModule } from './health/health.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrincipalModule } from './principal/principal.module';
import { RemotePrincipalGuard } from './principal/remote-principal.guard';
import { RequestsModule } from './requests/requests.module';
import { SlaModule } from './sla/sla.module';
import configs from './configs';

/**
 * Same deny-by-default guard chain as user-service, with token verification
 * delegated to it:
 *
 *   1. RemotePrincipalGuard — resolves the caller via user-service
 *   2. CompanyGuard         — X-Company-Id must be one of theirs
 *   3. PolicyGuard          — the endpoint's declared permission must hold
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [configs],
    }),
    PrismaModule,
    PrincipalModule,
    HealthModule,
    RequestsModule,
    ApprovalsModule,
    SlaModule,
    NotificationsModule,
  ],
  controllers: [CoreServiceController],
  providers: [
    CoreServiceService,
    { provide: APP_GUARD, useClass: RemotePrincipalGuard },
    { provide: APP_GUARD, useClass: CompanyGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
  ],
})
export class CoreServiceModule {}
