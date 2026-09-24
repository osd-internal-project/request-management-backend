import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import {
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import type {
  ParameterObject,
  ReferenceObject,
  SchemaObject,
} from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { getMetadataStorage } from 'class-validator';
import type { ValidationMetadata } from 'class-validator/types/metadata/ValidationMetadata';
import type { MetadataStorage as TransformerStorage } from 'class-transformer/types/MetadataStorage';

// subpath นี้ไม่มีไฟล์ .d.ts ของตัวเอง — ชนิดยืมจาก types/ ของแพ็กเกจเดียวกัน
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultMetadataStorage } = require('class-transformer/cjs/storage') as {
  defaultMetadataStorage: TransformerStorage;
};

/** handler หนึ่งตัวที่ Nest ผูกกับ route คีย์ด้วย `METHOD /path` แบบ OpenAPI. */
export interface RouteHandler {
  readonly key: string;
  readonly controller: Function;
  readonly methodName: string;
  readonly handler: Function;
}

/** ทุก route ที่แอปนี้ register — ที่เดียวที่แปลง metadata ของ Nest เป็นคีย์ OpenAPI. */
export function routesOf(app: INestApplication, prefix: string): RouteHandler[] {
  // `ModulesContainer` เป็น core provider ที่มีอยู่เสมอ ต่างจาก `DiscoveryService`
  // ซึ่งต้อง import `DiscoveryModule` เข้ามาก่อน — และแอปนี้ไม่ได้ import
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const join = (...parts: string[]) =>
    `/${parts.filter((part) => part && part !== '/').join('/')}`
      .replace(/\/+/g, '/')
      .replace(/:([^/]+)/g, '{$1}');

  const routes: RouteHandler[] = [];
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Function | null;
      if (!controller) continue;
      const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as
        | string
        | undefined;
      const proto = controller.prototype as Record<string, unknown>;

      for (const methodName of scanner.getAllMethodNames(proto)) {
        const handler = proto[methodName];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          | number
          | undefined;
        if (method === undefined) continue;
        const routePath = Reflect.getMetadata(PATH_METADATA, handler) as
          | string
          | undefined;
        const path = join(prefix, controllerPath ?? '', routePath ?? '');
        routes.push({
          key: `${RequestMethod[method]} ${path}`,
          controller,
          methodName,
          handler,
        });
      }
    }
  }
  return routes;
}

/** สิ่งที่ class-validator รู้เกี่ยวกับ DTO หนึ่งตัว ในรูปที่ OpenAPI อ่านได้. */
interface Derived {
  readonly properties: Record<string, SchemaObject>;
  readonly optional: ReadonlySet<string>;
  readonly nested: ReadonlyMap<string, { cls: Function; array: boolean }>;
}

const PRIMITIVES = new Set<Function>([Object, String, Number, Boolean, Array]);

/** แปลง decorator หนึ่งตัวเป็น keyword ของ JSON Schema — เติมเฉพาะช่องที่ว่าง. */
function applyConstraint(meta: ValidationMetadata, schema: SchemaObject): void {
  const [first, second] = meta.constraints ?? [];
  switch (meta.name) {
    case 'isIn': {
      const values = first as unknown[];
      schema.enum ??= [...values];
      schema.type ??= typeof values[0] === 'number' ? 'number' : 'string';
      break;
    }
    case 'isEnum':
      schema.enum ??= Array.isArray(second) ? [...second] : Object.values(first as object);
      schema.type ??= 'string';
      break;
    case 'maxLength':
      schema.maxLength ??= first as number;
      schema.type ??= 'string';
      break;
    case 'minLength':
      schema.minLength ??= first as number;
      break;
    case 'isNotEmpty':
      if (schema.type === 'string' || schema.type === undefined) schema.minLength ??= 1;
      break;
    case 'min':
      schema.minimum ??= first as number;
      break;
    case 'max':
      schema.maximum ??= first as number;
      break;
    case 'matches':
      schema.pattern ??= first instanceof RegExp ? first.source : String(first);
      schema.type ??= 'string';
      break;
    case 'isEmail':
      schema.format ??= 'email';
      schema.type ??= 'string';
      break;
    case 'isDateString':
    case 'isISO8601':
      schema.format ??= 'date-time';
      schema.type ??= 'string';
      break;
    case 'isUUID':
      schema.format ??= 'uuid';
      schema.type ??= 'string';
      break;
    case 'isInt':
      // ApiProperty เดา `number` จากชนิด TS — ตัวที่ตัดสินจริงคือ validator
      if (schema.type === undefined || schema.type === 'number') schema.type = 'integer';
      break;
    case 'isNumber':
      schema.type ??= 'number';
      break;
    case 'isString':
      schema.type ??= 'string';
      break;
    case 'isBoolean':
      schema.type ??= 'boolean';
      break;
    case 'isArray':
      schema.type = 'array';
      break;
    case 'arrayMaxSize':
      schema.maxItems ??= first as number;
      break;
    case 'arrayMinSize':
      schema.minItems ??= first as number;
      break;
  }
}

