import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import {
  AuditModule,
  CompanyGuard,
  IdempotencyInterceptor,
  PolicyGuard,
  PrismaModule,
} from '@request-management/share';
import {
  PrincipalModule,
  RemotePrincipalGuard,
} from '@request-management/core-service';
import { HealthModule } from './health/health.module';
import { RunNumberHttpModule } from './run-number/run-number-http.module';
import configs from './configs';

/**
 * เจ้าของเลขรันทุกชนิดเอกสาร แยก deploy จาก core-service.
 * ด่านสิทธิ์ชุดเดียวกับอีกสาม service — docs/run-number.md.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
      load: [configs],
    }),
    PrismaModule,
    AuditModule,
    PrincipalModule,
    HealthModule,
    RunNumberHttpModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RemotePrincipalGuard },
    { provide: APP_GUARD, useClass: CompanyGuard },
    { provide: APP_GUARD, useClass: PolicyGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class RunNumberServiceModule {}
