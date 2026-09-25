import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppErrorExceptionFilter } from '@request-management/share';
import helmet from 'helmet';
import { CoreServiceModule } from './core-service.module';
import { logger } from './logger.middleware';

async function bootstrap() {
  const app =
    await NestFactory.create<NestExpressApplication>(CoreServiceModule);

  /*
    Express's JSON default is 100 KB. A CM-10 import chunk of 100 rows with
    Thai addresses (3 bytes a character) comes close to that, and a 413 there
    stops an import half-way. 2 MB leaves room without inviting abuse: the
    import DTO still caps a request at 500 rows.
  */
  app.useBodyParser('json', { limit: '2mb' });

  /*
    Everything lives under `api/v1`, with nothing excluded. The two OAuth
    discovery documents that used to need an exemption moved to
    external-service along with MCP — see
    `services/external-service/src/main.ts`, which carries the RFC 8615
    reasoning for why they cannot live under a prefix.
  */
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
