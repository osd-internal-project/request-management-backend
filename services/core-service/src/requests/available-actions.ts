import { RequestStatus } from '@prisma/client';
import type {
  Permission,
  Principal,
  ScopePermission,
} from '@request-management/share';
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
  | 'advance'
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
  /** Whoever holds the current flow step: the requester (or their stand-in) under a requester scope, else the carrier. */
  | 'step_holder'
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
  /** v2 flows: who holds a requester step after the requester handed it on. */
  readonly stepHolderUserId?: string | null;
  readonly flowVersionId?: string | null;
  /** The pinned flow's schema: 1 moves only inside in_progress, 2 owns the whole path. */
  readonly flowVersion?: { readonly schemaVersion: number } | null;
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
  /**
   * The permission a scope grant must carry to reach this action.
   *
   * Only meaningful for the authorities a grant can satisfy — `carrier` and the
   * two `*_or_lead` pairs. Declared on the row rather than derived from the
   * endpoint's `@Permissions()` so the two cannot drift, and so a reader can
   * see in one table which actions an administrator is handing over.
   *
   * `null` means no grant reaches it however it is written: `submit` belongs to
   * the requester, `receive` to the named receiver, `approve` to the ladder.
   */
  readonly scopePermission: ScopePermission | null;
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
    scopePermission: null,
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
    scopePermission: null,
    fields: [{ name: 'form_data', required: false, source: 'form_schema' }],
  },
  {
    action: 'receive',
    from: ['submitted'],
    to: ['in_progress'],
    authority: 'receiver',
    /*
      No grant reaches this one. `receiver` is deliberately narrower than
      `carrier` — accepting a ticket is the named person's alone — and a scope
      grant that quietly accepted on their behalf would take the ticket out of
      their queue without their knowing.
    */
    scopePermission: null,
    fields: [],
  },
  {
    action: 'assign',
    // Handing the work on does not move the request; it changes who carries
    // it. Allowed wherever the request is still open.
    from: LIVE_STATUSES,
    to: [],
    // A v2 requester step is handed on by its holder; elsewhere this is `carrier`.
    authority: 'step_holder',
    scopePermission: 'request.complete',
    fields: [{ name: 'assignee_user_id', required: true }],
  },
  {
    action: 'hold',
    from: ['in_progress'],
    to: ['on_hold'],
    authority: 'carrier',
    scopePermission: 'request.hold',
    fields: [{ name: 'reason', required: true }],
  },
  {
    action: 'resume',
    from: ['on_hold'],
    to: ['in_progress'],
    authority: 'carrier',
    scopePermission: 'request.hold',
    fields: [{ name: 'note', required: false }],
  },
  {
    action: 'complete',
    from: ['in_progress'],
    to: ['completed'],
    authority: 'carrier',
    scopePermission: 'request.complete',
    fields: [
      {
        name: 'receiver_form_data',
        required: true,
        source: 'receiver_form_schema',
      },
    ],
  },
  {
    // Moves between the steps of the type's flow; a step with an exit ladder
    // waits in `pending_approval`. Offered only on requests that have a flow.
    action: 'advance',
    // v1 flows move only inside in_progress; v2 steps may also sit under returned/approved.
    from: ['returned', 'in_progress', 'approved'],
    to: [],
    authority: 'step_holder',
    scopePermission: 'request.complete',
    fields: [{ name: 'to_step', required: true }],
  },
  {
    // The use case calls this "rollback". Same thing: the ticket goes back to
    // the person who raised it, with a reason from the type's own list.
    action: 'return',
    from: ['submitted', 'in_progress'],
    to: ['returned'],
    authority: 'carrier_or_lead',
    scopePermission: 'request.return',
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
    scopePermission: null,
    // Required, like reject and send_back: ApprovalsService.decide refuses a
    // blank note on every decision, so advertising it as optional here is what
    // made integrations POST an empty body and get a 400 they could not read.
    fields: [{ name: 'note', required: true }],
  },
  {
    action: 'reject',
    from: ['pending_approval'],
    to: ['rejected'],
    authority: 'decider',
    scopePermission: null,
    fields: [{ name: 'note', required: true }],
  },
  {
    // Sent back from a check — to the requester before the work, to the team
    // that did it after.
    action: 'send_back',
    from: ['pending_approval'],
    to: ['returned', 'in_progress'],
    authority: 'decider',
    scopePermission: null,
    fields: [{ name: 'note', required: true }],
  },
  {
    action: 'cancel',
    from: statusesLeadingTo('cancelled'),
    to: ['cancelled'],
    authority: 'requester_or_lead',
    scopePermission: 'request.cancel.any',
    fields: [{ name: 'reason', required: true }],
  },
  {
    action: 'close',
    from: ['approved'],
    to: ['closed'],
    authority: 'requester',
    scopePermission: null,
    fields: [{ name: 'note', required: false }],
  },
  {
    action: 'comment',
    from: LIVE_STATUSES,
    to: [],
    authority: 'viewer',
    scopePermission: null,
    fields: [{ name: 'body', required: true }],
  },
  {
    // A piece of work that breaks into another department's request, kept
    // linked to this one. Not a status change on this request at all.
    action: 'create_child',
    from: LIVE_STATUSES,
    to: [],
    authority: 'viewer',
    scopePermission: null,
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
  actor: ScopeActor,
  /** Whether the actor may decide the request's current approval step. */
  isDecider = false,
  /**
   * The permission a scope grant must carry to reach this action, from the
   * spec's `scopePermission`. `null` means no grant reaches it.
   */
  scopePermission: ScopePermission | null = null,
): boolean {
  const isRequester = request.requesterId === actor.userId;
  const isReceiver = request.receiverUserId === actor.userId;
  const isCarrier = isReceiver || request.assigneeUserId === actor.userId;
  const granted = scopeGrants(request, actor, scopePermission);

  switch (authority) {
    case 'viewer':
      return true;
    case 'requester':
      return isRequester;
    case 'receiver':
      return isReceiver;
    /*
      A grant reaches `carrier` since 7 ก.ย. 2569 — "that team may work on our
      tickets". Deliberately **not** routed through `leads()`: heads of groups
      could return and cancel yesterday but never complete or hold, and putting
      this behind `leads()` would hand every head of every group a set of
      actions nobody granted them.
    */
    case 'carrier':
      return isCarrier || granted;
    case 'carrier_or_lead':
      return isCarrier || leads(request, actor) || granted;
    case 'requester_or_lead':
      return isRequester || leads(request, actor) || granted;
    case 'decider':
      return isDecider;
    case 'step_holder':
      return request.flowVersion?.schemaVersion === 2 &&
        REQUESTER_SCOPES.includes(request.status)
        ? actor.userId === (request.stepHolderUserId ?? request.requesterId)
        : isCarrier || granted;
  }
}

