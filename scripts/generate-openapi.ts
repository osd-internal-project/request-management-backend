import { writeFileSync, mkdirSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CoreServiceModule } from '../services/core-service/src/core-service.module';
import { UserServiceModule } from '../services/user-service/src/user-service.module';

/**
 * §14 — the OpenAPI document is **generated from the code**, never hand-written.
 *
 * A hand-maintained `api-spec.md` has nothing forcing it to match the routes
 * that actually exist; this reads the decorators the server itself runs on, so
 * a route that is renamed or deleted cannot stay in the spec by inertia.
 *
 * The app is created without listening: nothing binds a port, and no request
 * is ever served by this process.
 */
async function generate(
  name: string,
  module: Parameters<typeof NestFactory.create>[0],
  prefix: string,
): Promise<void> {
  const app = await NestFactory.create(module, { logger: false });
  app.setGlobalPrefix(prefix);

  const config = new DocumentBuilder()
    .setTitle(`request-management ${name}`)
    .setVersion('1.0')
    .addBearerAuth()
    .addGlobalParameters({
      name: 'X-Company-Id',
      in: 'header',
      required: false,
      description: 'บริษัทที่คำขอนี้ทำงานอยู่ (§11.1) — ว่าง = บริษัทหลัก',
      schema: { type: 'string' },
    })
    .build();

  const document = SwaggerModule.createDocument(app, config);

  mkdirSync('docs/openapi', { recursive: true });
  writeFileSync(
    `docs/openapi/${name}.json`,
    `${JSON.stringify(document, null, 2)}\n`,
  );

  const paths = Object.keys(document.paths).length;
  console.log(`${name}: ${paths} paths → docs/openapi/${name}.json`);

  await app.close();
}

async function main(): Promise<void> {
  await generate('core-service', CoreServiceModule, 'api/v1');
  await generate('user-service', UserServiceModule, 'api/v1');
}

void main();
