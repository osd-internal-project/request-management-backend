/**
 * KEYCLOAK_TLS_INSECURE — temporary, sit-only escape hatch. Same reasoning as
 * user-service's auth.module.ts, but process-wide here rather than scoped to
 * one HttpService: api-key.service.ts's Keycloak call
 * (POST .../protocol/openid-connect/token) uses the global `fetch`, which has
 * no per-call TLS agent option the way axios's httpsAgent does — the only
 * lever `fetch` (undici) respects is this process-wide env var. That makes
 * the blast radius wider than user-service's fix: every outbound HTTPS call
 * this process makes skips certificate validation, not just Keycloak's.
 * Acceptable only because sit's other outbound calls are mocked
 * (ODOO_MODE=mock, PDPA_MODE=mock) — re-check this the moment either goes
 * live against a real endpoint. Must never be `true` in uat or prod. Remove
 * once chart/keycloak/values-sit.yaml has a real TLS certificate. Set as the
 * very first statement in this file — before any import can run code that
 * might issue a request — so it is in effect before anything else executes.
 */
if (process.env.KEYCLOAK_TLS_INSECURE === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppErrorExceptionFilter } from '@request-management/share';
import helmet from 'helmet';
import { CoreServiceModule } from './core-service.module';
import { logger } from './logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create(CoreServiceModule);

  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AppErrorExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('request-management core-service')
    .setDescription('Core domain service.')
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = app.get(ConfigService).get<number>('port') ?? 3002;
  app.use(logger);
  await app.listen(port);
}
void bootstrap();
