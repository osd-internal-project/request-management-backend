import { writeFileSync, mkdirSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
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
/**
 * Every `#/components/schemas/...` reachable from `node`, followed recursively.
 *
 * The partner document must carry the schemas its own paths use and nothing
 * else: `core-service.json` holds thirty, most belonging to the admin and
 * approval surfaces, and shipping those would hand an integrator the shape of
 * endpoints they cannot call and should not know about.
 */
function collectRefs(
  node: unknown,
  schemas: Record<string, unknown>,
  found: Set<string>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, schemas, found);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const name = value.replace('#/components/schemas/', '');
      // Guard against a cycle: a schema that refers back to itself, directly
      // or through a chain, would otherwise recurse until the stack gives out.
      if (schemas[name] && !found.has(name)) {
        found.add(name);
        collectRefs(schemas[name], schemas, found);
      }
      continue;
    }
    collectRefs(value, schemas, found);
  }
}

/**
 * The partner-facing document: the `external` routes alone, cut from the
 * core-service document that was just built.
 *
 * Cut rather than generated from a module of its own, because a second
 * `SwaggerModule.createDocument` would describe a second application — one
 * assembled here, in this script, that no server runs. Filtering the real
 * document keeps §14's guarantee: what integrators receive is what core-service
 * actually serves.
 */
function writeExternalDocument(document: OpenAPIObject, prefix: string): void {
  const externalPrefix = `/${prefix}/external`;
  const paths = Object.fromEntries(
    Object.entries(document.paths).filter(([path]) =>
      path.startsWith(externalPrefix),
    ),
  );

  const allSchemas = (document.components?.schemas ?? {}) as Record<
    string,
    unknown
  >;
  const used = new Set<string>();
  collectRefs(paths, allSchemas, used);

  const external = {
    ...document,
    info: {
      title: 'Request Form — External API',
      description:
        'API สำหรับระบบภายนอก (เช่น chatbot) ขับเคลื่อนคำขอตั้งแต่เปิดจนปิด\n\n' +
        'ทุก request ต้องมีสองอย่าง: bearer ที่ถือสิทธิ์ ' +
        '`integration.request.create` และ header `X-Acting-User` ' +
        'ที่ระบุอีเมลของคนที่ระบบกำลังทำแทน — ระบบจะทำงานในนามคนนั้น ' +
        'timeline จึงบันทึกชื่อคนจริง ไม่ใช่ชื่อบัญชีบริการ\n\n' +
        '**bearer รับได้สองแบบ**\n\n' +
        '1. access token ของ service account จาก Keycloak (client_credentials) ' +
        'อายุสั้น ต้องขอใหม่เมื่อหมดอายุ\n' +
        '2. **API key** ที่ขึ้นต้นด้วย `rfk_` — ไม่มีวันหมดอายุ ไม่ต้องต่ออายุ ' +
        'ระบบแลกเป็น token ให้เองตอนใช้ ออกด้วย `yarn apikey:issue` ' +
        'และเพิกถอนด้วย `yarn apikey:revoke` (มีผลทันที)\n\n' +
        'ทั้งสองแบบส่งเหมือนกัน: `Authorization: Bearer <ค่า>` ' +
        'และได้สิทธิ์ชุดเดียวกัน — key ตัดสินว่า *เข้าได้ไหม* token บอกว่า *ทำอะไรได้*',
      version: document.info.version,
    },
    tags: [
      {
        name: 'external',
        description:
          'External Request API สำหรับ chatbot, workflow และระบบ integration',
      },
    ],
    /*
      Where the document was true of when it was generated. Integrators import
      the file and press Try it: without this they are asked for a base URL
      they have no way to guess.

      **No path prefix here.** `setGlobalPrefix` already put `/${prefix}` into
      every key of `paths`, so a server URL carrying it too made Try it request
      `/api/v1/api/v1/external/...` and answer 404 — for everyone, on the very
      first thing an integrator does with the file. `EXTERNAL_API_PUBLIC_URL`
      must be prefix-free for the same reason: origin only, no trailing path.
    */
    servers: [
      {
        url: process.env.EXTERNAL_API_PUBLIC_URL ?? 'http://192.168.31.52:3502',
        description: 'เครื่องภายใน OSD',
      },
    ],
    paths,
    components: {
      ...document.components,
      schemas: Object.fromEntries(
        [...used].sort().map((name) => [name, allSchemas[name]]),
      ),
    },
  };

  writeFileSync(
    'docs/openapi/external-api.json',
    `${JSON.stringify(external, null, 2)}\n`,
  );

  const operations = Object.values(paths).reduce(
    (total, item) => total + Object.keys(item as object).length,
    0,
  );
  console.log(
    `external-api: ${Object.keys(paths).length} paths · ${operations} operations · ` +
      `${used.size}/${Object.keys(allSchemas).length} schemas → docs/openapi/external-api.json`,
  );
}

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

  if (name === 'core-service') writeExternalDocument(document, prefix);

  await app.close();
}

async function main(): Promise<void> {
  await generate('core-service', CoreServiceModule, 'api/v1');
  await generate('user-service', UserServiceModule, 'api/v1');
}

void main();
