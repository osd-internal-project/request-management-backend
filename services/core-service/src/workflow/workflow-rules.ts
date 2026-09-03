import { RequestStatus } from '@prisma/client';
import { AppError, type ErrorDetail } from '@request-management/share';
import { canTransition } from '../requests/request-state-machine';

/**
 * What a workflow definition must satisfy before it may be published.
 *
 * The counterpart to `matrix-rules.ts`, and pure for the same reason: a
 * malformed route must never reach the table, and the cheapest way to be sure
 * of that is a function with no database and no network that a test can walk
 * exhaustively.
 *
 * # Why rule 4 is the important one
 *
 * A workflow names its own states, but `Request.status` remains one of §7.1's
 * eleven — every state declares the `phase` it reports as. That is what keeps
 * SLA (`CLOCK_PAUSED_IN`), the bottleneck report and every §16 screen working
 * while the steps become configuration.
 *
 * It also creates the one way this can go quietly wrong: a workflow could be
 * drawn whose phases imply `in_progress → closed`, which
 * `REQUEST_TRANSITIONS` forbids. The request would land in a status the state
 * machine says is unreachable, and every consumer that trusts §7.1 — the
 * queues, the clock, the report — would be reasoning about a row that cannot
 * exist. So the transitions are asked, never restated: `canTransition` is the
 * one authority, exactly as `available-actions.ts` treats it.
 */

/** The columns a workflow's data flow is allowed to write back. */
export const WRITABLE_TARGET_COLUMNS: readonly string[] = [
  'form_data',
  'receiver_form_data',
];

export interface StateInput {
  readonly key: string;
  readonly phase: RequestStatus;
  readonly kind: 'user_task' | 'approval' | 'end';
  readonly isStart: boolean;
}

export interface ActionInput {
  readonly fromStateKey: string;
  readonly actionKey: string;
  readonly toStateKey: string;
  readonly authority: string;
  readonly condition?: string | null;
  readonly dataMaps?: readonly { readonly targetColumn: string }[];
}

/**
 * Every fault in one pass.
 *
 * Deliberately not fail-fast: an administrator fixing a route one error per
 * save is an administrator who stops using the screen. `AppError.details`
 * carries the whole list and A1's sibling screen renders them as a list.
 */
export function findFaults(
  states: readonly StateInput[],
  actions: readonly ActionInput[],
): ErrorDetail[] {
  const faults: ErrorDetail[] = [];
  const byKey = new Map(states.map((state) => [state.key, state]));

  if (byKey.size !== states.length) {
    faults.push({ field: 'states', reason: 'มี key ซ้ำกัน' });
  }

  const starts = states.filter((state) => state.isStart);
  if (starts.length !== 1) {
    faults.push({
      field: 'states.isStart',
      reason: `ต้องมีสถานะเริ่มต้นเพียงหนึ่งเดียว (พบ ${starts.length})`,
    });
  }

  for (const action of actions) {
    const from = byKey.get(action.fromStateKey);
    const to = byKey.get(action.toStateKey);

    if (!from) {
      faults.push({
        field: `actions.${action.actionKey}.fromStateKey`,
        reason: `ไม่พบสถานะ ${action.fromStateKey}`,
      });
    }

    if (!to) {
      faults.push({
        field: `actions.${action.actionKey}.toStateKey`,
        reason: `ไม่พบสถานะ ${action.toStateKey}`,
      });
      continue;
    }

    if (!from) continue;

    // Rule 4 — see the header. A phase pair the state machine refuses would
    // put a request in a status §7.1 says is unreachable.
    if (from.phase !== to.phase && !canTransition(from.phase, to.phase)) {
      faults.push({
        field: `actions.${action.actionKey}`,
        reason: `สถานะ §7.1 เปลี่ยนจาก ${from.phase} ไป ${to.phase} ไม่ได้`,
      });
    }

    for (const map of action.dataMaps ?? []) {
      if (!WRITABLE_TARGET_COLUMNS.includes(map.targetColumn)) {
        faults.push({
          field: `actions.${action.actionKey}.dataMaps`,
          reason: `เขียนลงคอลัมน์ ${map.targetColumn} ไม่ได้`,
        });
      }
    }
  }

  faults.push(
    ...unreachable(states, actions),
    ...deadEnds(states, actions),
    ...conditionalSingleExits(actions),
  );

  return faults;
}

