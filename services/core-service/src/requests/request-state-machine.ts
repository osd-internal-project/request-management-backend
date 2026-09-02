import { RequestStatus } from '@prisma/client';
import { AppError } from '@request-management/share';

/**
 * The request lifecycle, as data.
 *
 * ```
 * draft ──submit──▶ [ has a `:pre` matrix? ]
 *                       │no                    │yes
 *                       ▼                      ▼
 *                   submitted ◀──approve── pending_approval ──▶ rejected
 *                       │                      │ send back
 *                       │                      ▼
 *                       │                   returned
 *                    receive
 *                       ▼
 *                  in_progress ──complete──▶ completed
 *                    │  ▲                        │
 *               hold │  │ resume        has matrix?
 *          returned▼    │                   │    │
 *          │     on_hold                    │    │no
 *          └─resubmit─┘                yes  │    │
 *                                           ▼    ▼
 *                     in_progress ◀──send back── pending_approval
 *                                                │              │
 *                                                ▼              ▼
 *                                            rejected       approved
 *                                                               │
 *                                                requester ──close──▶ closed
 *
 * anything before completed ──cancel──▶ cancelled
 * ```
 *
 * **A request is a ticket.** Somebody raises it *for a named person*, that
 * person accepts it, work happens — possibly broken into further requests —
 * and only then is the result checked and the ticket closed by whoever asked.
 *
 * # Two amendments live here, and neither is in the source specification
 *
 * `on_hold` (26 Aug 2026) — work parked mid-execution waiting on an external
 * factor. Reachable only from `in_progress`, resumes to `in_progress`, or is
 * cancelled. Added to carry over `ON_HOLD` rows from the interim Excel request
 * logs without collapsing them into `in_progress`.
 *
 * `closed` (28 Aug 2026) — a completed request the requester has accepted.
 * Terminal. The source records eleven statuses and this system had ten; folding
 * `CLOSED` into `completed` would erase the distinction the departments kept.
 *
 * # And one reversal, which is larger than either
 *
 * **Approval runs *after* the work, not before it** (28 Aug 2026).
 *
 * §7.1 sequences `pending_approval → approved → in_progress`: permission to
 * start. The departments' own logs do the opposite — `06_EXAMPLE` shows work
 * received and completed first, with approval as the check on the result — and
 * eighteen of the forty request types carry no approval step at all ("คำขอนี้
 * ไม่มีชั้นอนุมัติ (Pattern C)"). A ladder every request had to climb before
 * anyone could start was a ladder most requests did not have.
 *
 * So `completed` now branches: a type with an approval matrix goes to
 * `pending_approval` for a check, and a type without one goes straight to
 * `approved`. Sending back from that check returns the ticket to
 * `in_progress` — to the team that did the work, not to the requester.
 *
 * # And, since 1 ก.ย. 2569, both orders at once
 *
 * §7.1's order was not wrong, it was **not the only one**. A type may now also
 * be approved *before* the receiver ever sees it — permission to ask — by
 * publishing a matrix for `request:<CODE>:pre`. Both stages can be configured
 * on one type: approve that the work may start, then approve the result.
 *
 * `submit` therefore branches the way `complete` does, and on the same test:
 * the existence of a published matrix for the stage's subject. A type with no
 * `:pre` matrix behaves exactly as before, which is every type that exists
 * today — this adds a path, it does not move one.
 *
 * Sending back from the pre-work check goes to `returned`, not `in_progress`:
 * no work has been done yet, so the ticket belongs with the requester.
 *
 * **None of this is §7.1's authority; all of it awaits PO sign-off** — §2
 * requires a design conflicting with the agreed document to go through the PO.
 * Do not cite §7.1 or §8.1 for any of it. If the PO declines, what comes out
 * is: this table, the `on_hold`/`closed` enum values, the `CLOCK_PAUSED_IN`
 * entries, the ticket columns on `Request`, and migrations
 * `20260826040000_request_on_hold`, `20260828120000_request_closed` and
 * `20260828190000_request_ticket_model`.
 */
export const REQUEST_TRANSITIONS: Readonly<
  Record<RequestStatus, readonly RequestStatus[]>
> = {
  // `pending_approval` is the pre-work check — only for a type that has a
  // `request:<CODE>:pre` matrix. Without one, submit lands on `submitted`.
  draft: ['submitted', 'pending_approval', 'cancelled'],
  // A submitted request waits for its named receiver to accept it.
  submitted: ['in_progress', 'returned', 'cancelled'],
  // Resubmitting after a return goes through the pre-work check again: the
  // request that was approved is not the request being sent now.
  returned: ['submitted', 'pending_approval', 'cancelled'],
  in_progress: ['completed', 'on_hold', 'returned', 'cancelled'],
  on_hold: ['in_progress', 'cancelled'],
  // The branch: a type with an approval matrix is checked, one without is
  // accepted as it stands. `complete` decides which, and nothing else may.
  completed: ['pending_approval', 'approved'],
  // Sending back goes to `in_progress` — the work returns to the team that did
  // it. `returned` means "back with the requester", which is a different place.
  /*
    Two stages share this status, and they leave it differently.

    After the work: `approved` (the result stands) or `in_progress` (back to
    the team that did it). Before the work: `submitted` (now hand it to the
    receiver) or `returned` (back to the requester, since nobody has started).
    `ApprovalCase.subjectType` says which stage a case belongs to.
  */
  pending_approval: [
    'approved',
    'submitted',
    'in_progress',
    'returned',
    'rejected',
    'cancelled',
  ],
  // Only the requester closes, and only after the result has been accepted.
  approved: ['closed', 'cancelled'],
  rejected: [],
  closed: [],
  cancelled: [],
};

/** Statuses from which nothing further can happen. */
export const TERMINAL_STATUSES: readonly RequestStatus[] = [
  'rejected',
  'closed',
  'cancelled',
];

/**
 * The statuses at which a request is still somebody's to finish.
 *
 * A parent may not be completed while any child is in one of these — closing a
 * chain from the top while work continues underneath it is how a request looks
 * finished and is not.
 */
export const OPEN_STATUSES: readonly RequestStatus[] = [
  'draft',
  'submitted',
  'returned',
  'in_progress',
  'on_hold',
  'completed',
  'pending_approval',
  'approved',
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
  // Waiting for the receiver to accept is not the receiving team's working
  // time — the source is explicit that RECEIVED is where real work starts
  // ("แผนกปลายทางรับเรื่องแล้ว — เริ่มนับเวลาทำงานจริง"). Counting the wait
  // here would make a team that answers instantly look identical to one that
  // leaves a ticket sitting for a week.
  'submitted',
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
