/**
 * Turn the per-module external OpenAPI documents into Postman collections.
 *
 * ## Why this is generated now, when it never was before
 *
 * The two collections this replaces were written by hand, and they were good:
 * Thai prose explaining *why* each step exists, chai assertions that checked
 * the document-number format, and `pm.collectionVariables.set` chaining that
 * let a whole scenario run end to end without copying a value. None of that
 * can be generated, and all of it is kept at
 * `docs/postman/backup/2026-09-16/` with a README naming what was lost.
 *
 * What ended them was drift. They still called `/api/v1/external/...` months
 * after that prefix was replaced by `/api/v1/request/...`, and their
 * environments still pointed at port 3002 — core-service, not
 * external-service. A hand-kept collection has nothing forcing it to match the
 * routes that exist, and the first symptom is an integrator debugging a 404 in
 * their own client.
 *
 * So: coverage and correctness are generated; scenarios stay human, and live
 * in the backup until somebody writes new ones.
 *
 * ## What the spec is trusted for
 *
 * **Headers are read from the document, never listed here.** `X-Acting-User`
 * appears in `parameters` exactly on the routes that take it, and is absent
 * from the four that act as the robot itself (`request/intake`,
 * `POST crm/leads`, `crm/leads/{id}/facts|stage`, `approval/cases`). A
 * hardcoded list of exceptions here would be a second source of truth for the
 * two-gate rule, and the day it disagreed with the guards, this file would be
 * the one nobody checked.
 *
 * Run after `yarn openapi`.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Where the parent folder keeps its Postman artefacts. */
const OUT_DIR = join('..', 'docs', 'postman');

/**
 * One collection per module — except `mcp`, deliberately.
 *
 * MCP is a single JSON-RPC endpoint whose tool name lives in `params.name` of
 * the body, so a collection converted from its REST description would be one
 * request that teaches an integrator the wrong shape. `docs/EXTERNAL_API.md`
 * §4.4 has the `curl` that teaches the right one, and
 * `docs/openapi/external-tools.json` is the real list of what it can do.
 */
const MODULES = [
  { module: 'request', name: 'Request' },
  { module: 'crm', name: 'CRM' },
  { module: 'approval', name: 'Approval' },
  { module: 'flow', name: 'Flow' },
  { module: 'presales', name: 'PreSales' },
  { module: 'legal', name: 'Legal' },
  { module: 'pm', name: 'PM' },
  { module: 'delivery', name: 'Delivery' },
  { module: 'support', name: 'Support' },
] as const;

const METHODS = ['get', 'post', 'patch', 'put', 'delete'] as const;
const MUTATIONS = ['post', 'patch', 'put', 'delete'];

type Json = Record<string, unknown>;

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: Json;
}

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: {
    content?: Record<string, { schema?: Json }>;
  };
}

interface Document {
  info: { title: string; description?: string; version: string };
  servers?: { url: string }[];
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Json> };
}

/** `customers/{id}/contacts` → `customers_id_contacts`, for a variable name. */
function slug(text: string): string {
  return text.replace(/[{}]/g, '').replace(/[^a-zA-Z0-9]+/g, '_');
}

/**
 * An example body built from the schema.
 *
 * The DTOs carry `@ApiProperty({ example })`, so most fields come back with a
 * value somebody chose rather than `"string"` — `ExternalCreateRequestDto`
 * even carries a whole filled-in `form_data`. Required properties come first
 * because that is the order a person fills them in.
 */
function exampleOf(
  schema: Json | undefined,
  schemas: Record<string, Json>,
  seen = new Set<string>(),
): unknown {
  if (!schema) return null;

  const ref = schema.$ref as string | undefined;
  if (ref) {
    const name = ref.replace('#/components/schemas/', '');
    // A schema that refers back to itself would recurse until the stack goes.
    if (seen.has(name) || !schemas[name]) return {};
    seen.add(name);
    return exampleOf(schemas[name], schemas, seen);
  }

  if (schema.example !== undefined) return schema.example;

  const type = schema.type as string | undefined;

  if (type === 'array') {
    return [exampleOf(schema.items as Json, schemas, seen)].filter(
      (value) => value !== null,
    );
  }

  if (type === 'object' || schema.properties) {
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    const required = (schema.required ?? []) as string[];
    const keys = [
      ...required.filter((key) => key in properties),
      ...Object.keys(properties).filter((key) => !required.includes(key)),
    ];

    const body: Json = {};
    for (const key of keys) body[key] = exampleOf(properties[key], schemas, seen);
    return body;
  }

  const enumValues = schema.enum as unknown[] | undefined;
  if (enumValues?.length) return enumValues[0];

  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;

  return '';
}