/** Statuses whose flow steps the requester holds. */
const REQUESTER_SCOPES: readonly RequestStatus[] = [
  'draft',
  'returned',
  'approved',
];

/** Everything about the actor an authority question reads. */
export type ScopeActor = Pick<
  Principal,
  | 'userId'
  | 'ledUnitIds'
  | 'permissions'
  | 'scopedActUnitIds'
  | 'scopedActUserIds'
  | 'scopedByPermission'
>;

/**
 * Whether a scope grant lets this person take this action on this request.
 *
 * **An intersection, never a gift.** The permission has to be one the actor's
 * own roles already hold *and* one the grant names — a grant that handed out a
 * permission on its own would be a way around
 * `assertSeparationOfDuties`, which only ever sees a role's permission set.
 *
 * The grant is matched against the same four columns the read rules use, so
 * "may act on RND's work" means the requests RND raised or receives, and a
 * grant written to one person follows that person's work wherever it sits.
 */
function scopeGrants(
  request: ActionableRequest,
  actor: ScopeActor,
  permission: ScopePermission | null,
): boolean {
  if (!permission) return false;
  if (!actor.permissions?.includes(permission)) return false;

  const reach =
    actor.scopedByPermission?.[permission] ?? fallbackReach(actor, permission);

  const byUnit =
    (request.requesterOrgUnitId !== null &&
      reach.unitIds.includes(request.requesterOrgUnitId)) ||
    (request.receiverOrgUnitId !== null &&
      reach.unitIds.includes(request.receiverOrgUnitId));

  if (byUnit) return true;

  return (
    reach.userIds.includes(request.requesterId) ||
    (request.receiverUserId !== null &&
      reach.userIds.includes(request.receiverUserId)) ||
    (request.assigneeUserId !== null &&
      reach.userIds.includes(request.assigneeUserId))
  );
}

/**
 * What a principal built by the *previous* release reaches, during a rolling
 * deploy.
 *
 * That release carried one `canAct` boolean, and it reached exactly two
 * authorities: returning and cancelling. Those two therefore fall back to it,
 * and the actions it never reached fall back to nothing — reading the old
 * boolean as though it had meant "may complete" would hand out authority
 * nobody held the day before. The migration backfills the same two codes for
 * the same reason.
 */
function fallbackReach(
  actor: ScopeActor,
  permission: ScopePermission,
): { unitIds: readonly string[]; userIds: readonly string[] } {
  const inherited: readonly ScopePermission[] = [
    'request.return',
    'request.cancel.any',
  ];

  if (!inherited.includes(permission)) return { unitIds: [], userIds: [] };

  return {
    unitIds: actor.scopedActUnitIds ?? [],
    userIds: actor.scopedActUserIds ?? [],
  };
}

