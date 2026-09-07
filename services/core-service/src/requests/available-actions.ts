import { RequestStatus } from '@prisma/client';
import type { Principal } from '@request-management/share';
import {
  REQUEST_TRANSITIONS,
  TERMINAL_STATUSES,
} from './request-state-machine';

/**
 * What can be done to a request right now, and by whom — as data.
 *
 * The external API needs this because a chatbot has no screen to grey out: it
 * has to be *told* the choices before it offers them. But the reason it is a
 * table rather than a list written for that one caller is different, and more
 * important.
 *
 * **An action exists because the flow allows it, not because a use case asked
 * for it.** The Pre-Sales type has no approval ladder, so `approve` never
 * appears for it — not because it was left out, but because the request never
 * reaches `pending_approval`. The day a type is configured with a matrix, the
 * approval actions appear on their own, and the endpoint that performs them
 * already accepts them. Nothing here is per-type.
 *
 * The two facts this file is *not* allowed to invent:
 *
 *   - which status may follow which — that is `REQUEST_TRANSITIONS`, and
 *     `ACTIONS` is checked against it by its own spec
 *   - who may act — that is {@link hasAuthority}, which `assertMayAct` in
 *     `requests.service.ts` also calls, so the list and the handler cannot
 *     disagree about a person
 *
 * A list that offers an action the handler then refuses is worse than offering
 * nothing: the caller has already told somebody it would work.
 */

/** Every operation the request flow has. */
export type RequestAction =
  | 'submit'
  | 'receive'
  | 'assign'
  | 'comment'
  | 'hold'
  | 'resume'
  | 'complete'
  | 'return'
  | 'resubmit'
  | 'approve'
  | 'reject'
  | 'send_back'
  | 'cancel'
  | 'close'
  | 'create_child';

/**
 * Who an action belongs to.
 *
 * Named roles rather than a set of booleans, because these are not
 * combinable in practice: `receiver` is deliberately narrower than `carrier`
 * (only the named receiver accepts a ticket, though whoever carries it may
 * finish it), and widening one to the other has to be a visible edit.
 */
export type Authority =
  /** The person who raised it. */
  | 'requester'
  /** The named receiver alone — accepting a ticket is not delegable. */
  | 'receiver'
  /** Whoever is carrying the work: the receiver, or the assignee. */
  | 'carrier'
  | 'carrier_or_lead'
  | 'requester_or_lead'
  /** A candidate on the pending approval step. */
  | 'decider'
  /** Anybody the visibility rules already let read it. */
  | 'viewer';

/** The facts an authority question is decided from. */
export interface ActionableRequest {
  readonly status: RequestStatus;
  readonly requesterId: string;
  readonly receiverUserId: string | null;
  readonly assigneeUserId: string | null;
  readonly requesterOrgUnitId: string | null;
  readonly receiverOrgUnitId: string | null;
}

/** One input an action needs, for a caller with no form to render. */
export interface ActionField {
  readonly name: string;
  readonly required: boolean;
  /**
   * `form` and `return_reason` are filled from the request type rather than
   * from a fixed list — the caller fetches the type's schema and reason codes
   * and asks accordingly.
   */
  readonly source?: 'form_schema' | 'receiver_form_schema' | 'return_reason';
}

export interface ActionSpec {
  readonly action: RequestAction;
  /** Statuses the action may start from. */
  readonly from: readonly RequestStatus[];
  /**
   * Where it lands, or `null` when it changes no status.
   *
   * `submit`, `resubmit` and the approval decisions branch on configuration —
   * whether the type has a matrix for the stage — so they declare every
   * outcome the flow permits and the handler picks one.
   */
  readonly to: readonly RequestStatus[];
  readonly authority: Authority;
  readonly fields: readonly ActionField[];
}

/**
 * Every status at which a request is still somebody's to work on.
 *
 * For the actions that change no status — commenting, handing the work on,
 * spawning a child request. They are bounded by "not finished yet" rather than
 * by a transition, because they have none.
 */
const LIVE_STATUSES = Object.values(RequestStatus).filter(
  (status) => !TERMINAL_STATUSES.includes(status),
);