interface Built {
  readonly items: unknown[];
  readonly variables: Set<string>;
  readonly count: number;
}

function buildModule(doc: Document, module: string): Built {
  const variables = new Set<string>();
  const folders = new Map<string, unknown[]>();
  let count = 0;

  for (const [path, item] of Object.entries(doc.paths)) {
    // `/api/v1/crm/customers/{id}` → folder `customers`, tail `customers/{id}`
    const tail = path.replace(new RegExp(`^/api/v\\d+/${module}/?`), '');
    const folder = tail.split('/')[0] || module;

    /*
      The URL keeps the module segment; only the version prefix is dropped.
      `{{base_url}}` is the external service root plus `/api/v1`, shared by all
      three collections — a URL built from `tail` alone resolved to
      `/api/v1/customers`, which is not a route on any service.
    */
    const urlTail = path.replace(/^\/api\/v\d+\//, '');

    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      count += 1;

      const parameters = operation.parameters ?? [];
      const segments = urlTail.split('/').filter(Boolean);

      /*
        Path parameters become collection variables named for their folder:
        `{id}` is `id` in five different folders, and one shared `{{id}}` would
        make filling in a customer id silently change which quotation the next
        request reached.
      */
      const pathSegments = segments.map((segment) => {
        const match = /^\{(.+)\}$/.exec(segment);
        if (!match) return segment;

        const variable = `${slug(folder)}_${match[1]}`;
        variables.add(variable);
        return `{{${variable}}}`;
      });

      const query = parameters
        .filter((parameter) => parameter.in === 'query')
        .map((parameter) => ({
          key: parameter.name,
          value:
            parameter.schema?.example !== undefined
              ? String(parameter.schema.example)
              : '',
          ...(parameter.required ? {} : { disabled: true }),
          ...(parameter.description
            ? { description: parameter.description }
            : {}),
        }));

      const header = parameters
        .filter((parameter) => parameter.in === 'header')
        /*
          `authorization` leaks in as a parameter wherever a handler declares
          `@Headers('authorization')`. The collection's `auth` block sends the
          bearer, and a second, hand-filled Authorization header is how a
          caller ends up sending a stale token past a good one.
        */
        .filter((parameter) => parameter.name.toLowerCase() !== 'authorization')
        /*
          `Idempotency-Key` is declared as a parameter on the three routes
          whose controller documents it, and added below to every mutation
          regardless. Taking it from both places put it in the header list
          twice, once as an empty variable and once as `{{$guid}}` — and
          Postman sends both, so the empty one could win. The one below is the
          one that works, so the declared one is dropped here.
        */
        .filter((parameter) => parameter.name.toLowerCase() !== 'idempotency-key')
        .map((parameter) => ({
          key: parameter.name,
          value: `{{${slug(parameter.name).toLowerCase()}}}`,
          ...(parameter.description
            ? { description: parameter.description }
            : {}),
        }));

      for (const entry of header) {
        variables.add(entry.value.replace(/[{}]/g, ''));
      }

      const bodySchema =
        operation.requestBody?.content?.['application/json']?.schema;

      if (bodySchema) {
        header.unshift({ key: 'Content-Type', value: 'application/json' });
      }

      /*
        Every mutation gets `Idempotency-Key`, not only the ones whose
        controller declares it in Swagger. `IdempotencyInterceptor` is global,
        so all of them honour it, and a POST that a caller retries after a lost
        response is the whole reason it exists. `{{$guid}}` is a new value per
        Send — replace it with a constant to retry the *same* intent.
      */
      if (MUTATIONS.includes(method)) {
        header.push({
          key: 'Idempotency-Key',
          value: '{{$guid}}',
          description:
            'หนึ่งค่าต่อหนึ่งเจตนา · {{$guid}} สร้างค่าใหม่ทุกครั้งที่กด Send ' +
            'ถ้าจะ retry รายการเดิมจริง ๆ ให้แทนที่ด้วยค่าคงที่ก่อนยิงซ้ำ',
        });
      }

      const raw = [
        `{{base_url}}/${pathSegments.join('/')}`,
        query.length
          ? `?${query.map((entry) => `${entry.key}=${entry.value}`).join('&')}`
          : '',
      ].join('');

      /*
        The method name off the `operationId` (`ExternalCustomersController_list`
        → `list`). Only three of CRM's seventy-four operations carry a
        `summary`, and `list — GET /customers` reads better in the sidebar than
        the path alone.
      */
      const verb = operation.operationId?.split('_').slice(1).join('_');
      const label = operation.summary ?? verb ?? method;

      const request = {
        name: `${label} — ${method.toUpperCase()} /${tail}`,
        request: {
          method: method.toUpperCase(),
          header,
          ...(bodySchema
            ? {
                body: {
                  mode: 'raw',
                  raw: JSON.stringify(
                    exampleOf(bodySchema, doc.components?.schemas ?? {}),
                    null,
                    2,
                  ),
                  options: { raw: { language: 'json' } },
                },
              }
            : {}),
          url: {
            raw,
            host: ['{{base_url}}'],
            path: pathSegments,
            ...(query.length ? { query } : {}),
          },
          ...(operation.description
            ? { description: operation.description }
            : {}),
        },
        response: [],
        event: [
          {
            listen: 'test',
            script: {
              type: 'text/javascript',
              /*
                2xx and nothing more. A generated assertion about the shape of
                the answer would be a guess about the domain; the hand-written
                collections in `backup/` are where real ones live, and new ones
                belong there too.
              */
              exec: [
                'pm.test("answers 2xx", function () {',
                '    pm.expect(pm.response.code).to.be.within(200, 299);',
                '});',
              ],
            },
          },
        ],
      };

      const bucket = folders.get(folder) ?? [];
      bucket.push(request);
      folders.set(folder, bucket);
    }
  }

  const items = [...folders]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([folder, requests], index) => ({
      name: `${index + 1}. ${folder}`,
      description:
        `\`/api/v1/${module}/${folder}\` — ${requests.length} operations. ` +
        'Fill in this folder’s id variables before running its requests.',
      item: requests,
    }));

  return { items, variables, count };
}