/**
 * Whether this person heads a group the request sits in, or one above it.
 *
 * **Grants moved out of here on 7 ก.ย. 2569.** This used to union
 * `scopedActUnitIds` / `scopedActUserIds` in, back when a grant carried one
 * `canAct` boolean and every action it reached was the same set. Now a grant
 * names the permissions it carries, so which action is being asked about
 * decides the answer — that question belongs to {@link scopeGrants}, which has
 * the permission in hand. Leading a group is unconditional and stays here.
 *
 * **Never the plain `scopedUnitIds` / `scopedUserIds`** — a grant that only
 * lets somebody read another group's work must not let them move it.
 */
function leads(
  request: ActionableRequest,
  actor: Pick<Principal, 'ledUnitIds'>,
): boolean {
  const units = actor.ledUnitIds ?? [];

  return (
    (request.requesterOrgUnitId !== null &&
      units.includes(request.requesterOrgUnitId)) ||
    (request.receiverOrgUnitId !== null &&
      units.includes(request.receiverOrgUnitId))
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
  actor: ScopeActor,
  isDecider = false,
): ActionSpec[] {
  return ACTIONS.filter(
    (spec) =>
      spec.from.includes(request.status) &&
      offeredOnFlow(spec.action, request) &&
      hasAuthority(
        spec.authority,
        request,
        actor,
        isDecider,
        spec.scopePermission,
      ),
  );
}

/** Verbs a v2 flow replaces with `advance` along its own steps. */
const REPLACED_BY_FLOW_V2: ReadonlySet<RequestAction> = new Set([
  'complete',
  'close',
  'resubmit',
  'return',
]);

/** `advance` exists only on a flow (v1: inside in_progress); a v2 flow retires the fixed verbs. */
function offeredOnFlow(
  action: RequestAction,
  request: ActionableRequest,
): boolean {
  const schema = request.flowVersionId
    ? (request.flowVersion?.schemaVersion ?? 1)
    : null;
  if (action === 'advance') {
    return schema === 2 || (schema === 1 && request.status === 'in_progress');
  }
  // An approval step is handed on through delegation, not `assign`.
  if (action === 'assign' && schema === 2) {
    return request.status !== 'pending_approval';
  }
  return !(schema === 2 && REPLACED_BY_FLOW_V2.has(action));
}

/**
 * The row of {@link ACTIONS} for one action.
 *
 * The lookup exists so that a handler asking "may this person do this" names
 * the action and reads both its authority and its scope permission from the one
 * table, rather than restating either at the call site where they can drift.
 */
export function specFor(action: RequestAction): ActionSpec {
  const spec = ACTIONS.find((entry) => entry.action === action);

  /* istanbul ignore next -- the union makes this unreachable */
  if (!spec) throw new Error(`no action spec for ${action}`);

  return spec;
}

/** Whether an action name came from outside and is one the flow knows. */
export function toRequestAction(value: string): RequestAction | null {
  return ACTIONS.find((spec) => spec.action === value)?.action ?? null;
}

/** Used by the spec that pins this table to `REQUEST_TRANSITIONS`. */
export { REQUEST_TRANSITIONS };

/**
 * The permission each action requires of the person performing it.
 *
 * `hasAuthority` above answers *is this person the requester / the carrier /
 * an approver on this request* — a question about one row. This answers a
 * different one: *is this person allowed to do this kind of thing at all* —
 * the question `PolicyGuard` asks from a route's `@Permissions()`.
 *
 * Both have always applied on the screens, one per route
 * (`POST requests/:id/hold` declares `request.hold`, and so on). The external
 * API collapses all fourteen verbs into one dispatcher, so it cannot state
 * them in a decorator; it reads them from here and checks the acting user
 * against them before dispatching. Without this table that check simply did
 * not happen for an integration, because the swap runs after `PolicyGuard`
 * (see `ActingPolicyGuard`).
 *
 * `action-permissions.spec.ts` fails if an action in {@link ACTIONS} is
 * missing here, so a new verb cannot ship without deciding who may send it.
 *
 * Suggestion: `requests.controller.ts` currently repeats these in its
 * decorators, which makes this the second copy. Having the controller read
 * this table — or generating its decorators from it — would remove the drift
 * for good; say the word and I'll do it.
 */
export const ACTION_PERMISSIONS: Readonly<Record<RequestAction, Permission>> = {
  submit: 'request.create',
  resubmit: 'request.create',
  receive: 'request.complete',
  assign: 'request.complete',
  comment: 'request.read',
  hold: 'request.hold',
  resume: 'request.hold',
  complete: 'request.complete',
  advance: 'request.complete',
  return: 'request.return',
  approve: 'approval.decide',
  reject: 'approval.decide',
  send_back: 'approval.decide',
  cancel: 'request.cancel.own',
  close: 'request.create',
  /*
    Listed for completeness, never reached: a child request is an ordinary
    request raised through the create route, and the dispatcher refuses this
    verb with an explanation. `request.create` is what that route asks for.
  */
  create_child: 'request.create',
};
