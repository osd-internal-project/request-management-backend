import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/**
 * The caller's `Authorization` header, for the two handlers that forward it on.
 *
 * `@Headers('authorization')` did this job and produced a real defect in the
 * published document: Nest's Swagger explorer turns every `@Headers(name)`
 * argument into a **required** header parameter, so `POST /external/requests`
 * and `POST .../actions/{action}` asked for the token twice — once through the
 * Authorize button that `@ApiBearerAuth()` puts there, and again as a text box
 * the reader had to fill in before "Try it out" would fire at all. Two fields,
 * one header, and the second one undocumented and unexplained.
 *
 * A custom decorator is invisible to the explorer, so the parameter disappears
 * while the runtime behaviour is unchanged. Fixing it here rather than editing
 * the generated JSON is the point: the document is generated on every
 * `yarn openapi`, so a hand-edit is undone by the next run.
 *
 * Why the header is read at all: `submit` and `complete` resolve the approval
 * chain across the service boundary, and user-service is the only service that
 * verifies tokens (§03). The caller's own credential travels with that lookup
 * rather than a second one being minted here.
 */
export const BearerToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<Request>();

    return request.headers.authorization ?? '';
  },
);
