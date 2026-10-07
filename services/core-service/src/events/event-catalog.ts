/**
 * §11.8 — the internal event catalog.
 *
 * Declared in one place because these names are a contract: the notification
 * service is only the *first* consumer, and §11.8 says the event → message
 * mapping is configuration. A string typed at the emit site would drift from
 * the one a consumer subscribes to and the failure would be silence.
 *
 * Consumers must be idempotent — an event may be delivered more than once —
 * and ordering holds only within a single request.
 */
export const DOMAIN_EVENTS = {
  requestSubmitted: 'request.submitted',
  requestReturned: 'request.returned',
  requestResubmitted: 'request.resubmitted',
  requestCancelled: 'request.cancelled',
  requestCompleted: 'request.completed',
  /**
   * The result stands — whether an approver signed the last step or the type
   * has no matrix and was accepted as delivered. One name for both, because a
   * consumer waiting on "was this approved" must not have to know which
   * branch `complete` took. Pre-work approval (`:pre`) is not this event: it
   * only hands the ticket to its receiver.
   */
  requestApproved: 'request.approved',
  /**
   * CD-80 — the last approver of a before-work (`:pre`) ladder said yes: the
   * ticket goes to its receiver. Not `requestApproved` (the work is not done),
   * but it IS the decision a consumer like a quotation waits on — a discount
   * approved before pricing picks it up is an approved discount.
   */
  requestPreApproved: 'request.pre_approved',
  /** An approver rejected the request outright (terminal). */
  requestRejected: 'request.rejected',
  /** What triggers "you have work waiting". */
  approvalStepPending: 'approval.step.pending',
  approvalCompleted: 'approval.completed',
  approvalRejected: 'approval.rejected',
  /** APV-05: the data changed under an approval that had already been given. */
  approvalVoided: 'approval.voided',
  slaWarning: 'sla.warning',
  /** Triggers escalation (SUP-02). */
  slaBreached: 'sla.breached',
  /**
   * CD-14 — every signer signed and the document is sealed. The module that
   * sent it (Legal: the contract repository) keeps the signed copy.
   */
  esignCompleted: 'esign.completed',
  /** A flow-v2 request now stands on `step_code` — modules that work a step follow it (การเบิก). */
  requestStepEntered: 'request.step.entered',
} as const;

export type DomainEventName =
  (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];

/** Every payload carries the company, because every consumer is per-company. */
interface BasePayload {
  company_id: string;
}

export interface StepEventPayload extends BasePayload {
  request_id: string;
  request_no: string | null;
  type_code: string;
  step_code: string;
  status: string;
}

export interface RequestEventPayload extends BasePayload {
  request_id: string;
  request_no: string | null;
  type_code: string;
  requester_id: string;
  /** REQ-04 — present on `request.returned`. */
  reason_codes?: string[];
}

export interface ApprovalEventPayload extends BasePayload {
  case_id: string;
  request_id: string | null;
  step?: number;
  approver_id?: string | null;
}

export interface SlaEventPayload extends BasePayload {
  request_id: string;
  request_no: string | null;
  due_at: string;
}

export interface EsignEventPayload extends BasePayload {
  envelope_id: string;
  source_type: string;
  source_id: string;
  ref_type: string;
  ref_id: string;
}

/** Discriminated by name so a subscriber cannot read the wrong shape. */
export type DomainEvent =
  | { name: 'request.submitted'; payload: RequestEventPayload }
  | { name: 'request.returned'; payload: RequestEventPayload }
  | { name: 'request.resubmitted'; payload: RequestEventPayload }
  | { name: 'request.cancelled'; payload: RequestEventPayload }
  | { name: 'request.completed'; payload: RequestEventPayload }
  | { name: 'request.approved'; payload: RequestEventPayload }
  | { name: 'request.pre_approved'; payload: RequestEventPayload }
  | { name: 'request.rejected'; payload: RequestEventPayload }
  | { name: 'approval.step.pending'; payload: ApprovalEventPayload }
  | { name: 'approval.completed'; payload: ApprovalEventPayload }
  | { name: 'approval.rejected'; payload: ApprovalEventPayload }
  | { name: 'approval.voided'; payload: ApprovalEventPayload }
  | { name: 'sla.warning'; payload: SlaEventPayload }
  | { name: 'sla.breached'; payload: SlaEventPayload }
  | { name: 'esign.completed'; payload: EsignEventPayload }
  | { name: 'request.step.entered'; payload: StepEventPayload };
