/**
 * Turn the external OpenAPI document into function-calling tool definitions.
 *
 * The chatbot's "tools" were a prose table of eight rows inside a system
 * prompt. That is what a model has to work from when nothing structured
 * exists, and the v1 prompt records what happened: *"v1 ไม่เคยบอกปลายทางที่จะ
 * ยิง ⇒ บอทเรียกอะไรไม่ได้เลย จึงเดาคำตอบ"*. v2 wrote the endpoints into the
 * prose, which helped, but a description is still not a contract — the model
 * assembles the call either way.
 *
 * Generated rather than written, for the reason `docs/openapi/external-api.json`
 * is generated: a hand-kept copy drifts, and the first symptom is a tool that
 * describes a parameter the server does not accept. Run it after `yarn openapi`.
 *
 * The shape is the one Anthropic and OpenAI both accept — `name`,
 * `description`, and a JSON Schema of the inputs. Path, query and body
 * parameters are flattened into one object, because a model fills in one form,
 * not three; `x-request` records where each one belongs so the caller can put
 * it back.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = join('docs', 'openapi', 'external-api.json');
const TARGET = join('docs', 'openapi', 'external-tools.json');

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
}

const document = JSON.parse(readFileSync(SOURCE, 'utf8')) as {
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, JsonSchema> };
};

const schemas = document.components?.schemas ?? {};

/**
 * Resolve `$ref` so a tool carries its own schema.
 *
 * A model is handed one definition at a time and cannot follow a pointer into
 * a components section it never receives. Cycles are cut rather than followed:
 * the request DTOs are trees today, and a self-referential one would hang the
 * generator rather than produce a bad tool.
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
 * The modules of external-service that become tools, in order.
 *
 * Not simply "every path in the document". `external-api.json` is the REST
 * contract and carries all of `request`, `crm` and `approval`; a tool
 * catalogue is a different thing — it is a menu handed to a language model,
 * and CRM alone would add seventy-two entries covering segment dimensions,
 * KYC product rules and company configuration. A model choosing from eighty
 * tools chooses worse than one choosing from ten, so which CRM operations
 * belong in a *chat* surface is a product decision, not a consequence of
 * having exposed them over REST.
 *
 * Add a module here when that decision is made; `McpToolRegistry` will then
 * refuse to boot until each new tool has a handler, which is the intended
 * order of events.
 */
const TOOL_MODULES = ['request'] as const;

/**
 * Routes that are in the module but not in the catalogue, because there is
 * nobody at the other end of them.
 *
 * MCP resolves *a person* per tool call — either from their own token or from
 * `X-Acting-User` — so a robot-only route has no caller it can be offered to.
 * `POST /request/intake` raises a request in the *system's* name with
 * `source: "system"`, which is the opposite of what a tool call is: a person
 * asking a model to do something for them. A model reaching it would file
 * requests that nobody raised.
 *
 * `api/v1/crm/leads*` and `api/v1/approval/cases` are the other robot-only
 * routes and are excluded already, by their modules not being listed above.
 */
const ROBOT_ONLY = ['/request/intake'];

/**
 * `GET /api/v1/request/requests/{ref}/actions` → `request_get_requests_ref_actions`.
 *
 * The module prefix is what keeps `crm_get_leads` and `request_get_requests`
 * from colliding the day CRM joins the catalogue, and it tells a model which
 * surface it is reaching.
 *
 * **Underscore, not a dot.** `request.get_requests` reads better but tool
 * names are validated against `^[a-zA-Z0-9_-]{1,64}$` by the Claude API and
 * others like it, so a dotted name is rejected before the model ever sees it.
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

/** Whether this path belongs to a module the catalogue covers. */
function inCatalogue(path: string): boolean {
  const withoutVersion = path.replace(/^\/api\/v\d+/, '');

  if (ROBOT_ONLY.includes(withoutVersion)) return false;

  return (TOOL_MODULES as readonly string[]).includes(
    withoutVersion.split('/')[1],
  );
}

const tools: Tool[] = [];

for (const [path, methods] of Object.entries(document.paths)) {
  if (!inCatalogue(path)) continue;

  for (const [method, operation] of Object.entries(methods)) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const parameter of operation.parameters ?? []) {
      // Headers are the transport's business — the caller sets them once, and
      // a model asked to fill in `Authorization` is a model inventing a token.
      if (parameter.in === 'header') continue;

      properties[parameter.name] = {
        ...inline(parameter.schema),
        ...(parameter.description ? { description: parameter.description } : {}),
      };

      if (parameter.required) required.push(parameter.name);
    }

    const body = inline(operation.requestBody?.content?.['application/json']?.schema);

    for (const [key, value] of Object.entries(body.properties ?? {})) {
      properties[key] = value;
    }

    if (operation.requestBody?.required) required.push(...(body.required ?? []));

    tools.push({
      /*
        Derived from the route, not from `operationId`. Nest generates
        `ExternalController_actions`, which names the class that happens to
        host the handler — a model choosing between ten of those is choosing
        between suffixes. `get_requests_ref_actions` says what it does.
      */
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
    });
  }
}

tools.sort((left, right) => left.name.localeCompare(right.name));

writeFileSync(TARGET, `${JSON.stringify(tools, null, 2)}\n`);

console.log(`${TARGET}: ${tools.length} tool(s)`);
for (const tool of tools) {
  const count = Object.keys(tool.input_schema.properties ?? {}).length;
  console.log(`  ${tool.name} — ${count} input(s)`);
}
