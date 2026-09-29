import { Module, type INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import {
  AppError,
  AuditModule,
  DirectoryModule,
  PrismaModule,
  PrismaService,
  type Principal,
} from '@request-management/share';
import { EventsModule } from '../services/core-service/src/events/events.module';
import { RequestsModule } from '../services/core-service/src/requests/requests.module';
import configs from '../services/core-service/src/configs';

@Module({
  imports: [
    EventsModule,
    // Interval 0 keeps the SLA sweep and digest timers from running under a one-off script.
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [
        () => ({
          ...configs(),
          slaSweepIntervalMs: 0,
          notificationDigestIntervalMs: 0,
        }),
      ],
    }),
    PrismaModule,
    AuditModule,
    DirectoryModule,
    RequestsModule,
  ],
})
class RequestTypeScriptModule {}

/** Boots only the requests domain (no HTTP, no CRM timers) for admin scripts. */
export async function bootRequestsContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(RequestTypeScriptModule, {
    logger: ['error', 'warn'],
  });
}

export function maskedDatabaseTarget(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  const url = new URL(raw);
  return `${url.protocol}//***@${url.host}${url.pathname}`;
}

/**
 * A service-account actor named after the script: audit keeps `actorId` null and
 * the name, `publishedBy` gets the name (no FK), and company membership is not checked.
 */
export async function scriptPrincipal(
  app: INestApplicationContext,
  name: string,
): Promise<Principal> {
  const companies = await app.get(PrismaService).company.findMany({
    select: { id: true, name: true, docPrefix: true },
    orderBy: { code: 'asc' },
  });
  const actor = `script:${name}`;

  return {
    userId: actor,
    keycloakId: actor,
    username: actor,
    displayName: actor,
    email: null,
    companies: companies.map((company) => ({ ...company, isPrimary: false })),
    activeCompanyId: companies[0]?.id ?? '',
    orgUnitId: null,
    supervisorUserId: null,
    ledUnitIds: [],
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedActUnitIds: [],
    scopedUserIds: [],
    scopedActUserIds: [],
    scopedByPermission: {},
    roles: [],
    permissions: [],
    sensitiveFieldsVisible: [],
    sensitiveFieldsAll: [],
    isServiceAccount: true,
    pendingOrgAssignment: false,
  };
}

export function isApply(argv: readonly string[]): boolean {
  return argv.includes('--apply');
}

export function describeError(error: unknown): string {
  if (error instanceof AppError) {
    return `${error.code} ${error.message} ${JSON.stringify(error.details)}`;
  }
  return error instanceof Error ? error.message : String(error);
}
