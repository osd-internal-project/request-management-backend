import { writeFileSync, mkdirSync } from 'node:fs';
import { MetadataScanner, ModulesContainer, NestFactory } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { ACTING_PERMISSIONS_KEY } from '@request-management/share';
import { CoreServiceModule } from '../services/core-service/src/core-service.module';
import { UserServiceModule } from '../services/user-service/src/user-service.module';
import { ExternalServiceModule } from '../services/external-service/src/external-service.module';

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
 * What every partner document says, whatever module it describes.
 *
 * Kept in one place rather than repeated four times: these are properties of
 * the *service*, not of a module, and four copies would start disagreeing the
 * first time one was edited.
 */
const SHARED_RULES =
  '**ทุก route มีสองประตู** และ Swagger ของแต่ละ route บอกไว้ทั้งคู่: ' +
  'bearer ต้องถือสิทธิ์ `integration.*` ของ route นั้น (ประตูของเครื่อง) ' +
  'และคนที่ระบุใน header `X-Acting-User` ต้องถือสิทธิ์ของงานนั้นเอง ' +
  '(ประตูของคน) — ระบบทำงานในนามคนนั้น timeline จึงบันทึกชื่อคนจริง ' +
  'ไม่ใช่ชื่อบัญชีบริการ\n\n' +
  '**bearer รับได้สองแบบ**\n\n' +
  '1. access token ของ service account จาก Keycloak (client_credentials) ' +
  'อายุสั้น ต้องขอใหม่เมื่อหมดอายุ\n' +
  '2. **API key** ที่ขึ้นต้นด้วย `rfk_` — ไม่มีวันหมดอายุ ไม่ต้องต่ออายุ ' +
  'ระบบแลกเป็น token ให้เองตอนใช้ ออกด้วย `yarn apikey:issue` ' +
  'และเพิกถอนด้วย `yarn apikey:revoke` (มีผลทันที)\n\n' +
  'ทั้งสองแบบส่งเหมือนกัน: `Authorization: Bearer <ค่า>` ' +
  'และได้สิทธิ์ชุดเดียวกัน — key ตัดสินว่า *เข้าได้ไหม* token บอกว่า *ทำอะไรได้*';

interface ModuleDoc {
  readonly title: string;
  readonly summary: string;
  /** What is true of this module and no other — usually its robot-only routes. */
  readonly notes?: string;
  readonly tags: readonly { name: string; description: string }[];
}

/**
 * One entry per module external-service serves.
 *
 * The prose is per module on purpose. An integrator wiring up CRM should not
 * have to read the request flow's exceptions to find out that
 * `POST /crm/leads` takes no `X-Acting-User`; that fact belongs in the CRM
 * document and nowhere else.
 */
