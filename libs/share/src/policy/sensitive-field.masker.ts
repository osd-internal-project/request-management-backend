import { Inject, Injectable, Optional } from '@nestjs/common';
import { Principal } from '../context/principal';

/** SCOPE-05: something to record an unmasked read against. */
export interface SensitiveReadRecorder {
  recordSensitiveRead(
    actor: Principal,
    resource: string,
    resourceId: string,
    fields: readonly string[],
  ): Promise<void>;
}

export const SENSITIVE_READ_RECORDER = Symbol('SENSITIVE_READ_RECORDER');

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Containers that hold a record's own field values.
 *
 * A sensitive field is rarely at the top level: a request keeps its answers in
 * `formData`, an approval case keeps the data a decision binds to in
 * `payload`. Masking only the top level leaves the margin one nesting level
 * away — visibly handled, actually exposed.
 *
 * Both spellings are listed because the two halves of the system disagree:
 * Prisma hands back `formData`, while the §11.1 API contract serialises
 * `form_data`. Covering only one is how a field stays masked on one endpoint
 * and leaks on another.
 */
const NESTED_CONTAINERS = [
  'formData',
  'form_data',
  'payload',
  'typeSnapshot',
  'type_snapshot',
  'snapshot',
  'data',
];

/**
 * SCOPE-04 — removes sensitive fields the caller may not see, **from the
 * response body**.
 *
 * The document is explicit that this is not a UI concern: *"ผู้ไม่มีสิทธิ์เห็น
 * ค่าถูกปกปิด ทั้งใน API response ไม่ใช่แค่หน้าจอ"*. Hiding a margin in the
 * browser leaves it one `curl` away; removing it here means it was never sent.
 *
 * Fields are **deleted** rather than nulled, so a client cannot distinguish
 * "withheld" from "absent" and infer that a value exists.
 *
 * SCOPE-05: when a field *is* unmasked, the read is recorded — that is the
 * "who looked at whose data" trail PDPA builds on later.
 */
@Injectable()
export class SensitiveFieldMasker {
  constructor(
    @Optional()
    @Inject(SENSITIVE_READ_RECORDER)
    private readonly recorder?: SensitiveReadRecorder,
  ) {}

  /**
   * `body` with everything `principal` may not see removed.
   *
   * Lives here rather than inside the interceptor because masking is a
   * property of the *answer*, not of HTTP: MCP reaches the same services
   * without a response pipeline, and a rule enforced on only one of the two
   * doors is not enforced. The interceptor is now this plus the metadata
   * lookup that tells it which resource a handler returns.
   */
  mask(resource: string, body: unknown, principal: Principal): unknown {
    if (resource.includes('{'))
      return this.maskPerRow(resource, body, principal);

    return this.maskMatching(
      (entryResource) => entryResource === resource,
      resource,
      body,
      principal,
    );
  }

  /** The rules whose resource satisfies `applies`, applied to `body`. */
  private maskMatching(
    applies: (entryResource: string) => boolean,
    resource: string,
    body: unknown,
    principal: Principal,
  ): unknown {
    const fieldsOf = (entries: readonly string[]) =>
      entries.flatMap((entry) => {
        const dot = entry.lastIndexOf('.');
        return dot > 0 && applies(entry.slice(0, dot))
          ? [entry.slice(dot + 1)]
          : [];
      });

    const declared = [...new Set(fieldsOf(principal.sensitiveFieldsAll))];

    if (!declared.length) return body;

    const visible = new Set(fieldsOf(principal.sensitiveFieldsVisible));

    const masked = declared.filter((field) => !visible.has(field));

    return this.apply(body, masked, [...visible], resource, principal);
  }

