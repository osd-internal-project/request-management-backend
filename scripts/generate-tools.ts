/**
 * Turn the external OpenAPI document into function-calling tool definitions.
 * Run after `yarn openapi` — a hand-kept catalogue drifts from the real params.
 *
 * Shape is the one Anthropic and OpenAI both accept. Path, query and body
 * params are flattened into one object because a model fills in one form;
 * `x-request` records where each belongs so the caller can put it back.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET = join('docs', 'openapi', 'external-tools.json');

/**
 * Robot-only routes: every tool call resolves a person, and intake raises a
 * request as `source: "system"`, so there is no caller to offer it to. The
 * workflow engine's two CRM routes are the same case — nobody at the far end.
 */
const ROBOT_ONLY = [
  '/request/intake',
  // CD-66 customer intake — scope `integration.request.intake`, no acting user (AGENTS.md).
  '/request/intake/web-forms/{slug}',
  '/request/intake/channels/{channel}',
  '/request/intake/status/{token}',
  '/crm/leads/intake',
  '/crm/leads/{id}/facts',
  '/crm/leads/{id}/stage',
];

/**
 * CRM's share of the menu, chosen rather than taken whole.
 *
 * A tool catalogue is a menu handed to a model, not the REST contract: CRM has
 * 62 paths and offering all of them makes the model choose worse, not better.
 * These are the ones a salesperson actually does in a chat — look something
 * up, take a lead, move it, log a call, open an opportunity.
 *
 * Widening this list is the whole cost of adding a CRM tool: the generator
 * picks it up, and `McpToolRegistry` refuses to boot until a handler exists.
 */
const CRM_IN_CHAT = [
  'GET /crm/customers',
  'GET /crm/customers/{id}',
  'GET /crm/customers/{id}/summary',
  'GET /crm/leads/statuses',
  'GET /crm/leads',
  'POST /crm/leads',
  'GET /crm/leads/{id}',
  'PATCH /crm/leads/{id}/owner',
  'PATCH /crm/leads/{id}/status',
  'POST /crm/leads/{id}/activities',
  'POST /crm/leads/{id}/convert',
  'GET /crm/opportunities',
  'POST /crm/opportunities',
  'GET /crm/opportunities/{id}',
  'GET /crm/quotations',
  'GET /crm/quotations/{id}',
];

/** A document the catalogue is built from, and how much of it is taken. */
interface Source {
  readonly file: string;
  /** `METHOD /path` without the version prefix; absent = every route. */
  readonly only?: readonly string[];
}

/** การเบิก in chat: read only — paying and closing stay with accounting on the screen. */
const DISBURSEMENT_IN_CHAT = [
  'GET /disbursement/disbursements',
  'GET /disbursement/disbursements/{docNo}',
];

const SOURCES: readonly Source[] = [
  { file: 'external-request.json' },
  { file: 'external-crm.json', only: CRM_IN_CHAT },
  { file: 'external-disbursement.json', only: DISBURSEMENT_IN_CHAT },
  // CD-276 — every assistant route is a chat question by design
  { file: 'external-assistant.json' },
];

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  $ref?: string;
  [key: string]: unknown;
}

interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  /** ประตูที่สอง — สิทธิ์ของคนใน `X-Acting-User` (ประทับโดย `yarn openapi`). */
  'x-acting-permission'?: string[];
  /** ประตูแรก — scope ของ key (ประทับโดย `yarn openapi`). */
  'x-permission'?: string[];
  /** ชุดกฎปกปิดของคำตอบ route นี้ (ประทับโดย `yarn openapi`). */
  'x-sensitive-resource'?: string;
  parameters?: Parameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
}

interface Tool {
  name: string;
  description: string;
  input_schema: JsonSchema;
  'x-request': { method: string; path: string };
  /**
   * สิทธิ์ที่คนใน `X-Acting-User` ต้องถือ — ประตูที่สองของ MCP.
   *
   * REST ได้ประตูนี้จาก `ActingPolicyGuard` ซึ่ง MCP ใช้ไม่ได้ เพราะตัวตนของคน
   * ถูก resolve ต่อ *การเรียก tool* ไม่ใช่ต่อ HTTP request (`mcp-actor.ts`)
   * `McpToolRegistry.call` จึงตรวจจากค่านี้แทน
   *
   * ว่าง = route นั้นตรวจสิทธิ์ข้างในเอง เช่น `POST requests/:ref/actions/:action`
   * ที่หนึ่ง route ทำสิบสี่กริยาและอ่าน `ACTION_PERMISSIONS` ใน `perform`
   */
  'x-acting-permission': string[];
  /** scope ของ key ที่ route ถาม — MCP ตรวจกับ key เหมือน `PolicyGuard`. */
  'x-permission': string[];
  /**
   * ชุดกฎปกปิด SCOPE-04 ที่ต้องใช้กับคำตอบของ tool นี้ — ว่าง = ไม่มีฟิลด์อ่อนไหว.
   *
   * ฝั่ง REST `SensitiveFieldInterceptor` อ่านค่านี้จาก metadata ของ handler เอง
   * แต่ MCP เรียก service ตรง ๆ ไม่ผ่าน response pipeline ค่านี้จึงต้องเดินทางมากับ
   * tool ไม่งั้นเลขผู้เสียภาษี (CM-08) และ margin จะหลุดออกทางประตูที่สอง
   */
  'x-sensitive-resource': string;
}

