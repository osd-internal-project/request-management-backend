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

// One document per module, so picking this file is what limits the catalogue
// to `request`. See ROBOT_ONLY for why CRM is left out.
const SOURCE = join('docs', 'openapi', 'external-request.json');
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
 * Robot-only routes: every tool call resolves a person, and intake raises a
 * request as `source: "system"`, so there is no caller to offer it to.
 *
 * Only intake is named here — `crm/leads*` and `approval/cases` live in
 * documents this script never reads.
 *
 * A tool catalogue is a menu for a model, not the REST contract: CRM alone
 * would add ~74 entries, and which of them belong in chat is a product call.
 * To add a module, read its document here too.
 */
const ROBOT_ONLY = ['/request/intake'];

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

/** Whether this path becomes a tool. */
function inCatalogue(path: string): boolean {
  return !ROBOT_ONLY.includes(path.replace(/^\/api\/v\d+/, ''));
}

const tools: Tool[] = [];

for (const [path, methods] of Object.entries(document.paths)) {
  if (!inCatalogue(path)) continue;

  for (const [method, operation] of Object.entries(methods)) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];

    for (const parameter of operation.parameters ?? []) {
      // Headers are the caller's job; a model asked for `Authorization`
      // invents a token.
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
