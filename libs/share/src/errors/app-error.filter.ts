import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppError, ErrorCatalog, ErrorCode, ErrorDetail } from './app-error';

/** The one response body shape for every error — CTD spec §11.1. */
export interface ErrorResponseBody {
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
}

/** Nest status names that line up with a code in {@link ErrorCatalog}. */
function codeForStatus(status: HttpStatus): ErrorCode {
  const name = HttpStatus[status];
  if (name && name in ErrorCatalog) {
    return name as ErrorCode;
  }

  if (status >= HttpStatus.INTERNAL_SERVER_ERROR) return 'UNKNOWN';
  if (status === HttpStatus.UNPROCESSABLE_ENTITY) return 'UNPROCESSABLE';
  return 'VALIDATION_FAILED';
}

/**
 * Nest's ValidationPipe throws a BadRequestException whose response carries a
 * `message` array of human strings. Turn those into `details` so clients get
 * the §11.1 shape rather than a bare array.
 */
function detailsFromValidation(response: unknown): ErrorDetail[] | undefined {
  if (typeof response !== 'object' || response === null) return undefined;

  const { message } = response as { message?: unknown };
  if (!Array.isArray(message)) return undefined;

  return message
    .filter((entry): entry is string => typeof entry === 'string')
    .map((reason) => ({ field: reason.split(' ')[0] ?? '', reason }));
}

/**
 * Single error shape for every response: `{ code, message, details }`.
 *
 * Unmapped errors return 500 (never 200), and their messages are withheld
 * outside development so internals do not leak to clients.
 */
@Catch()
export class AppErrorExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppErrorExceptionFilter.name);
  private readonly exposeInternals = process.env.NODE_ENV !== 'production';

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.describe(error);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        body.message,
        error instanceof Error ? error.stack : '',
      );
    } else {
      this.logger.warn(`${body.code}: ${body.message}`);
    }

    response.status(status).json(body);
  }

  private describe(error: unknown): {
    status: HttpStatus;
    body: ErrorResponseBody;
  } {
    if (error instanceof AppError) {
      return {
        status: error.httpStatus,
        body: {
          code: error.code,
          message: error.message,
          ...(error.details.length ? { details: [...error.details] } : {}),
        },
      };
    }

    if (error instanceof HttpException) {
      const status = error.getStatus();
      const details = detailsFromValidation(error.getResponse());

      return {
        status,
        body: {
          code: codeForStatus(status),
          message: error.message,
          ...(details?.length ? { details } : {}),
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'UNKNOWN',
        message:
          this.exposeInternals && error instanceof Error
            ? error.message
            : 'Internal server error',
      },
    };
  }
}
