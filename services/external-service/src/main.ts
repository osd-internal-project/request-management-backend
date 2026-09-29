import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppErrorExceptionFilter } from '@request-management/share';
import helmet from 'helmet';
import { ExternalServiceModule } from './external-service.module';
import { logger } from './logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(
    ExternalServiceModule,
    // CD-66 — the LINE connector verifies LINE's signature over the raw body.
    { rawBody: true },
  );

  /*
    Express's JSON default is 100 KB. A CM-10 import chunk of 100 rows with
    Thai addresses (3 bytes a character) comes close to that, and a 413 there
    stops an import half-way. 2 MB leaves room without inviting abuse: the
    import DTO still caps a request at 500 rows.
  */
  app.useBodyParser('json', { limit: '2mb' });

  /*
    Everything lives under `api/v1` except the two OAuth discovery documents.
    Well-known URIs are defined relative to the origin (RFC 8615) and a client
    looking for one will not try a prefix — served under `api/v1` they would
    simply never be found, and the MCP connect button would fail with nothing
    to explain it. See `mcp/oauth-metadata.controller.ts`.
  */
  app.setGlobalPrefix('api/v1', {
    exclude: [
      '.well-known/oauth-protected-resource',
      '.well-known/oauth-protected-resource/api/v1/mcp',
    ],
  });
  app.enableCors();
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AppErrorExceptionFilter());
  app.enableShutdownHooks();

  /*
    `addBearerAuth()` where core-service has none, so Swagger UI gets the
    Authorize button. This is the surface people integrate against by reading
    its documentation, and a doc page you cannot send a credential from is a
    doc page everyone abandons for Postman.
  */
  const swaggerConfig = new DocumentBuilder()
    .setTitle('request-management external-service')
    .setDescription(
      'The outward-facing API. One module per domain: `request`, `crm`, ' +
        '`approval`, plus `mcp` for tool callers. Every route states both ' +
        'gates it applies — the integration permission the calling machine ' +
        'needs, and the permission the person in `X-Acting-User` needs.',
    )
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = app.get(ConfigService).get<number>('port') ?? 3003;
  app.use(logger);
  await app.listen(port);
}
void bootstrap();
