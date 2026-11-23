import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppErrorExceptionFilter,
  type Principal,
} from '@request-management/share';

/**
 * `GET process/line-recipients` over the real External API: guard chain, real
 * Prisma engine. Runs in `make smoke` against the throwaway database.
 */
const SCOPE_DB = process.env.EXTERNAL_SMOKE_DB_URL;

(SCOPE_DB ? describe : describe.skip)('LINE recipients — External API', () => {
  let app: INestApplication<App>;
  const run = randomUUID().slice(0, 8);
  const ids = {
    companyA: randomUUID(),
    companyB: randomUUID(),
    robot: randomUUID(),
    linked: randomUUID(),
    unlinked: randomUUID(),
    other: randomUUID(),
  };
  const companyA = { id: ids.companyA, name: `LA ${run}`, docPrefix: `LA${run}` };
  const companyB = { id: ids.companyB, name: `LB ${run}`, docPrefix: `LB${run}` };
  const email = (who: string) => `${who}-${run}@line.test`;

  /** The test key is `<company>:<scope>`, as in documents-api.e2e-spec.ts. */
  function robot(token: string): Principal {
    const [company, permission] = token.replace('Bearer ', '').split(':');
    const which = company === 'B' ? companyB : companyA;
    return {
      userId: ids.robot,
      keycloakId: ids.robot,
      username: 'robot',
      displayName: 'robot',
      email: null,
      companies: [{ ...which, isPrimary: true }],
      activeCompanyId: which.id,
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
      permissions: permission ? [permission] : [],
      sensitiveFieldsVisible: [],
      sensitiveFieldsAll: [],
      isServiceAccount: true,
      pendingOrgAssignment: false,
      systemPermissions: [],
    } as unknown as Principal; // the guards read only these fields
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SCOPE_DB;

    const { ExternalServiceModule } = jest.requireActual<
      typeof import('../src/external-service.module')
    >('../src/external-service.module');
    const { ApiKeyService, RemotePrincipalService } = jest.requireActual<
      typeof import('@request-management/core-service')
    >('@request-management/core-service');
    const { PrismaService } = jest.requireActual<
      typeof import('@request-management/share')
    >('@request-management/share');

    const prisma = new PrismaService();
    await prisma.company.createMany({
      data: [
        { ...companyA, code: `LA${run}` },
        { ...companyB, code: `LB${run}` },
      ],
    });
    const person = (id: string, who: string) => ({
      id,
      keycloakId: id,
      username: `${who}-${run}`,
      email: email(who),
      displayName: who,
    });
    await prisma.user.createMany({
      data: [
        { id: ids.robot, keycloakId: ids.robot, username: `robot-${run}`, displayName: 'robot' },
        person(ids.linked, 'linked'),
        person(ids.unlinked, 'unlinked'),
        person(ids.other, 'other'),
      ],
    });
    await prisma.userCompany.createMany({
      data: [
        { userId: ids.linked, companyId: ids.companyA, isPrimary: true },
        { userId: ids.unlinked, companyId: ids.companyA, isPrimary: true },
        { userId: ids.other, companyId: ids.companyB, isPrimary: true },
      ],
    });
    await prisma.userLineAccount.createMany({
      data: [
        {
          userId: ids.linked,
          companyId: ids.companyA,
          lineUserId: `U-a-${run}`,
          displayName: 'Linked A',
          isFriend: true,
        },
        {
          userId: ids.other,
          companyId: ids.companyB,
          lineUserId: `U-b-${run}`,
          displayName: 'Other B',
        },
      ],
    });
    await prisma.$disconnect();

    const moduleRef = await Test.createTestingModule({
      imports: [ExternalServiceModule],
    })
      .overrideProvider(RemotePrincipalService)
      .useValue({
        resolve: (authorization: string) =>
          Promise.resolve(robot(authorization)),
      })
      .overrideProvider(ApiKeyService)
      .useValue({
        resolve: (presented: string) => {
          const token = presented.replace('Bearer ', '');
          const [company, scope] = token.split(':');
          return Promise.resolve({
            accessToken: token,
            key: {
              id: 'test-key',
              prefix: 'rfk_test',
              name: 'test',
              companyId: company === 'B' ? ids.companyB : ids.companyA,
              sourceCode: null,
              scopes: scope ? [scope] : [],
            },
          });
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // main.ts sets this pipe; the test app must too, or the 400 case passes nothing through it
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AppErrorExceptionFilter());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const get = (who: string, token = 'A:integration.process.dispatch') =>
    request(app.getHttpServer())
      .get(`/api/v1/process/line-recipients`)
      .query({ email: email(who) })
      .set('Authorization', `Bearer ${token}`);

  it('answers the LINE a member linked in the key’s company', async () => {
    const response = await get('linked');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      user_id: ids.linked,
      email: email('linked'),
      line_user_id: `U-a-${run}`,
      line_display_name: 'Linked A',
      is_friend: true,
    });
  });

  it('answers LINE_NOT_LINKED for a member who has not linked', async () => {
    const response = await get('unlinked');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'LINE_NOT_LINKED' });
  });

  it('hides a person of another company behind 404 NOT_FOUND', async () => {
    const response = await get('other');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(JSON.stringify(response.body)).not.toContain(`U-b-${run}`);
  });

  it('refuses a key without integration.process.dispatch', async () => {
    const response = await get('linked', 'A:integration.document.read');
    expect(response.status).toBe(403);
  });

  const byQuery = (query: Record<string, string>) =>
    request(app.getHttpServer())
      .get(`/api/v1/process/line-recipients`)
      .query(query)
      .set('Authorization', 'Bearer A:integration.process.dispatch');

  it('answers the same LINE by the user id an approval step names', async () => {
    const response = await byQuery({ user_id: ids.linked });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      user_id: ids.linked,
      email: email('linked'),
      line_user_id: `U-a-${run}`,
    });
  });

  it('hides another company’s user id behind 404 NOT_FOUND', async () => {
    const response = await byQuery({ user_id: ids.other });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses both or neither of email and user_id', async () => {
    const both = await byQuery({ email: email('linked'), user_id: ids.linked });
    expect(both.status).toBe(400);
    const neither = await byQuery({});
    expect(neither.status).toBe(400);
  });

  it('refuses a malformed email before reading anything', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/process/line-recipients`)
      .query({ email: 'not-an-email' })
      .set('Authorization', 'Bearer A:integration.process.dispatch');
    expect(response.status).toBe(400);
  });
});
