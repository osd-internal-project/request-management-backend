import { HttpStatus } from '@nestjs/common';

/**
 * Every error code the API can return, mapped to its HTTP status.
 *
 * The business codes come from the CTD Foundation Sprint spec §11.9 and are
 * part of the API contract — clients branch on `code`, never on the message
 * text, which is Thai and may be reworded. Adding a code here is the only way
 * to introduce one; the filter refuses to invent codes at runtime.
 */
export const ErrorCatalog = {
  // --- generic ---
  UNKNOWN: HttpStatus.INTERNAL_SERVER_ERROR,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  UNPROCESSABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_IMPLEMENTED: HttpStatus.NOT_IMPLEMENTED,

  // --- §11.9 business codes ---
  COMPANY_FORBIDDEN: HttpStatus.FORBIDDEN,
  REQ_FIELD_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  REQ_DOC_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  REQ_STATE_INVALID: HttpStatus.CONFLICT,
  /**
   * A parent request still has children running. 409 rather than 422: the
   * request is valid, the moment is wrong, and it becomes right on its own
   * once the children close.
   */
  REQ_CHILDREN_OPEN: HttpStatus.CONFLICT,
  REQ_TYPE_INACTIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  ORG_SUPERVISOR_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  APV_NOT_YOUR_TURN: HttpStatus.CONFLICT,
  APV_VERSION_STALE: HttpStatus.CONFLICT,
  APV_MATRIX_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  APV_NO_SUBDELEGATION: HttpStatus.UNPROCESSABLE_ENTITY,
  DELEGATION_OVERLAP: HttpStatus.CONFLICT,

  // --- extensions beyond §11.9, needed by the admin surface ---
  /** ROLE-02: a role with users bound to it may be deactivated, never deleted. */
  ROLE_IN_USE: HttpStatus.CONFLICT,
  /** AUTH-04: moving an org unit under its own descendant would cycle the tree. */
  ORG_UNIT_CYCLE: HttpStatus.UNPROCESSABLE_ENTITY,
  /**
   * A group still has people, sub-groups, or configuration pointing at it.
   *
   * The chart is configuration, so a genuinely unused group may be deleted —
   * but only then. `details` names what is in the way, because "cannot delete"
   * alone sends an admin hunting through the chart by hand.
   */
  ORG_UNIT_IN_USE: HttpStatus.CONFLICT,
  /**
   * REQ-01: a request type that has been raised against, or that a published
   * approval matrix routes, may be deactivated but never deleted — deleting it
   * would orphan the history behind it.
   */
  REQ_TYPE_IN_USE: HttpStatus.CONFLICT,
  /** NFR-03: same Idempotency-Key replayed with a different body. */
  IDEMPOTENCY_KEY_REUSED: HttpStatus.CONFLICT,
  /**
   * The Keycloak Admin API is unreachable or the service account lacks its
   * realm-management roles. A distinct code so the UI can say "not configured"
   * instead of showing a generic failure — Keycloak data is an enrichment of
   * screen A3, never a dependency of it.
   */
  KEYCLOAK_ADMIN_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  /** Refusing to grant a role that would escalate Keycloak privileges. */
  KEYCLOAK_ROLE_FORBIDDEN: HttpStatus.FORBIDDEN,

  // --- workflow (Flowable) ---
  /**
   * A workflow definition cannot be published as it stands: an unreachable
   * state, an action naming a state that does not exist, a phase pair §7.1
   * forbids. `details` names each fault so the admin screen can list them
   * rather than saying "invalid".
   */
  WORKFLOW_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  /**
   * An edit aimed at a version that is already published. Published versions
   * are immutable so a request already running keeps the route it started on;
   * editing means publishing N+1.
   */
  WORKFLOW_PUBLISHED_IMMUTABLE: HttpStatus.CONFLICT,
  /**
   * Flowable is unreachable or refused. Its own code so the UI can say "the
   * workflow engine is down" rather than showing a generic failure — the same
   * distinction `KEYCLOAK_ADMIN_UNAVAILABLE` exists for.
   */
  WORKFLOW_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
} as const;

export type ErrorCode = keyof typeof ErrorCatalog;

/** One field-level cause, rendered in the `details` array of the response. */
export interface ErrorDetail {
  readonly field: string;
  readonly reason: string;
}

/**
 * Domain error carrying a stable `code` from {@link ErrorCatalog}.
 *
 * @example
 * ```ts
 * throw new AppError('REQ_DOC_MISSING', 'เอกสารบังคับยังไม่ครบ', [
 *   { field: 'attachments', reason: 'ใบเสนอราคาฉบับร่าง' },
 * ]);
 * ```
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: readonly ErrorDetail[] = [],
  ) {
    super(message);
    this.name = 'AppError';
  }

  get httpStatus(): HttpStatus {
    return ErrorCatalog[this.code];
  }
}
