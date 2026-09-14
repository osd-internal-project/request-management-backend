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