/**
 * The statuses from which the flow permits a move to `target`.
 *
 * Derived rather than listed. `cancel` is the reason: the state machine's
 * comment says *"anything before completed"*, and writing that out by hand
 * produced a table claiming a completed request could be cancelled — which
 * `assertTransition` would have refused. Asking the transitions cannot be
 * wrong about the transitions.
 */
function statusesLeadingTo(target: RequestStatus): readonly RequestStatus[] {
  return Object.values(RequestStatus).filter((from) =>
    REQUEST_TRANSITIONS[from].includes(target),
  );
}

/**
 * The whole flow, one row per operation.
 *
 * `to` is not decoration: `actionsRespectTransitions` in the spec walks every
 * row and fails if a landing status is not in `REQUEST_TRANSITIONS[from]`. That
 * test is what stops this table drifting away from the state machine when
 * somebody edits one of them.
 */
export const ACTIONS: readonly ActionSpec[] = [
  {
    action: 'submit',
    from: ['draft'],
    // Branches on a `:pre` matrix — permission to ask, before anyone works.
    to: ['submitted', 'pending_approval'],
    authority: 'requester',
    fields: [
      { name: 'form_data', required: true, source: 'form_schema' },
      { name: 'receiver_user_id', required: true },
    ],
  },
  {
    action: 'resubmit',
    from: ['returned'],
    to: ['submitted', 'pending_approval'],
    authority: 'requester',
    fields: [{ name: 'form_data', required: false, source: 'form_schema' }],
  },
  {
    action: 'receive',
    from: ['submitted'],
    to: ['in_progress'],
    authority: 'receiver',
    fields: [],
  },
  {
    action: 'assign',
    // Handing the work on does not move the request; it changes who carries
    // it. Allowed wherever the request is still open.
    from: LIVE_STATUSES,
    to: [],
    authority: 'carrier',
    fields: [{ name: 'assignee_user_id', required: true }],
  },
  {
    action: 'hold',
    from: ['in_progress'],
    to: ['on_hold'],
    authority: 'carrier',
    fields: [{ name: 'reason', required: true }],
  },
  {
    action: 'resume',
    from: ['on_hold'],
    to: ['in_progress'],
    authority: 'carrier',
    fields: [{ name: 'note', required: false }],
  },
  {
    action: 'complete',
    from: ['in_progress'],
    to: ['completed'],
    authority: 'carrier',
    fields: [
      {
        name: 'receiver_form_data',
        required: true,
        source: 'receiver_form_schema',
      },
    ],
  },
  {
    // The use case calls this "rollback". Same thing: the ticket goes back to
    // the person who raised it, with a reason from the type's own list.
    action: 'return',
    from: ['submitted', 'in_progress'],
    to: ['returned'],
    authority: 'carrier_or_lead',
    fields: [
      { name: 'reason_code', required: true, source: 'return_reason' },
      { name: 'note', required: false },
    ],
  },
  {
    action: 'approve',
    from: ['pending_approval'],
    // Before the work: hand it to the receiver. After it: the result stands.
    to: ['submitted', 'approved'],
    authority: 'decider',
    fields: [{ name: 'note', required: false }],
  },
  {
    action: 'reject',
    from: ['pending_approval'],
    to: ['rejected'],
    authority: 'decider',
    fields: [{ name: 'note', required: true }],
  },
  {
    // Sent back from a check — to the requester before the work, to the team
    // that did it after.
    action: 'send_back',
    from: ['pending_approval'],
    to: ['returned', 'in_progress'],
    authority: 'decider',
    fields: [{ name: 'note', required: true }],
  },
  {
    action: 'cancel',
    from: statusesLeadingTo('cancelled'),
    to: ['cancelled'],
    authority: 'requester_or_lead',
    fields: [{ name: 'reason', required: true }],
  },
  {
    action: 'close',
    from: ['approved'],
    to: ['closed'],
    authority: 'requester',
    fields: [{ name: 'note', required: false }],
  },
  {
    action: 'comment',
    from: LIVE_STATUSES,
    to: [],
    authority: 'viewer',
    fields: [{ name: 'body', required: true }],
  },
  {
    // A piece of work that breaks into another department's request, kept
    // linked to this one. Not a status change on this request at all.
    action: 'create_child',
    from: LIVE_STATUSES,
    to: [],
    authority: 'viewer',
    fields: [
      { name: 'type_code', required: true },
      { name: 'form_data', required: true, source: 'form_schema' },
      { name: 'receiver_user_id', required: true },
    ],
  },
];