const MODULE_DOCS: Readonly<Record<string, ModuleDoc>> = {
  request: {
    title: 'Request Form — External API · Request',
    summary:
      'คำขอ (Platform Request) ตั้งแต่เปิดจนปิด สำหรับระบบภายนอก เช่น chatbot',
    notes:
      '**ลำดับการเรียกที่ใช้ได้จริง** — `request-types` หาประเภท · ' +
      '`request-types/{code}/form` เอาฟอร์มและผู้รับที่เลือกได้ · `users` แปลงชื่อคน ' +
      'เป็น uuid · `requests` เปิดคำขอ · จากนั้นทุกอย่างวิ่งผ่าน ' +
      '`requests/{ref}/actions` (ถามว่าทำอะไรได้) แล้ว ' +
      '`requests/{ref}/actions/{action}` (สั่งทำ)\n\n' +
      '**ห้ามจำว่าประเภทไหนมีฟิลด์อะไร** — ฟอร์ม เอกสารบังคับ เหตุผลตีกลับ SLA และ ' +
      'บันไดอนุมัติ เป็น configuration ที่แก้ได้จากหน้า admin โดยไม่ต้อง deploy ' +
      'ดึง `request-types/{code}/form` ใหม่ทุกครั้ง\n\n' +
      '**ห้ามเดา action** — enum ใน `{action}` คือรายการที่ระบบ*มี* ไม่ใช่ที่ทำได้ ' +
      '*ตอนนี้* คำตอบต่อใบต่อคนอยู่ที่ `requests/{ref}/actions` เท่านั้น\n\n' +
      '**สถานะหลังสร้างไม่แน่นอน** — ประเภทที่มีตารางอำนาจอนุมัติแบบก่อนทำงาน ' +
      '(`request:<CODE>:pre`) จะได้ `pending_approval` ประเภทที่ไม่มีจะได้ `submitted` ' +
      'อ่านจาก `status` ที่ตอบกลับมา อย่าสมมติ\n\n' +
      'ข้อยกเว้นหนึ่งเดียวที่ **ไม่มี** `X-Acting-User`: ' +
      '`POST /request/intake` — ระบบยื่นคำขอในนามตัวเอง `source: "system"` ' +
      'ไม่มีคนเป็นผู้ยื่น (REQ-10) ถ้าต้องการให้ timeline เป็นชื่อคน ใช้ ' +
      '`POST /request/requests` พร้อม `X-Acting-User` แทน',
    tags: [
      {
        name: 'request',
        description: 'คำขอ — เปิด, ติดตาม, ดำเนินการ, ปิด',
      },
    ],
  },
  crm: {
    title: 'Request Form — External API · CRM',
    summary:
      'ทะเบียนลูกค้า, Lead, โอกาสการขาย, ใบเสนอราคา, ใบสั่งขาย และหน้าตั้งค่า CRM',
    notes:
      'สาม route ที่ **ไม่มี** `X-Acting-User` เพราะไม่มีคนอยู่ปลายสาย: ' +
      '`POST /crm/leads` (เว็บฟอร์มของลูกค้า — ใบที่เข้ามาไม่มีเจ้าของ ' +
      'รอพนักงานขายกดรับ) และ `GET|POST /crm/leads/{id}/facts|stage` ' +
      '(workflow engine อ่านและบันทึกขั้นที่ตัดสินใจแล้ว)\n\n' +
      'การมองเห็นแถวยังเดินผ่านตัวกรองเดิมทุกเส้นทาง และการอ่านข้ามบริษัทตอบ ' +
      '**404 ไม่ใช่ 403** (SCOPE-03) — เปิด CRM ออกมาทางนี้ไม่ได้ให้สิทธิ์ใหม่แก่ใคร',
    tags: [
      { name: 'crm', description: 'ทะเบียนลูกค้าและงานขาย' },
      { name: 'crm-intake', description: 'ช่องทางรับ Lead จากระบบภายนอก' },
      {
        name: 'crm-workflow',
        description: 'workflow engine อ่านและเลื่อนขั้น Lead',
      },
    ],
  },
  approval: {
    title: 'Request Form — External API · Approval',
    summary: 'เปิดเคสอนุมัติจากโมดูลอื่นที่ไม่มีคำขอในระบบรองรับ (APV-07)',
    notes:
      '**endpoint นี้ไม่มีคนทั้งเส้น** ผู้เรียกคือโมดูล ไม่ใช่คน จึงไม่ต้องส่ง ' +
      '`X-Acting-User` และส่งมาก็ไม่มีผล ชื่อที่บันทึกใน audit เป็นบัญชีบริการ ' +
      'ซึ่งถูกต้องแล้ว — การใส่ชื่อคนให้มันคือการบันทึกว่ามีคนทำสิ่งที่ไม่มีใครทำ',
    tags: [
      {
        name: 'approval',
        description: 'เปิดเคสอนุมัติจากโมดูลอื่น (APV-07)',
      },
    ],
  },
  mcp: {
    title: 'Request Form — External API · MCP',
    summary: 'ช่องทาง JSON-RPC สำหรับ tool-caller (LibreChat, MCP client)',
    notes:
      '**นี่ไม่ใช่ REST API และเอกสารนี้อธิบายมันได้แค่ครึ่งเดียว** — ' +
      'มี endpoint เดียว ชื่อ tool อยู่ใน `params.name` ของ body ไม่ใช่ใน path ' +
      'จึงไม่มี `/mcp/request-types` และไม่มี URL ต่อ tool\n\n' +
      'รายการ tool จริงอยู่ที่ `docs/openapi/external-tools.json` ' +
      'ซึ่ง `tools/list` อ่านจากไฟล์นั้นตรง ๆ ' +
      'วิธีเรียกและวิธีตั้งค่าใน LibreChat อยู่ใน `docs/EXTERNAL_API.md` §4.4\n\n' +
      'แยกไฟล์ออกมาเพราะเหตุนี้: ปล่อยให้ปนอยู่กับ path ที่ยิงแบบ REST ได้ ' +
      'ทำให้ integrator เข้าใจว่ายิงแบบเดียวกันได้',
    tags: [
      { name: 'mcp', description: 'JSON-RPC — ชื่อ tool อยู่ใน body' },
    ],
  },
};

