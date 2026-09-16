import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';

/**
 * Tells a refused MCP caller where to go and log in.
 *
 * Without this a client meets a bare `401` and has nowhere to look: RFC 9728
 * says the challenge carries `resource_metadata`, and that pointer is what
 * turns "unauthorised" into a connect button. The discovery document alone is
 * not enough — a client has to be told it exists.
 *
 * Applied only to the MCP route. Every other endpoint in this service answers
 * its own callers, who already hold a credential or know how to get one, and
 * advertising a login route on all of them would change behaviour nobody asked
 * to change.
 *
 * `writeHead` is patched rather than the header being set upfront: the status
 * is not known until the guards have run, and `WWW-Authenticate` on a
 * successful response would be wrong. Patching the last call before the
 * headers are flushed is the one place the status is settled and the headers
 * are still open.
 */
@Injectable()
export class McpChallengeMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService) {}

  use(_request: Request, response: Response, next: NextFunction): void {
    const base = this.config.get<string>('publicBaseUrl') ?? '';
    const metadata = `${base}/.well-known/oauth-protected-resource`;

    /*
      `writeHead` is overloaded five ways and this wrapper cares about none of
      them — every argument is forwarded untouched. Narrowing to `unknown[]`
      keeps that honest (nothing here inspects an argument) where
      `Parameters<...>` would resolve to just one overload and quietly mistype
      the others.
    */
    type PassThrough = (...args: unknown[]) => Response;
    const original = response.writeHead.bind(response) as PassThrough;

    const patched: PassThrough = (...args) => {
      if (response.statusCode === 401 && !response.headersSent) {
        response.setHeader(
          'WWW-Authenticate',
          `Bearer resource_metadata="${metadata}"`,
        );
      }

      return original(...args);
    };

    // Cast back to the overloaded signature Express declares: the function
    // above accepts every shape of call it can make.
    response.writeHead = patched;

    next();
  }
}