let wrote = 0;

for (const { module, name } of MODULES) {
  const source = join('docs', 'openapi', `external-${module}.json`);

  if (!existsSync(source)) {
    console.warn(`⚠️  ${source} ไม่มี — ข้าม ${name} (รัน \`yarn openapi\` ก่อน)`);
    continue;
  }

  const doc = JSON.parse(readFileSync(source, 'utf8')) as Document;
  const { items, variables, count } = buildModule(doc, module);

  const collection = {
    info: {
      name: `Request Form — External ${name}`,
      description:
        `${doc.info.description ?? ''}\n\n---\n\n` +
        '## ไฟล์นี้ generate มา\n\n' +
        `สร้างจาก \`docs/openapi/external-${module}.json\` ด้วย ` +
        '`yarn postman` — **แก้ในนี้แล้วจะหายตอน generate รอบหน้า** ' +
        'ถ้าต้องแก้ ให้แก้ที่ decorator ใน controller แล้วรัน ' +
        '`yarn openapi && yarn postman`\n\n' +
        '## ก่อนเริ่ม\n\n' +
        '1. import ไฟล์ environment ที่อยู่ข้างกันแล้วเลือกใช้\n' +
        '2. ขอ token ของบัญชีบริการ แล้วใส่ใน collection variable ' +
        '`access_token` (ทุก request ใช้เป็น bearer)\n' +
        '3. กรอกอีเมลใน `x-acting-user` — ต้องเป็นคนที่เคย login เว็บแล้วและ' +
        'ถูกจัดเข้าผังองค์กร ไม่งั้นได้ 404 ที่ไม่บอกเหตุผล\n' +
        '4. กรอกตัวแปร id ของ folder ที่จะยิง\n\n' +
        'แต่ละ request รันเดี่ยว ไม่ได้ส่งค่าต่อกันเป็นฉาก — ' +
        'ฉากที่เขียนมือไว้อยู่ที่ `docs/postman/backup/2026-09-16/`\n\n' +
        'test ของทุก request ยืนยันแค่ 2xx เท่านั้น',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    auth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: '{{access_token}}', type: 'string' }],
    },
    item: items,
    variable: [
      { key: 'access_token', value: '', type: 'string' },
      ...[...variables]
        .sort()
        .map((key) => ({ key, value: '', type: 'string' })),
    ],
  };

  const target = join(
    OUT_DIR,
    `Request-Form-External-${name}.postman_collection.json`,
  );
  writeFileSync(target, `${JSON.stringify(collection, null, 2)}\n`);
  wrote += 1;

  console.log(
    `${name}: ${count} requests · ${items.length} folders · ` +
      `${variables.size + 1} variables → ${target}`,
  );
}

if (!wrote) {
  console.error('ไม่ได้เขียนไฟล์ไหนเลย — รัน `yarn openapi` ก่อน');
  process.exit(1);
}
