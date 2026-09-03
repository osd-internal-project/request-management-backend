import { AppError } from '@request-management/share';
import {
  assertPublishable,
  findFaults,
  type ActionInput,
  type StateInput,
} from './workflow-rules';
import { REQUEST_TRANSITIONS } from '../requests/request-state-machine';

/** The standard route, in miniature: submitted → in_progress → completed. */
function validGraph(): {
  states: StateInput[];
  actions: ActionInput[];
} {
  return {
    states: [
      { key: 'waiting', phase: 'submitted', kind: 'user_task', isStart: true },
      {
        key: 'working',
        phase: 'in_progress',
        kind: 'user_task',
        isStart: false,
      },
      { key: 'done', phase: 'completed', kind: 'end', isStart: false },
    ],
    actions: [
      {
        fromStateKey: 'waiting',
        actionKey: 'receive',
        toStateKey: 'working',
        authority: 'receiver',
      },
      {
        fromStateKey: 'working',
        actionKey: 'complete',
        toStateKey: 'done',
        authority: 'carrier',
      },
    ],
  };
}

describe('workflow-rules', () => {
  it('accepts a route whose phases follow §7.1', () => {
    const { states, actions } = validGraph();

    expect(findFaults(states, actions)).toEqual([]);
    expect(() => assertPublishable(states, actions)).not.toThrow();
  });

  /**
   * The rule the whole design rests on. A workflow that moved a request
   * straight from `in_progress` to `closed` would put it in a status §7.1 says
   * is unreachable, and every consumer that trusts the state machine — the
   * queues, the SLA clock, the bottleneck report — would be reading a row that
   * cannot exist.
   */
  it('refuses a phase pair REQUEST_TRANSITIONS forbids', () => {
    const { states, actions } = validGraph();
    states[2] = { key: 'done', phase: 'closed', kind: 'end', isStart: false };

    const faults = findFaults(states, actions);

    expect(faults).toEqual([
      {
        field: 'actions.complete',
        reason: 'สถานะ §7.1 เปลี่ยนจาก in_progress ไป closed ไม่ได้',
      },
    ]);
  });

  it('allows an action that keeps the request in the same phase', () => {
    const states: StateInput[] = [
      { key: 'a', phase: 'in_progress', kind: 'user_task', isStart: true },
      { key: 'b', phase: 'in_progress', kind: 'end', isStart: false },
    ];
    const actions: ActionInput[] = [
      {
        fromStateKey: 'a',
        actionKey: 'handover',
        toStateKey: 'b',
        authority: 'carrier',
      },
    ];

    // `in_progress → in_progress` is not in REQUEST_TRANSITIONS and must not
    // have to be: two steps of the same phase are one status to §7.1.
    expect(REQUEST_TRANSITIONS.in_progress).not.toContain('in_progress');
    expect(findFaults(states, actions)).toEqual([]);
  });

  it('demands exactly one start state', () => {
    const { states, actions } = validGraph();
    states[1] = { ...states[1], isStart: true };

    expect(findFaults(states, actions)).toContainEqual({
      field: 'states.isStart',
      reason: 'ต้องมีสถานะเริ่มต้นเพียงหนึ่งเดียว (พบ 2)',
    });
  });

  it('names an action pointing at a state that does not exist', () => {
    const { states, actions } = validGraph();
    actions[1] = { ...actions[1], toStateKey: 'ghost' };

    expect(findFaults(states, actions)).toContainEqual({
      field: 'actions.complete.toStateKey',
      reason: 'ไม่พบสถานะ ghost',
    });
  });

  it('reports a state nothing can reach', () => {
    const { states, actions } = validGraph();
    states.push({
      key: 'orphan',
      phase: 'on_hold',
      kind: 'end',
      isStart: false,
    });

    expect(findFaults(states, actions)).toContainEqual({
      field: 'states.orphan',
      reason: 'ไม่มีเส้นทางไปถึงสถานะนี้',
    });
  });

  it('reports a state with no way out that is not an ending', () => {
    const { states, actions } = validGraph();
    states[2] = { ...states[2], kind: 'user_task' };

    expect(findFaults(states, actions)).toContainEqual({
      field: 'states.done',
      reason: 'สถานะนี้ไม่มีปุ่มให้ไปต่อและไม่ใช่สถานะจบ',
    });
  });

  /**
   * Without this a workflow could be configured to overwrite the columns the
   * permission and numbering models rest on, from a form field.
   */
  it('refuses a data map aimed at a column outside the allow-list', () => {
    const { states, actions } = validGraph();
    actions[0] = {
      ...actions[0],
      dataMaps: [{ targetColumn: 'status' }, { targetColumn: 'form_data' }],
    };

    expect(findFaults(states, actions)).toEqual([
      {
        field: 'actions.receive.dataMaps',
        reason: 'เขียนลงคอลัมน์ status ไม่ได้',
      },
    ]);
  });

  it('throws WORKFLOW_INVALID carrying every fault at once', () => {
    const states: StateInput[] = [
      { key: 'a', phase: 'in_progress', kind: 'user_task', isStart: false },
    ];

    expect.assertions(3);
    try {
      assertPublishable(states, []);
    } catch (error) {
      const failure = error as AppError;
      expect(failure.code).toBe('WORKFLOW_INVALID');
      // No start state, and `a` is a dead end — both, from one call.
      expect(failure.details.length).toBe(2);
      expect(failure.details.map((detail) => detail.field)).toEqual([
        'states.isStart',
        'states.a',
      ]);
    }
  });
});
