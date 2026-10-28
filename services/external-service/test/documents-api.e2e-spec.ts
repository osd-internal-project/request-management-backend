import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  AppErrorExceptionFilter,
  type Principal,
} from '@request-management/share';

/**
 * Company documents over the real External API: the routes, the guard chain,
 * the real Prisma engine and the module's own storage. Runs in `make smoke`
 * against the throwaway database.
 */
const SCOPE_DB = process.env.EXTERNAL_SMOKE_DB_URL;

(SCOPE_DB ? describe : describe.skip)(
  'company documents — External API',
  () => {
    let app: INestApplication<App>;
    const run = randomUUID().slice(0, 8);
    const ids = {
      companyA: randomUUID(),
      companyB: randomUUID(),
      robot: randomUUID(),
    };
    const companyA = {
      id: ids.companyA,
      name: `DA ${run}`,
      docPrefix: `DA${run}`,
    };
    const companyB = {
      id: ids.companyB,
      name: `DB ${run}`,
      docPrefix: `DB${run}`,
    };
    const docs: Record<string, string> = {};

    /**
     * The test's API key is `<company>:<scope>` — exchanged as a real `rfk_`
     * key would be: the service account of company A or B, holding that scope.
     */
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
      } as unknown as Principal;
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = SCOPE_DB;
      process.env.STORAGE_MODE = 'memory';

      const { ExternalServiceModule } = jest.requireActual<
        typeof import('../src/external-service.module')
      >('../src/external-service.module');
      const { DocumentsApiModule } = jest.requireActual<
        typeof import('../src/documents/documents.module')
      >('../src/documents/documents.module');
      const { ApiKeyService, DocumentFilesService, RemotePrincipalService } =
        jest.requireActual<typeof import('@request-management/core-service')>(
          '@request-management/core-service',
        );
      const { PrismaService } = jest.requireActual<
        typeof import('@request-management/share')
      >('@request-management/share');

      const prisma = new PrismaService();
      await prisma.company.createMany({
        data: [
          { ...companyA, code: `DA${run}` },
          { ...companyB, code: `DB${run}` },
        ],
      });
      await prisma.user.create({
        data: {
          id: ids.robot,
          keycloakId: ids.robot,
          username: `docs-${run}`,
          displayName: 'robot',
        },
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
      app.useGlobalFilters(new AppErrorExceptionFilter());
      await app.init();

      // Upload through the same service (and the same storage) the routes read.
      const files = moduleRef
        .select(DocumentsApiModule)
        .get(DocumentFilesService);
      const admin = robot('A:admin.document.manage');
      const upload = (name: string) => ({
        originalname: name,
        mimetype: 'application/pdf',
        size: 8,
        buffer: Buffer.from('%PDF-1.4'),
      });
      docs.dated = (
        await files.upload(
          admin,
          {
            kind: 'dated',
            title: `หนังสือรับรอง ${run}`,
            issue_date: '2026-09-01',
          },
          upload('หนังสือรับรอง.pdf'),
        )
      ).id;
      docs.general = (
        await files.upload(
          admin,
          { kind: 'general', title: `โบรชัวร์ ${run}` },
          upload('brochure.pdf'),
        )
      ).id;
      docs.archived = (
        await files.upload(
          admin,
          { kind: 'general', title: `เก่า ${run}` },
          upload('old.pdf'),
        )
      ).id;
      const { DocumentsService } = jest.requireActual<
        typeof import('@request-management/core-service')
      >('@request-management/core-service');
      await moduleRef
        .select(DocumentsApiModule)
        .get(DocumentsService)
        .archive(admin, docs.archived, true);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    const get = (path: string, token = 'A:integration.document.read') =>
      request(app.getHttpServer())
        .get(`/api/v1/${path}`)
        .set('Authorization', `Bearer ${token}`);

    it('lists the documents with their issue dates, archived ones left out', async () => {
      const response = await get('documents');
      expect(response.status).toBe(200);
      const rows = (response.body as { data: unknown }).data as {
        id: string;
        kind: string;
        issue_date: string | null;
      }[];
      expect(rows.map((row) => row.id).sort()).toEqual(
        [docs.dated, docs.general].sort(),
      );
      expect(rows[0]).toMatchObject({
        id: docs.dated,
        kind: 'dated',
        issue_date: '2026-09-01',
      });
      expect(
        rows.find((row) => row.id === docs.general)?.issue_date,
      ).toBeNull();

      const dated = await get(
        'documents?kind=dated&issued_from=2026-09-01&issued_to=2026-09-01',
      );
      expect(
        ((dated.body as { data: unknown }).data as { id: string }[]).map(
          (row) => row.id,
        ),
      ).toEqual([docs.dated]);
    });

    it('reads one document and downloads its file with the original name', async () => {
      const one = await get(`documents/${docs.dated}`);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        issue_date: '2026-09-01',
        mime_type: 'application/pdf',
      });

      const file = await get(`documents/${docs.dated}/file`).buffer(true);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toContain('application/pdf');
      expect(file.headers['content-disposition']).toContain(
        encodeURIComponent('หนังสือรับรอง.pdf'),
      );
      expect(Buffer.from(file.body as Buffer).toString()).toBe('%PDF-1.4');
    });

    it('an archived document is 404', async () => {
      expect((await get(`documents/${docs.archived}`)).status).toBe(404);
      expect((await get(`documents/${docs.archived}/file`)).status).toBe(404);
    });

    it("another company's key sees none of them (SCOPE-03)", async () => {
      const list = await get('documents', 'B:integration.document.read');
      expect((list.body as { data: unknown }).data).toEqual([]);
      expect(
        (
          await get(
            `documents/${docs.dated}/file`,
            'B:integration.document.read',
          )
        ).status,
      ).toBe(404);
    });

    it('a key without integration.document.read is refused', async () => {
      expect((await get('documents', 'A:integration.kb.read')).status).toBe(
        403,
      );
    });
  },
);
