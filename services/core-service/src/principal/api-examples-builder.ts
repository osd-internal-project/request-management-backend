/**
 * Turns the generated OpenAPI documents into copy-paste call examples.
 *
 * Pure on purpose: `scripts/generate-examples.ts` writes its output into
 * `api-examples.generated.ts`, and `api-examples.spec.ts` rebuilds it from the
 * same documents to catch a catalogue nobody regenerated.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiExample {
  operationId: string;
  tag: string;
  summary: string;
  method: HttpMethod;
  /** Without the `/api/v1` prefix, e.g. `/agent-records/{id}`. */
  path: string;
  /** The key scopes the route demands (`x-permission`), all of them. */
  scopes: string[];
  /** The route also needs a person: `X-Acting-User` or `X-User-Token`. */
  actingUser: boolean;
  query: Record<string, unknown>;
  body: unknown;
}

export interface WebhookExample {
  event: string;
  summary: string;
  body: unknown;
}

interface Schema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
}

interface Media {
  schema?: Schema;
  example?: unknown;
}

interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  example?: unknown;
  schema?: Schema;
}

interface Operation {
  operationId?: string;
  summary?: string;
  tags?: string[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, Media> };
  'x-permission'?: string[];
  'x-acting-permission'?: string[];
}

export interface OpenApiDocument {
  paths?: Record<string, Record<string, Operation>>;
  webhooks?: Record<string, { post?: Operation }>;
  components?: { schemas?: Record<string, Schema> };
}

const PREFIX = '/api/v1';
const METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
];
/** Self-referencing DTOs would otherwise recurse forever. */
const MAX_DEPTH = 8;

/** A value an integrator can send as-is: the schema's examples, else a typed placeholder. */
function sampleOf(
  schema: Schema | undefined,
  schemas: Record<string, Schema>,
  name: string,
  depth = 0,
): unknown {
  if (!schema || depth > MAX_DEPTH) return null;
  if (schema.$ref) {
    return sampleOf(
      schemas[schema.$ref.split('/').pop() ?? ''],
      schemas,
      name,
      depth + 1,
    );
  }
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.allOf) {
    return Object.assign(
      {},
      ...schema.allOf.map((part) => sampleOf(part, schemas, name, depth + 1)),
    ) as unknown;
  }
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (variant) return sampleOf(variant, schemas, name, depth + 1);

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (schema.properties || type === 'object') {
    const required = schema.properties ? (schema.required ?? []) : [];
    return Object.fromEntries(
      Object.entries(schema.properties ?? {})
        .filter(
          ([key, property]) =>
            required.includes(key) ||
            resolve(property, schemas).example !== undefined,
        )
        .map(([key, property]) => [
          key,
          sampleOf(property, schemas, key, depth + 1),
        ]),
    );
  }
  if (type === 'array')
    return [sampleOf(schema.items, schemas, name, depth + 1)];
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (schema.format === 'date-time') return '2026-10-22T03:15:02.114Z';
  if (schema.format === 'date') return '2026-10-22';
  return `<${name}>`;
}

function resolve(schema: Schema, schemas: Record<string, Schema>): Schema {
  return schema.$ref
    ? (schemas[schema.$ref.split('/').pop() ?? ''] ?? {})
    : schema;
}

function bodyOf(
  operation: Operation,
  schemas: Record<string, Schema>,
): unknown {
  const media = operation.requestBody?.content?.['application/json'];
  if (!media) return null;
  return media.example ?? sampleOf(media.schema, schemas, 'body');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every key-gated route of the external document; MCP is a protocol, not a call to paste. */
export function buildApiExamples(document: OpenApiDocument): ApiExample[] {
  const schemas = document.components?.schemas ?? {};
  const examples: ApiExample[] = [];

  for (const [fullPath, item] of Object.entries(document.paths ?? {})) {
    const path = fullPath.startsWith(PREFIX)
      ? fullPath.slice(PREFIX.length)
      : fullPath;
    if (path === '/mcp' || path.startsWith('/mcp/')) continue;

    for (const [verb, operation] of Object.entries(item)) {
      const method = verb.toUpperCase() as HttpMethod; // narrowed by the includes check below
      const scopes = operation['x-permission'] ?? [];
      if (!METHODS.includes(method) || !scopes.length) continue;

      examples.push({
        operationId: operation.operationId ?? `${method} ${path}`,
        tag: operation.tags?.[0] ?? '',
        summary: operation.summary ?? '',
        method,
        path,
        scopes: [...scopes],
        actingUser: (operation['x-acting-permission'] ?? []).length > 0,
        query: Object.fromEntries(
          (operation.parameters ?? [])
            .filter((param) => param.in === 'query' && param.required)
            .map((param) => [
              param.name,
              param.example ?? sampleOf(param.schema, schemas, param.name),
            ]),
        ),
        body: bodyOf(operation, schemas),
      });
    }
  }

  return examples.sort(
    (left, right) =>
      compare(left.tag, right.tag) ||
      compare(left.path, right.path) ||
      METHODS.indexOf(left.method) - METHODS.indexOf(right.method),
  );
}

/** One delivery body per event, in the document's order (the event catalog's). */
export function buildWebhookExamples(
  document: OpenApiDocument,
): WebhookExample[] {
  const schemas = document.components?.schemas ?? {};
  return Object.entries(document.webhooks ?? {}).map(([event, item]) => ({
    event,
    summary: item.post?.summary ?? '',
    body: item.post ? bodyOf(item.post, schemas) : null,
  }));
}
