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
import { getPrincipal, RequestWithPrincipal } from '../context/principal';
import {
  SENSITIVE_READ_RECORDER,
  SensitiveFieldMasker,
  type SensitiveReadRecorder,
} from './sensitive-field.masker';

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

/**
 * SCOPE-04 on the HTTP door: reads the handler's `@SensitiveResource` and
 * hands the body to {@link SensitiveFieldMasker}, which holds the rules.
 *
 * The masker is built here rather than injected so that registering this
 * interceptor stays a one-line `APP_INTERCEPTOR` in three services, as it was
 * before the rules moved out.
 */
@Injectable()
export class SensitiveFieldInterceptor implements NestInterceptor {
  private readonly masker: SensitiveFieldMasker;

  constructor(
    private readonly reflector: Reflector,
    @Optional()
    @Inject(SENSITIVE_READ_RECORDER)
    recorder?: SensitiveReadRecorder,
  ) {
    this.masker = new SensitiveFieldMasker(recorder);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const resource = this.reflector.getAllAndOverride<string>(
      SENSITIVE_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!resource) return next.handle();

    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = getPrincipal(request);
    if (!principal) return next.handle();

    return next
      .handle()
      .pipe(map((body) => this.masker.mask(resource, body, principal)));
  }
}
