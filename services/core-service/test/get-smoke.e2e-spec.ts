import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  ALL_PERMISSIONS,
  AppErrorExceptionFilter,
  type Principal,
} from '@request-management/share';

/**
 * Every GET the screens load, run through the real Prisma engine: unit tests
 * mock Prisma, so a query it rejects at runtime passes them all.
 * Needs a throwaway, migrated and seeded database — see `make smoke`.
 */
const SMOKE_DB = process.env.CORE_SMOKE_DB_URL;
const OPENAPI = join(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'openapi',
  'core-service.json',
);
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

/** Routes that answer 5xx here only because user-service is not running. */
const NEEDS_USER_SERVICE: Readonly<Record<string, string>> = {};

function assertThrowaway(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `CORE_SMOKE_DB_URL must point at a local throwaway DB, got ${host}`,
    );
  }
}

/** Pins the app to the throwaway DB and switches every background tick off. */
function pinEnvironment(url: string): void {
  process.env.DATABASE_URL = url;
  for (const key of [
    'slaSweepIntervalMs',
    'ERP_RETRY_INTERVAL_MS',
    'ERP_REFRESH_INTERVAL_MS',
    'ERP_ITEMS_REFRESH_INTERVAL_MS',
    'WORKFLOW_RETRY_INTERVAL_MS',
    'CRM_STALE_SWEEP_INTERVAL_MS',
    'NOTIFICATION_DIGEST_INTERVAL_MS',
  ]) {
    process.env[key] = '0';
  }
}

function getPaths(): string[] {
  const spec = JSON.parse(readFileSync(OPENAPI, 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(spec.paths)
    .filter(([, operations]) => 'get' in operations)
    .map(([path]) => path.replace(/\{[^}]+\}/g, MISSING_ID));
}

function adminOf(company: {
  id: string;
  name: string;
  docPrefix: string;
}): Principal {
  return {
    userId: MISSING_ID,
    keycloakId: MISSING_ID,
    username: 'smoke',
    displayName: 'smoke',
    email: null,
    companies: [{ ...company, isPrimary: true }],
    activeCompanyId: company.id,
    orgUnitId: null,
    supervisorUserId: null,
    ledUnitIds: [],
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedActUnitIds: [],
    scopedUserIds: [],
    scopedActUserIds: [],
    scopedByPermission: {},
    roles: ['admin'],
    permissions: ALL_PERMISSIONS,
    sensitiveFieldsVisible: [],
    sensitiveFieldsAll: [],
    isServiceAccount: false,
    pendingOrgAssignment: false,
  };
}

(SMOKE_DB ? describe : describe.skip)('core-service GET smoke', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    assertThrowaway(SMOKE_DB as string);
    pinEnvironment(SMOKE_DB as string);

    // Imported only after the environment is pinned: config is read at import.
    const { CoreServiceModule } = jest.requireActual<
      typeof import('../src/core-service.module')
    >('../src/core-service.module');
    const { RemotePrincipalService } = jest.requireActual<
      typeof import('../src/principal/remote-principal.service')
    >('../src/principal/remote-principal.service');
    const { PrismaService } = jest.requireActual<
      typeof import('@request-management/share')
    >('@request-management/share');

    const probe = new PrismaService();
    const company = await probe.company.findFirstOrThrow({
      select: { id: true, name: true, docPrefix: true },
    });
    await probe.$disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [CoreServiceModule],
    })
      .overrideProvider(RemotePrincipalService)
      .useValue({
        resolve: () => Promise.resolve(adminOf(company)),
        resolveActingUser: () => Promise.resolve(adminOf(company)),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AppErrorExceptionFilter());
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
  });

  it('answers every GET without a server error', async () => {
    const failures: string[] = [];

    for (const path of getPaths()) {
      if (NEEDS_USER_SERVICE[path]) continue;
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer smoke');
      if (response.status >= 500) {
        failures.push(
          `${response.status} GET ${path} ${JSON.stringify(response.body)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  }, 120_000);
});
