import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import {
  AppErrorExceptionFilter,
  requestContextMiddleware,
} from '@request-management/share';
import helmet from 'helmet';
import { CoreServiceModule } from './core-service.module';
import { logger } from './logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create(CoreServiceModule);

  /*
    Everything lives under `api/v1`, with nothing excluded. The two OAuth
    discovery documents that used to need an exemption moved to
    external-service along with MCP — see
    `services/external-service/src/main.ts`, which carries the RFC 8615
    reasoning for why they cannot live under a prefix.
  */
  app.setGlobalPrefix('api/v1');
  // ต้องมาก่อน guard ทุกตัว: เก็บ credential ดิบไว้ให้ client ของ service อื่น
  app.use(requestContextMiddleware);
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