/** Served by external-service but never handed to a partner. */
const NOT_A_PARTNER_MODULE = ['health'];

/**
 * The partner-facing documents: one file per module, cut from the
 * external-service document that was just built.
 *
 * Cut rather than generated from a module of its own, because a second
 * `SwaggerModule.createDocument` would describe a second application — one
 * assembled here, in this script, that no server runs. Filtering the real
 * document keeps §14's guarantee: what integrators receive is what
 * external-service actually serves.
 *
 * **One file per module rather than one combined file.** The combined
 * `external-api.json` was 70 paths and 221 KB, and somebody wiring up CRM had
 * to read past the request flow and the approval engine to find their own
 * endpoints. Grouping is by the path segment after the prefix, so a module
 * added later gets its own document without this function changing — it only
 * needs an entry in {@link MODULE_DOCS} for its prose.
 */
function writeExternalDocuments(document: OpenAPIObject, prefix: string): void {
  const byModule = new Map<string, Record<string, unknown>>();

  for (const [path, item] of Object.entries(document.paths)) {
    if (!path.startsWith(`/${prefix}/`)) continue;

    const module = path.slice(prefix.length + 2).split('/')[0];
    if (NOT_A_PARTNER_MODULE.includes(module)) continue;

    const paths = byModule.get(module) ?? {};
    paths[path] = item;
    byModule.set(module, paths);
  }

  const allSchemas = (document.components?.schemas ?? {}) as Record<
    string,
    unknown
  >;

  for (const [module, paths] of [...byModule].sort()) {
    const doc = MODULE_DOCS[module];

    /*
      A module with no prose still gets its document — blocking `yarn openapi`
      over a missing paragraph would stop every other module from being
      regenerated too. It says so loudly instead, because an integrator
      reading a document with no description is the real cost.
    */
    if (!doc) {
      console.warn(
        `⚠️  module '${module}' has no entry in MODULE_DOCS — ` +
          'its document will carry no description. Add one.',
      );
    }

    const used = new Set<string>();
    collectRefs(paths, allSchemas, used);

    const description = [
      doc?.summary,
      SHARED_RULES,
      doc?.notes,
    ]
      .filter(Boolean)
      .join('\n\n');

    const external = {
      ...document,
      info: {
        title: doc?.title ?? `Request Form — External API · ${module}`,
        description,
        version: document.info.version,
      },
      tags: doc?.tags ?? [],
      /*
        Where the document was true of when it was generated. Integrators import
        the file and press Try it: without this they are asked for a base URL
        they have no way to guess.

        **No path prefix here.** `setGlobalPrefix` already put `/${prefix}` into
        every key of `paths`, so a server URL carrying it too made Try it request
        `/api/v1/api/v1/request/...` and answer 404 — for everyone, on the very
        first thing an integrator does with the file. `EXTERNAL_API_PUBLIC_URL`
        must be prefix-free for the same reason: origin only, no trailing path.
      */
      servers: [
        {
          url: process.env.EXTERNAL_API_PUBLIC_URL ?? 'http://192.168.31.52:3503',
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

    const file = `docs/openapi/external-${module}.json`;
    writeFileSync(file, `${JSON.stringify(external, null, 2)}\n`);

    // `paths` is `Record<string, unknown>`, so the accumulator needs naming.
    const operations = Object.values(paths).reduce<number>(
      (total, item) => total + Object.keys(item as object).length,
      0,
    );
    console.log(
      `external-${module}: ${Object.keys(paths).length} paths · ` +
        `${operations} operations · ${used.size} schemas → ${file}`,
    );
  }
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

  const stamped = stampActingPermissions(
    document,
    actingPermissionsByRoute(app, prefix),
  );

  mkdirSync('docs/openapi', { recursive: true });
  writeFileSync(
    `docs/openapi/${name}.json`,
    `${JSON.stringify(document, null, 2)}\n`,
  );

  const paths = Object.keys(document.paths).length;
  console.log(
    `${name}: ${paths} paths, ${stamped} acting-permission → docs/openapi/${name}.json`,
  );

  if (name === 'external-service') writeExternalDocuments(document, prefix);

  await app.close();
}

/**
 * `@ActingPermissions` ของทุก route คีย์ด้วย `METHOD /path` แบบ OpenAPI.
 *
 * ประตูที่สองประกาศด้วย decorator ซึ่ง Swagger ไม่รู้จัก — ถ้าไม่ดึงออกมาไว้ในเอกสาร
 * ตัวสร้าง tool ของ MCP ก็ไม่มีทางรู้ว่า tool ไหนต้องตรวจสิทธิ์อะไรของคน และ MCP จะ
 * เหลือประตูเดียวตลอดไป
 *
 * อ่านจาก metadata ที่เซิร์ฟเวอร์ใช้จริง ไม่ใช่ parse ข้อความในไฟล์ — route ที่ถูก
 * เปลี่ยนชื่อแล้วจะหลุดออกไปเอง ไม่ค้างอยู่เพราะไม่มีใครมาลบ
 */
function actingPermissionsByRoute(
  app: INestApplication,
  prefix: string,
): Map<string, string[]> {
  // `ModulesContainer` เป็น core provider ที่มีอยู่เสมอ ต่างจาก `DiscoveryService`
  // ซึ่งต้อง import `DiscoveryModule` เข้ามาก่อน — และแอปนี้ไม่ได้ import
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const found = new Map<string, string[]>();

  const controllers = [...modules.values()].flatMap((module) => [
    ...module.controllers.values(),
  ]);

  const join = (...parts: string[]) =>
    `/${parts.filter((part) => part && part !== '/').join('/')}`
      .replace(/\/+/g, '/')
      .replace(/:([^/]+)/g, '{$1}');

  for (const wrapper of controllers) {
    const target = wrapper.metatype;
    if (!target) continue;

    const controllerPath = Reflect.getMetadata(PATH_METADATA, target) as
      | string
      | undefined;

    const onClass = Reflect.getMetadata(ACTING_PERMISSIONS_KEY, target) as
      | string[]
      | undefined;

    const proto = target.prototype as object;

    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as
        | number
        | undefined;
      if (method === undefined) continue;

      const permissions =
        (Reflect.getMetadata(ACTING_PERMISSIONS_KEY, handler) as
          | string[]
          | undefined) ?? onClass;
      if (!permissions?.length) continue;

      const routePath = Reflect.getMetadata(PATH_METADATA, handler) as
        | string
        | undefined;

      const verb = RequestMethod[method];
      const path = join(prefix, controllerPath ?? '', routePath ?? '');

      found.set(`${verb} ${path}`, [...permissions]);
    }
  }

  return found;
}

/** ประทับ `x-acting-permission` ลงบน operation ที่ประกาศประตูที่สองไว้. */
function stampActingPermissions(
  document: OpenAPIObject,
  acting: Map<string, string[]>,
): number {
  let stamped = 0;

  for (const [path, item] of Object.entries(document.paths)) {
    for (const [verb, operation] of Object.entries(item)) {
      if (typeof operation !== 'object' || operation === null) continue;

      const permissions = acting.get(`${verb.toUpperCase()} ${path}`);
      if (!permissions) continue;

      Object.assign(operation, { 'x-acting-permission': permissions });
      stamped += 1;
    }
  }

  return stamped;
}

async function main(): Promise<void> {
  await generate('core-service', CoreServiceModule, 'api/v1');
  await generate('user-service', UserServiceModule, 'api/v1');
  await generate('external-service', ExternalServiceModule, 'api/v1');
}

main().catch((error) => {
  // เดิมเป็น `void main()` ซึ่งทำให้ unhandled rejection ออกมาเป็น exit 1 เปล่า ๆ
  // ไม่มีข้อความอะไรเลย — หาสาเหตุไม่ได้จนกว่าจะไปแก้ไฟล์นี้ก่อน
  console.error(error);
  process.exit(1);
});