/**
 * Whether this person holds this authority over this request.
 *
 * The one implementation. `assertMayAct` in `requests.service.ts` calls it too,
 * which is what lets the action list promise something the handler will honour.
 *
 * `viewer` answers true unconditionally: being able to load the request at all
 * is the visibility rule's decision (`visibleRequestsWhere`), already made
 * before anything reaches here. Repeating it would be a second, weaker copy.
 */
export function hasAuthority(
  authority: Authority,
  request: ActionableRequest,
  actor: Pick<
    Principal,
    'userId' | 'ledUnitIds' | 'scopedActUnitIds' | 'scopedActUserIds'
  >,
  /** Whether the actor may decide the request's current approval step. */
  isDecider = false,
): boolean {
  const isRequester = request.requesterId === actor.userId;
  const isReceiver = request.receiverUserId === actor.userId;
  const isCarrier = isReceiver || request.assigneeUserId === actor.userId;

  switch (authority) {
    case 'viewer':
      return true;
    case 'requester':
      return isRequester;
    case 'receiver':
      return isReceiver;
    case 'carrier':
      return isCarrier;
    case 'carrier_or_lead':
      return isCarrier || leads(request, actor);
    case 'requester_or_lead':
      return isRequester || leads(request, actor);
    case 'decider':
      return isDecider;
  }
}

/**
 * Whether this person heads a group the request sits in, or one above it — or
 * holds a scope grant that carries authority over it.
 *
 * Reads `scopedActUnitIds` and `scopedActUserIds` alongside the groups they
 * lead: a scope grant ticked "ทำงานต่อได้" carries authority over the work, and
 * one that was not ticked deliberately does not. **Never the plain
 * `scopedUnitIds` / `scopedUserIds`** — a grant that only lets somebody read
 * another group's work must not let them move it.
 */
function leads(
  request: ActionableRequest,
  actor: Pick<
    Principal,
    'ledUnitIds' | 'scopedActUnitIds' | 'scopedActUserIds'
  >,
): boolean {
  const units = [...(actor.ledUnitIds ?? []), ...(actor.scopedActUnitIds ?? [])];

  const byUnit =
    (request.requesterOrgUnitId !== null &&
      units.includes(request.requesterOrgUnitId)) ||
    (request.receiverOrgUnitId !== null &&
      units.includes(request.receiverOrgUnitId));

  if (byUnit) return true;

  /*
    A grant written to one person reaches that person's work wherever it sits,
    which is the point of writing it to a person instead of their group.
  */
  const people = actor.scopedActUserIds ?? [];

  return (
    people.includes(request.requesterId) ||
    (request.receiverUserId !== null &&
      people.includes(request.receiverUserId)) ||
    (request.assigneeUserId !== null &&
      people.includes(request.assigneeUserId))
  );
}

/**
 * The actions this person may take on this request as it stands.
 *
 * Two filters and nothing else: the request's status has to be one the action
 * starts from, and the person has to hold its authority. Anything a caller
 * wants to know beyond that — the fields to collect, where it lands — travels
 * on the spec itself.
 */
export function availableActions(
  request: ActionableRequest,
  actor: Pick<
    Principal,
    'userId' | 'ledUnitIds' | 'scopedActUnitIds' | 'scopedActUserIds'
  >,
  isDecider = false,
): ActionSpec[] {
  return ACTIONS.filter(
    (spec) =>
      spec.from.includes(request.status) &&
      hasAuthority(spec.authority, request, actor, isDecider),
  );
}

/** Whether an action name came from outside and is one the flow knows. */
export function toRequestAction(value: string): RequestAction | null {
  return ACTIONS.find((spec) => spec.action === value)?.action ?? null;
}

/** Used by the spec that pins this table to `REQUEST_TRANSITIONS`. */
export { REQUEST_TRANSITIONS };