function derive(cls: Function): Derived {
  const storage = getMetadataStorage();
  const byProperty = storage.groupByPropertyName(
    storage.getTargetValidationMetadatas(cls, '', false, false),
  );

  const properties: Record<string, SchemaObject> = {};
  const optional = new Set<string>();
  const nested = new Map<string, { cls: Function; array: boolean }>();

  for (const [name, metas] of Object.entries(byProperty)) {
    const schema: SchemaObject = {};
    for (const meta of metas) {
      if (meta.type === 'conditionalValidation') optional.add(name);
      if (meta.type !== 'customValidation') continue;
      if (meta.each) {
        schema.type = 'array';
        const items = (schema.items ??= {}) as SchemaObject;
        applyConstraint(meta, items);
      } else {
        applyConstraint(meta, schema);
      }
    }

    if (metas.some((meta) => meta.type === 'nestedValidation')) {
      const typeMeta = defaultMetadataStorage.findTypeMetadata(cls, name);
      const target = typeMeta?.typeFunction();
      if (typeof target === 'function' && !PRIMITIVES.has(target)) {
        nested.set(name, { cls: target, array: schema.type === 'array' });
      }
    }
    properties[name] = schema;
  }

  return { properties, optional, nested };
}

/** ตัวนับที่ log ออกมา — กลไกนี้หลุดทั้งชุดเมื่อไรจะเห็นเป็นเลขศูนย์ทันที. */
export interface EnrichStats {
  constraints: number;
  properties: number;
  queryParams: number;
  requiredFixed: number;
}

function fillMissing(target: SchemaObject, source: SchemaObject, stats: EnrichStats): void {
  for (const [key, value] of Object.entries(source) as [keyof SchemaObject, unknown][]) {
    if (key === 'items') continue;
    if (key === 'type' && target.type === 'number' && value === 'integer') {
      target.type = 'integer';
      stats.constraints += 1;
      continue;
    }
    if (target[key] === undefined) {
      (target as Record<string, unknown>)[key] = value;
      stats.constraints += 1;
    }
  }
  if (source.items) {
    const items = (target.items ??= {}) as SchemaObject | ReferenceObject;
    if (!('$ref' in items)) fillMissing(items, source.items as SchemaObject, stats);
  }
}

function refTo(
  cls: Function,
  document: OpenAPIObject,
  stats: EnrichStats,
  seen: Set<Function>,
): ReferenceObject {
  enrichSchema(cls.name, cls, document, stats, seen);
  return { $ref: `#/components/schemas/${cls.name}` };
}

/**
 * เติมข้อจำกัดของ class-validator ลง schema ของ DTO.
 * `required` เชื่อ validator เพราะมันคือตัวที่ปฏิเสธ request จริง ไม่ใช่ `@ApiProperty`.
 */