  /**
   * A resource naming a row field — `request:{typeCode}` — resolves per row.
   *
   * Masking rules are configured per request type, and one list holds many
   * types. A fixed `request:DSC` on the list would mask DSC rows and leave
   * every other type's configured fields in the clear; a fixed one on the
   * detail route did exactly that for any type but DSC (CD-127).
   *
   * Stays a string so the OpenAPI/MCP catalogue carries it unchanged and the
   * MCP door masks the same way the HTTP one does.
   */
  private maskPerRow(
    template: string,
    body: unknown,
    principal: Principal,
  ): unknown {
    const one = (row: unknown): unknown => {
      if (!isPlainObject(row)) return row;
      const resolved = resolveTemplate(template, row);
      if (resolved) return this.mask(resolved, row, principal);

      // A row the template cannot name gets every rule under the prefix —
      // failing closed, since not knowing the type is no reason to show it.
      const prefix = template.slice(0, template.indexOf('{'));
      return this.maskMatching(
        (entryResource) => entryResource.startsWith(prefix),
        template,
        row,
        principal,
      );
    };

    if (Array.isArray(body)) return body.map(one);
    if (isPlainObject(body) && Array.isArray(body.data)) {
      return { ...body, data: body.data.map(one) };
    }
    return one(body);
  }

  private apply(
    body: unknown,
    masked: string[],
    visible: string[],
    resource: string,
    principal: Principal,
  ): unknown {
    if (Array.isArray(body)) {
      return body.map((item) =>
        this.apply(item, masked, visible, resource, principal),
      );
    }

    if (!isPlainObject(body)) return body;

    // The §11.1 pagination envelope — mask the rows, leave the metadata.
    if (Array.isArray(body.data)) {
      return {
        ...body,
        data: body.data.map((item) =>
          this.apply(item, masked, visible, resource, principal),
        ),
      };
    }

    const result = { ...body };

    for (const field of masked) {
      delete result[field];

      /*
        A record whose own rows sit at the top level — a quotation's `lines`
        (CD-76) carry `unitCost` per row, not inside a form container. Same
        one-level rule as the container walk below: rows of a top-level array
        are masked, nothing deeper.
      */
      for (const [key, value] of Object.entries(result)) {
        if (!Array.isArray(value) || NESTED_CONTAINERS.includes(key)) continue;

        result[key] = (value as unknown[]).map((row): unknown => {
          if (!isPlainObject(row) || !(field in row)) return row;

          const cell = { ...row };
          delete cell[field];
          return cell;
        });
      }

      for (const container of NESTED_CONTAINERS) {
        const nested = result[container];
        if (!isPlainObject(nested)) continue;

        const copy = { ...nested };
        delete copy[field];

        /*
          A table field holds its answers in rows, and a sensitive column lives
          inside one — `form_data.lines[0].unit_price`, never at the level
          above. Masking stopped at the container, so declaring a column
          sensitive would have looked handled and leaked every row.

          One level down, matching the schema rule that refuses a table inside
          a table: walking arbitrarily deep here would let a large payload turn
          every masked read into a full tree walk.
        */
        for (const [key, value] of Object.entries(copy)) {
          if (!Array.isArray(value)) continue;

          copy[key] = (value as unknown[]).map((row): unknown => {
            if (!isPlainObject(row) || !(field in row)) return row;

            const cell = { ...row };
            delete cell[field];
            return cell;
          });
        }

        result[container] = copy;
      }
    }

    this.recordIfUnmasked(result, visible, resource, principal);

    return result;
  }

  private recordIfUnmasked(
    body: Record<string, unknown>,
    visible: string[],
    resource: string,
    principal: Principal,
  ): void {
    if (!this.recorder || !visible.length) return;

    const nested = NESTED_CONTAINERS.map((container) => body[container]).filter(
      isPlainObject,
    );

    /** Rows of a table field — where a sensitive column actually sits. */
    const rows = [body, ...nested].flatMap((container) =>
      Object.values(container)
        .filter(Array.isArray)
        .flat()
        .filter(isPlainObject),
    );

    const seen = visible.filter(
      (field) =>
        field in body ||
        nested.some((container) => field in container) ||
        // SCOPE-05 counts a read of a sensitive column inside a table too —
        // otherwise the audit says nobody looked.
        rows.some((row) => field in row),
    );

    if (!seen.length) return;

    const id = typeof body.id === 'string' ? body.id : 'unknown';

    // Fire-and-forget: an audit write must not fail the read it describes.
    void this.recorder.recordSensitiveRead(principal, resource, id, seen);
  }
}

/** `request:{typeCode}` + a row → `request:DSC`; null when the row lacks it. */
function resolveTemplate(
  template: string,
  row: Record<string, unknown>,
): string | null {
  let missing = false;
  const resolved = template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const value = row[key] ?? row[snake];
    if (typeof value !== 'string' || !value) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : resolved;
}
