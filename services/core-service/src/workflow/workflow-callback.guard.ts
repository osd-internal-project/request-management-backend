import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { AppError } from '@request-management/share';

export const WORKFLOW_SECRET_HEADER = 'x-workflow-secret';

/**
 * The only thing standing in front of the callback route.
 *
 * The workflow engine writes to this system through `POST
 * /internal/workflow/callback`, and it cannot present a Keycloak token: a BPMN
 * http task would have to fetch one first, which puts the client secret inside
 * process XML that is deployed and readable. So the engine proves itself with
 * a shared secret instead, and the route is `@Public()` to the guard chain.
 *
 * **This is not a second permission system.** The callback carries no opinion
 * about who may do what — it applies a transition the engine already made, on
 * a request the application handed it. Authority was checked in
 * `workflow-runtime.service.ts` before the task was ever completed, by the
 * same `hasAuthority` every other path uses (ROLE-01).
 *
 * An empty configured secret refuses everything. A callback route that accepts
 * anything when unconfigured is an unauthenticated write onto every request in
 * the system, and "it works in dev" is exactly how that reaches production.
 */
@Injectable()
export class WorkflowCallbackGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('flowable.callbackSecret') ?? '';
    const presented = context.switchToHttp().getRequest<Request>().headers[
      WORKFLOW_SECRET_HEADER
    ];

    if (!expected || typeof presented !== 'string' || !presented) {
      throw new AppError(
        'UNAUTHORIZED',
        'ไม่ได้รับอนุญาตให้เรียก callback นี้',
      );
    }

    // Constant time, so a wrong secret cannot be found one character at a time
    // by measuring how long the comparison takes.
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppError(
        'UNAUTHORIZED',
        'ไม่ได้รับอนุญาตให้เรียก callback นี้',
      );
    }

    return true;
  }
}
