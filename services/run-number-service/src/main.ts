import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppErrorExceptionFilter } from '@request-management/share';
import helmet from 'helmet';
import { RunNumberServiceModule } from './run-number-service.module';
import { logger } from './logger.middleware';

async function bootstrap() {
  const app = await NestFactory.create(RunNumberServiceModule);

  app.setGlobalPrefix('api/v1');
  app.enableCors();
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AppErrorExceptionFilter());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('request-management run-number-service')
    .setDescription(
      'เลขรันทุกชนิดเอกสาร. `admin/run-numbers` คือหน้าตั้งค่ารูปแบบ; ' +
        '`internal/run-numbers/issue` คือที่ที่ service อื่นขอเลข และเป็นที่เดียว ' +
        'ที่ counter ถูกบวก.',
    )
    .addBearerAuth()
    .build();
  SwaggerModule.setup(
    'api/docs',
    app,
    SwaggerModule.createDocument(app, swaggerConfig),
  );

  const port = app.get(ConfigService).get<number>('port') ?? 3004;
  app.use(logger);
  await app.listen(port);
}
void bootstrap();
