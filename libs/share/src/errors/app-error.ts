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
  /** The step named is not where the request is, or not reachable from it. */
  REQ_STEP_INVALID: HttpStatus.CONFLICT,
  /** A required sub request from the type's checklist was never raised. */
  REQ_SUB_REQUEST_MISSING: HttpStatus.CONFLICT,
  REQ_TYPE_INACTIVE: HttpStatus.UNPROCESSABLE_ENTITY,
  ORG_SUPERVISOR_MISSING: HttpStatus.UNPROCESSABLE_ENTITY,
  APV_NOT_YOUR_TURN: HttpStatus.CONFLICT,
  /** Nobody decides their own case — not as candidate, delegate or grant holder. */
  APV_SELF_APPROVAL: HttpStatus.FORBIDDEN,
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
   * A unit placed at a level that is not directly under its parent's — the
   * chart is บริษัท → ฝ่าย → แผนก → ทีม → ตำแหน่ง with no level skipped
   * (`ORG_UNIT_LEVELS`). `details` names the level that would have been
   * correct, because "invalid" alone leaves an admin guessing.
   */
  ORG_UNIT_LEVEL_INVALID: HttpStatus.UNPROCESSABLE_ENTITY,
  /**
   * Someone assigned to a บริษัท or ฝ่าย unit. People sit at แผนก or below, so
   * that "the supervisor above this person" has one answer; a unit holding
   * both people and sub-departments has none.
   */
  ORG_UNIT_CANNOT_HOLD_MEMBERS: HttpStatus.UNPROCESSABLE_ENTITY,
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

  /** CM-06/D-30 — the integration layer's answer when SAP (or a later
   * external system) refuses or is unreachable; the sync queue retries. */
  UPSTREAM_ERROR: HttpStatus.BAD_GATEWAY,
  /** Object storage (MinIO/S3) is unreachable or refused the call. */
  STORAGE_UNAVAILABLE: HttpStatus.BAD_GATEWAY,
  /** REQ-03: the attachment row predates file storage and has no bytes behind it. */
  ATTACHMENT_NO_FILE: HttpStatus.NOT_FOUND,
  /**
   * The Keycloak Admin API is unreachable or the service account lacks its
   * realm-management roles. A distinct code so the UI can say "not configured"
   * instead of showing a generic failure — Keycloak data is an enrichment of
   * screen A3, never a dependency of it.
   */
  KEYCLOAK_ADMIN_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  /** Refusing to grant a role that would escalate Keycloak privileges. */
  KEYCLOAK_ROLE_FORBIDDEN: HttpStatus.FORBIDDEN,

  // --- CRM (CM-xx spec, artifact 856c08fd) ---
  /**
   * CM-03: same tax id + branch already registered in this company. 409 with
   * the existing customer in `details`, so the form can point at it — the
   * answer is "use that one", never "make another".
   */
  CRM_CUSTOMER_DUPLICATE: HttpStatus.CONFLICT,
  /**
   * CM-03: a similar name was found and the caller did not (or may not)
   * confirm past the warning. `details` carries the similar customers; a
   * caller with `crm.customer.dedup.override` may resubmit with
   * `confirm_duplicate` + a reason.
   */
  CRM_CUSTOMER_SIMILAR: HttpStatus.UNPROCESSABLE_ENTITY,
  /** CM-04: a customer-status change outside the declared transition table. */
  CRM_CUSTOMER_STATE_INVALID: HttpStatus.CONFLICT,
  /**
   * CM-07: a segment value with customers assigned may be deactivated but
   * never deleted — deleting it would orphan the assignments Pricing reads.
   */
  CRM_SEGMENT_IN_USE: HttpStatus.CONFLICT,
  /**
   * A Lead status still in use may be closed off (`active = false`) but never
   * deleted — Lead rows store the code, and removing it would leave them
   * pointing at a status the screens cannot name. `details` says how many.
   */
  CRM_LEAD_STATUS_IN_USE: HttpStatus.CONFLICT,
  /**
   * รูปแบบเลขรันแถวสุดท้ายของชนิดเอกสารนั้นลบไม่ได้ — ถ้าลบ การออกเลขครั้งถัดไป
   * จะไม่มีรูปแบบให้ใช้ ปิดการใช้งาน (`active = false`) ได้ ลบไม่ได้.
   */
  RUN_NUMBER_SETTING_IN_USE: HttpStatus.CONFLICT,
  /**
   * CD-76: the action does not fit the quotation's status — editing a version
   * that was already submitted or sent, sending one not yet approved, etc.
   * A sent quotation is never edited; the answer is a new version.
   */
  CRM_QUOTATION_STATE_INVALID: HttpStatus.CONFLICT,
  /** CD-76: `validUntil` has passed — send/accept refused; issue a new version. */
  CRM_QUOTATION_EXPIRED: HttpStatus.CONFLICT,
  /**
   * CD-76: margin is below the company minimum and the approval request type
   * configured in CRM settings is not available to this company, so there is
   * no route to get the quotation approved. Configuration, not a code fault.
   */
  CRM_QUOTATION_APPROVAL_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,
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
