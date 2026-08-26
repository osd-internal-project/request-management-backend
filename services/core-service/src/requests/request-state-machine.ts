import { RequestStatus } from '@prisma/client';
import { AppError } from '@request-management/share';

/**
 * The §7.1 state machine, as data.
 *
 * Written out now, while the spec is the source, because this is the part most
 * likely to drift once handlers are filled in one at a time. Every transition
 * the system permits is in this table; anything absent is impossible through
 * every channel, including a direct API call — which is exactly what §7.1
 * requires.
 *
 * ```
 * draft ──submit──▶ submitted ──▶ pending_approval ──▶ approved ──▶ in_progress ──▶ completed
 *                       │                  │                            │  ▲
 *                       │                  └──reject──▶ rejected    hold│  │resume
 *                       └──return──▶ returned ──resubmit──▶ submitted   ▼  │
 *                                                                     on_hold
 *
 * anything before completed ──cancel──▶ cancelled
 * ```
 *
 * `on_hold` (26 Aug 2026) — a request parked mid-execution waiting on an
 * external factor. Reachable only from `in_progress`, resumes to
 * `in_progress`, or is cancelled. Added to carry over ON_HOLD rows from the
 * interim Excel request logs.
 *
 * **This state is not in §7.1 of the source specification.** It is a
 * deliberate local amendment awaiting PO sign-off — §2 requires that any
 * design conflicting with the agreed document go through the PO. Do not cite
 * §7.1 as its authority; if the PO declines it, this row, the enum value and
 * migration `20260826040000_request_on_hold` all come back out.
 */
export const REQUEST_TRANSITIONS: Readonly<
  Record<RequestStatus, readonly RequestStatus[]>
> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['pending_approval', 'returned', 'in_progress', 'cancelled'],
  returned: ['submitted', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'returned', 'cancelled'],
  approved: ['in_progress', 'cancelled'],
  rejected: [],
  in_progress: ['completed', 'on_hold', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** Statuses from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly RequestStatus[] = [
  'rejected',
  'completed',
  'cancelled',
];

/** REQ-02: the point at which the request number is issued and SLA starts. */
export const NUMBER_ISSUED_ON: RequestStatus = 'submitted';

/**
 * SUP-01: while a request sits with the requester after a return, the clock
 * is paused — the elapsed time in the bottleneck report should only count
 * time the request was actually somebody's to act on. `on_hold` pauses it for
 * the same reason: the wait is on an external factor, not the receiving team.
 */
export const CLOCK_PAUSED_IN: readonly RequestStatus[] = [
  'returned',
  'draft',
  'on_hold',
];

/** REQ-01/REQ-03: form data is only editable before it is anyone else's problem. */
export const EDITABLE_STATUSES: readonly RequestStatus[] = [
  'draft',
  'returned',
];

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

/**
 * Guards a status change. Throws `REQ_STATE_INVALID` (409, per §11.9) rather
 * than returning false, so a caller cannot forget to check the result.
 */
export function assertTransition(from: RequestStatus, to: RequestStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError(
      'REQ_STATE_INVALID',
      'ไม่สามารถเปลี่ยนสถานะคำขอจากสถานะปัจจุบันได้',
      [{ field: 'status', reason: `${from} → ${to}` }],
    );
  }
}
