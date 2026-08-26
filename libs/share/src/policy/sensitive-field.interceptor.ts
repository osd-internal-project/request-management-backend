import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
  Optional,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import {
  getPrincipal,
  Principal,
  RequestWithPrincipal,
} from '../context/principal';

export const SENSITIVE_RESOURCE_KEY = 'ctd:sensitive-resource';

/**
 * Declares which sensitive-field rule set applies to a handler's response,
 * e.g. `@SensitiveResource('request:DSC')`.
 *
 * Without it a response is passed through untouched — masking is opt-in per
 * endpoint because only the handler knows what shape it returns.
 */
export const SensitiveResource = (resource: string) =>
  SetMetadata(SENSITIVE_RESOURCE_KEY, resource);

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
export class SensitiveFieldInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(SENSITIVE_READ_RECORDER)
    private readonly recorder?: SensitiveReadRecorder,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resource = this.reflector.getAllAndOverride<string>(
      SENSITIVE_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!resource) return next.handle();

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = getPrincipal(request);
    if (!principal) return next.handle();

    const prefix = `${resource}.`;
    const declared = principal.sensitiveFieldsAll
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length));

    if (!declared.length) return next.handle();

    const visible = new Set(
      principal.sensitiveFieldsVisible
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length)),
    );

    const masked = declared.filter((field) => !visible.has(field));

    return next
      .handle()
      .pipe(
        map((body) =>
          this.apply(body, masked, [...visible], resource, principal),
        ),
      );
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

      for (const container of NESTED_CONTAINERS) {
        const nested = result[container];
        if (!isPlainObject(nested)) continue;

        const copy = { ...nested };
        delete copy[field];
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

    const seen = visible.filter(
      (field) =>
        field in body || nested.some((container) => field in container),
    );

    if (!seen.length) return;

    const id = typeof body.id === 'string' ? body.id : 'unknown';

    // Fire-and-forget: an audit write must not fail the read it describes.
    void this.recorder.recordSensitiveRead(principal, resource, id, seen);
  }
}
