import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppErrorExceptionFilter } from '@request-management/share';
import request from 'supertest';
import { App } from 'supertest/types';
import { ExternalServiceModule } from './../src/external-service.module';

/**
 * Boots the whole service, which is the point.
 *
 * Two things can only fail at boot on this service, and both have a history:
 *
 * - **A route leaking from core-service.** This service imports core's domain
 *   providers, and Nest registers the controllers of anything it imports
 *   transitively. If `services/core-service/src/index.ts` ever exports a
 *   `*HttpModule`, the screens' routes appear on the external port. Asserting
 *   the route *prefixes* here catches that with the app actually wired, where
 *   the generated-OpenAPI check in CI reads a file.
 * - **The MCP catalogue disagreeing with its dispatch table.**
 *   `McpToolRegistry` throws on purpose in that case, which fails this test
 *   rather than shipping a tool nothing implements.
 *
 * It needs no database: the guard chain rejects an unauthenticated request
 * before any handler runs, which is what the assertions below rely on.
 */
describe('ExternalService (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [ExternalServiceModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    /*
      The pipe and the filter are applied in `main.ts`, not in the module, so
      a test that boots the module alone answers 500 where the real service
      answers 401. Mirrored here rather than moved into the module: `main.ts`
      is where a Nest application is assembled, and core-service and
      user-service both do it the same way.
    */
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AppErrorExceptionFilter());
    app.setGlobalPrefix('api/v1', {
      exclude: [
        '.well-known/oauth-protected-resource',
        '.well-known/oauth-protected-resource/api/v1/mcp',
      ],
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const ALLOWED = ['request', 'crm', 'approval', 'mcp', 'health'];

  it('serves nothing outside its four modules and its health check', () => {
    /*
      Read from the Swagger document rather than the router's internals: it
      is a public API that survives an Express major version, and it is the
      same source `yarn openapi` writes, so this assertion and the one CI
      makes against `docs/openapi/external-service.json` cannot disagree.
    */
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const paths = Object.keys(document.paths);

    const leaked = paths.filter(
      (path) =>
        !path.startsWith('/.well-known') &&
        !ALLOWED.some((module) => path.startsWith(`/api/v1/${module}`)),
    );

    expect(leaked).toEqual([]);
    // Guards against the assertion passing because nothing was found at all.
    expect(paths.length).toBeGreaterThan(50);
  });

  it('refuses an unauthenticated request rather than answering it', () => {
    return request(app.getHttpServer())
      .get('/api/v1/request/request-types')
      .expect(401)
      .expect((response) => {
        const body = response.body as { code?: string };

        expect(body.code).toBe('UNAUTHORIZED');
      });
  });

  it('serves the OAuth discovery document without a credential', () => {
    return request(app.getHttpServer())
      .get('/.well-known/oauth-protected-resource')
      .expect(200)
      .expect((response) => {
        const body = response.body as { resource?: string };

        expect(body.resource).toContain('/api/v1/mcp');
      });
  });
});