/**
 * States nothing leads to.
 *
 * A state an administrator can see on the screen but no request can ever
 * arrive at is almost always a half-finished edit, and it is invisible once
 * deployed — the engine simply never enters it.
 */
function unreachable(
  states: readonly StateInput[],
  actions: readonly ActionInput[],
): ErrorDetail[] {
  const start = states.find((state) => state.isStart);
  if (!start) return [];

  const outgoing = new Map<string, string[]>();
  for (const action of actions) {
    const list = outgoing.get(action.fromStateKey) ?? [];
    list.push(action.toStateKey);
    outgoing.set(action.fromStateKey, list);
  }

  const seen = new Set<string>([start.key]);
  const queue = [start.key];

  while (queue.length) {
    for (const next of outgoing.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }

  return states
    .filter((state) => !seen.has(state.key))
    .map((state) => ({
      field: `states.${state.key}`,
      reason: 'ไม่มีเส้นทางไปถึงสถานะนี้',
    }));
}

/**
 * States with no way out that are not endings.
 *
 * A request that reaches one is stuck with no button to press and no status
 * that says it is finished — the worst failure this screen can produce,
 * because it looks fine until somebody's ticket is in it.
 */
function deadEnds(
  states: readonly StateInput[],
  actions: readonly ActionInput[],
): ErrorDetail[] {
  const hasExit = new Set(actions.map((action) => action.fromStateKey));

  return states
    .filter((state) => state.kind !== 'end' && !hasExit.has(state.key))
    .map((state) => ({
      field: `states.${state.key}`,
      reason: 'สถานะนี้ไม่มีปุ่มให้ไปต่อและไม่ใช่สถานะจบ',
    }));
}

/**
 * A state whose only way out is conditional.
 *
 * Flowable refuses to deploy this outright —
 * `flowable-exclusive-gateway-condition-not-allowed-on-single-seq-flow`, which
 * fails the whole deployment with HTTP 500 and a message about gateways that
 * means nothing to whoever drew the route. Caught here instead, in the terms
 * the screen uses.
 *
 * It is also a genuine dead end: with one exit and a condition that turns out
 * false, the request has no button that works and no state to move to. Found
 * by deploying generated BPMN to a real engine — every unit test passed.
 */
function conditionalSingleExits(
  actions: readonly ActionInput[],
): ErrorDetail[] {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.fromStateKey, (counts.get(action.fromStateKey) ?? 0) + 1);
  }

  return actions
    .filter(
      (action) =>
        Boolean(action.condition?.trim()) &&
        counts.get(action.fromStateKey) === 1,
    )
    .map((action) => ({
      field: `actions.${action.actionKey}.condition`,
      reason:
        'ปุ่มเดียวของสถานะนี้มีเงื่อนไข — ถ้าเงื่อนไขไม่จริงจะไม่มีทางไปต่อ',
    }));
}

/**
 * Guards a publish. Throws with every fault at once rather than returning a
 * list, so a caller cannot forget to check the result — the same reason
 * `assertTransition` throws.
 */
export function assertPublishable(
  states: readonly StateInput[],
  actions: readonly ActionInput[],
): void {
  const faults = findFaults(states, actions);

  if (faults.length) {
    throw new AppError(
      'WORKFLOW_INVALID',
      'ผังงานนี้ยังเผยแพร่ไม่ได้ กรุณาแก้ตามรายการด้านล่าง',
      faults,
    );
  }
}
