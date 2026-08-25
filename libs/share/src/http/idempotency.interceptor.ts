import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { AppError } from '../errors/app-error';
import { PrismaService } from '../modules/prisma/prisma.service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** How long a stored result stays replayable. */
const RETENTION_HOURS = 24;

function fingerprint(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method} ${path} ${JSON.stringify(body ?? null)}`)
    .digest('hex');
}

/**
 * Makes state-changing POSTs safe to retry (NFR-03).
 *
 * A client that resends the same `Idempotency-Key` gets the original response
 * back instead of creating a second record — which is what stops a flaky
 * network or a double-tapped submit button from issuing two request numbers
 * for one request.
 *
 * Replaying a key with a *different* body is a client bug, not a retry, so it
 * is rejected rather than served the old response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    const key = request.headers[IDEMPOTENCY_HEADER];

    if (request.method !== 'POST' || typeof key !== 'string' || !key) {
      return next.handle();
    }

    const hash = fingerprint(request.method, request.path, request.body);

    return from(this.replay(key, hash)).pipe(
      switchMap((stored) =>
        stored
          ? of(stored)
          : next
              .handle()
              .pipe(tap((response) => void this.store(key, hash, response))),
      ),
    );
  }

  private async replay(key: string, hash: string): Promise<unknown> {
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: { key },
    });

    if (!existing) return null;

    if (existing.requestHash !== hash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key นี้ถูกใช้กับคำขออื่นแล้ว',
        [{ field: 'Idempotency-Key', reason: key }],
      );
    }

    return existing.response ?? null;
  }

  private async store(
    key: string,
    hash: string,
    response: unknown,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + RETENTION_HOURS * 3600_000);

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key,
          requestHash: hash,
          response: response as never,
          expiresAt,
        },
      });
    } catch (error) {
      // Losing the record only costs us replay protection on a retry; it must
      // never fail the request that already succeeded.
      this.logger.warn(
        `Could not persist idempotency key ${key}: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