function enrichSchema(
  name: string,
  cls: Function,
  document: OpenAPIObject,
  stats: EnrichStats,
  seen: Set<Function>,
): void {
  if (seen.has(cls)) return;
  seen.add(cls);

  const schemas = (document.components ??= {}).schemas ??= {};
  const target = (schemas[name] ??= { type: 'object' }) as SchemaObject;
  const properties = (target.properties ??= {}) as Record<
    string,
    SchemaObject | ReferenceObject
  >;
  const derived = derive(cls);

  for (const [prop, schema] of Object.entries(derived.properties)) {
    const existing = properties[prop];
    if (!existing) {
      properties[prop] = schema;
      stats.properties += 1;
    } else if (!('$ref' in existing)) {
      fillMissing(existing, schema, stats);
    }

    const inner = derived.nested.get(prop);
    const current = properties[prop];
    if (inner && !('$ref' in current)) {
      const ref = refTo(inner.cls, document, stats, seen);
      if (inner.array) {
        const items = current.items as SchemaObject | ReferenceObject | undefined;
        if (!items || !('$ref' in items)) current.items = ref;
      } else if (!current.allOf) {
        current.allOf = [ref];
      }
    }
  }

  const required = new Set(target.required ?? []);
  for (const prop of Object.keys(derived.properties)) {
    const want = !derived.optional.has(prop);
    if (want !== required.has(prop)) stats.requiredFixed += 1;
    if (want) required.add(prop);
    else required.delete(prop);
  }
  if (required.size) target.required = [...required].sort();
  else delete target.required;
}

/** DTO ที่ handler รับทั้งก้อนผ่าน `@Body()` / `@Query()` — ไม่นับตัวที่ระบุชื่อฟิลด์เดี่ยว. */
function argumentDtos(route: RouteHandler): { body?: Function; query?: Function } {
  const args = (Reflect.getMetadata(
    ROUTE_ARGS_METADATA,
    route.controller,
    route.methodName,
  ) ?? {}) as Record<string, { index: number; data?: unknown }>;
  const types = (Reflect.getMetadata(
    'design:paramtypes',
    route.controller.prototype as object,
    route.methodName,
  ) ?? []) as unknown[];

  const found: { body?: Function; query?: Function } = {};
  for (const [key, arg] of Object.entries(args)) {
    if (arg.data !== undefined) continue;
    const kind = Number(key.split(':')[0]);
    const type = types[arg.index];
    if (typeof type !== 'function' || PRIMITIVES.has(type)) continue;
    if (kind === RouteParamtypes.BODY) found.body = type;
    if (kind === RouteParamtypes.QUERY) found.query = type;
  }
  return found;
}

function enrichQuery(
  operation: { parameters?: (ParameterObject | ReferenceObject)[] },
  cls: Function,
  stats: EnrichStats,
): void {
  const parameters = (operation.parameters ??= []);
  const derived = derive(cls);

  for (const [name, schema] of Object.entries(derived.properties)) {
    const required = !derived.optional.has(name);
    const existing = parameters.find(
      (p): p is ParameterObject => !('$ref' in p) && p.in === 'query' && p.name === name,
    );
    if (existing) {
      const current = (existing.schema ??= {}) as SchemaObject | ReferenceObject;
      if (!('$ref' in current)) fillMissing(current, schema, stats);
      continue;
    }
    parameters.push({
      name,
      in: 'query',
      required,
      schema: { type: 'string', ...schema },
    });
    stats.queryParams += 1;
  }
}

/**
 * Swagger อ่านแค่ `@ApiProperty` — enum ขอบเขต และ format ที่ประกาศด้วย class-validator
 * หายไปจากเอกสารทั้งหมด ฟังก์ชันนี้เติมกลับจาก metadata ที่ ValidationPipe ใช้จริง.
 */
export function enrichFromValidators(
  app: INestApplication,
  document: OpenAPIObject,
  prefix: string,
): EnrichStats {
  const stats: EnrichStats = { constraints: 0, properties: 0, queryParams: 0, requiredFixed: 0 };
  const seen = new Set<Function>();

  for (const route of routesOf(app, prefix)) {
    const [verb, path] = route.key.split(' ');
    const operation = (document.paths[path] as Record<string, unknown> | undefined)?.[
      verb.toLowerCase()
    ] as
      | {
          parameters?: (ParameterObject | ReferenceObject)[];
          requestBody?: { content?: Record<string, { schema?: SchemaObject | ReferenceObject }> };
        }
      | undefined;
    if (!operation) continue;

    const dtos = argumentDtos(route);
    if (dtos.query) enrichQuery(operation, dtos.query, stats);

    if (dtos.body) {
      const schema = operation.requestBody?.content?.['application/json']?.schema;
      const ref = schema && '$ref' in schema ? schema.$ref.split('/').pop() : undefined;
      enrichSchema(ref ?? dtos.body.name, dtos.body, document, stats, seen);
    }
  }
  return stats;
}