interface Document {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

/**
 * `$ref` resolves against the document being read, so the table is swapped per
 * source. Merging every document's schemas into one map would make two modules
 * that both declare `CreateLeadDto` resolve to whichever loaded last.
 */
let schemas: Record<string, JsonSchema> = {};

/**
 * Resolve `$ref` so a tool carries its own schema — a model never receives the
 * components section to follow a pointer into. Cycles are cut, not followed.
 */
function inline(schema: JsonSchema | undefined, seen = new Set<string>()): JsonSchema {
  if (!schema) return {};

  if (typeof schema.$ref === 'string') {
    const name = schema.$ref.split('/').pop() ?? '';

    if (seen.has(name)) return { type: 'object' };

    return inline(schemas[name], new Set([...seen, name]));
  }

  const resolved: JsonSchema = { ...schema };

  if (schema.properties) {
    resolved.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [
        key,
        inline(value, seen),
      ]),
    );
  }

  if (schema.items) resolved.items = inline(schema.items, seen);

  return resolved;
}

/**
 * `GET /api/v1/request/requests/{ref}/actions` → `request_get_requests_ref_actions`.
 *
 * Module prefix keeps `crm_get_leads` and `request_get_leads` from colliding.
 * Underscore not dot: tool names must match `^[a-zA-Z0-9_-]{1,64}$`.
 */
function nameOf(method: string, path: string): string {
  const withoutPrefix = path.replace(/^\/api\/v\d+\//, '');
  const [module] = withoutPrefix.split('/');
  const tail = withoutPrefix
    .slice(module.length)
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  return `${module}_${method}_${tail || 'root'}`.toLowerCase();
}

/** Whether this route becomes a tool. */
function inCatalogue(
  method: string,
  path: string,
  only: readonly string[] | undefined,
): boolean {
  const bare = path.replace(/^\/api\/v\d+/, '');

  if (ROBOT_ONLY.includes(bare)) return false;

  return !only || only.includes(`${method.toUpperCase()} ${bare}`);
}

const tools: Tool[] = [];

for (const source of SOURCES) {
  const document = JSON.parse(
    readFileSync(join('docs', 'openapi', source.file), 'utf8'),
  ) as Document;

  schemas = document.components?.schemas ?? {};

  /*
    A named route that the document no longer has is a silent shrinking menu:
    somebody renames `crm/leads/:id/owner` and the tool disappears with nothing
    to say so. Collected here and reported after the walk.
  */
  const unseen = new Set(source.only ?? []);

  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      const bare = `${method.toUpperCase()} ${path.replace(/^\/api\/v\d+/, '')}`;
      unseen.delete(bare);

      if (!inCatalogue(method, path, source.only)) continue;

      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const parameter of operation.parameters ?? []) {
        // Headers are the caller's job; a model asked for `Authorization`
        // invents a token.
        if (parameter.in === 'header') continue;

        properties[parameter.name] = {
          ...inline(parameter.schema),
          ...(parameter.description
            ? { description: parameter.description }
            : {}),
        };

        if (parameter.required) required.push(parameter.name);
      }

      const body = inline(
        operation.requestBody?.content?.['application/json']?.schema,
      );

      for (const [key, value] of Object.entries(body.properties ?? {})) {
        properties[key] = value;
      }

      if (operation.requestBody?.required) {
        required.push(...(body.required ?? []));
      }

      tools.push({
        // From the route, not `operationId`: Nest emits
        // `ExternalController_actions`, which names the class, not the action.
        name: nameOf(method, path),
        description: [operation.summary, operation.description]
          .filter(Boolean)
          .join(' — '),
        input_schema: {
          type: 'object',
          properties,
          ...(required.length ? { required: [...new Set(required)] } : {}),
        },
        'x-request': { method: method.toUpperCase(), path },
        'x-acting-permission': operation['x-acting-permission'] ?? [],
        'x-permission': operation['x-permission'] ?? [],
        'x-sensitive-resource': operation['x-sensitive-resource'] ?? '',
      });
    }
  }

  for (const route of unseen) {
    console.warn(`  ⚠ ${source.file}: ไม่มี route ${route} แล้ว — tool หายไปเงียบ ๆ`);
  }
}

tools.sort((left, right) => left.name.localeCompare(right.name));

writeFileSync(TARGET, `${JSON.stringify(tools, null, 2)}\n`);

console.log(`${TARGET}: ${tools.length} tool(s)`);
for (const tool of tools) {
  const count = Object.keys(tool.input_schema.properties ?? {}).length;
  const masked = tool['x-sensitive-resource'];
  console.log(
    `  ${tool.name} — ${count} input(s)${masked ? ` · ปกปิด ${masked}` : ''}`,
  );
}
