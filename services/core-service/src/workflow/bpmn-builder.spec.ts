import { buildBpmn, type ActionInput } from './bpmn-builder';
import type { StateInput } from './workflow-rules';

const OPTIONS = {
  callbackUrl: 'http://core:3002/api/v1/internal/workflow/callback',
  callbackSecret: 'test-secret',
};

const STATES: StateInput[] = [
  { key: 'waiting', phase: 'submitted', kind: 'user_task', isStart: true },
  { key: 'working', phase: 'in_progress', kind: 'user_task', isStart: false },
  { key: 'done', phase: 'completed', kind: 'end', isStart: false },
];

const ACTIONS: ActionInput[] = [
  { fromStateKey: 'waiting', actionKey: 'receive', toStateKey: 'working' },
  { fromStateKey: 'working', actionKey: 'complete', toStateKey: 'done' },
  { fromStateKey: 'working', actionKey: 'cancel', toStateKey: 'done' },
];

function build(states = STATES, actions = ACTIONS) {
  return buildBpmn(
    { processKey: 'wf_DSC_v1', name: 'ขอส่วนลด' },
    states,
    actions,
    OPTIONS,
  );
}

describe('bpmn-builder', () => {
  it('starts the process at the state marked isStart', () => {
    expect(build()).toContain(
      '<sequenceFlow id="flow_start" sourceRef="start" targetRef="waiting" />',
    );
  });

  it('renders a user task per non-terminal state and an end event per ending', () => {
    const xml = build();

    expect(xml).toContain('<userTask id="waiting"');
    expect(xml).toContain('<userTask id="working"');
    expect(xml).toContain('<endEvent id="done" />');
    expect(xml).not.toContain('<userTask id="done"');
  });

  /**
   * The design in one assertion: the workflow writes to the database itself,
   * through a callback the application exposes.
   */
  it('puts a callback HTTP task after every waiting state', () => {
    const xml = build();

    expect(xml).toContain(
      '<serviceTask id="waiting_callback" flowable:type="http"',
    );
    expect(xml).toContain(
      '<serviceTask id="working_callback" flowable:type="http"',
    );
    expect(xml).toContain(OPTIONS.callbackUrl);
  });

  /**
   * Run asynchronously the engine would return before the callback had
   * written, and the screen that pressed the button would re-read the request
   * and see the state it had just left.
   */
  it('runs the callback synchronously', () => {
    expect(build()).toContain('flowable:async="false"');
  });

  /**
   * Flowable's http task treats any response as success unless told otherwise.
   *
   * Found on a real engine: with the callback answering 401, every button
   * press still advanced the process, and the request row never moved. The
   * engine and the database silently disagreed about where the work was, with
   * nothing reporting a fault.
   */
  it('fails the task when the callback refuses', () => {
    const xml = build();

    expect(xml).toContain('failStatusCodes');
    expect(xml).toMatch(/failStatusCodes[\s\S]*?401[\s\S]*?500/);
  });

  it('tells the callback which state was left and which button was pressed', () => {
    const xml = build();

    // Element text, not an attribute — quotes need no escaping here.
    expect(xml).toContain('"state_key":"waiting"');
    expect(xml).toContain(`"action":"\${execution.getVariable('action')}"`);
  });

  /**
   * A JUEL expression naming an unset variable throws rather than resolving
   * empty, so the body must reference only what the engine certainly has.
   *
   * Found on a real engine: an earlier body interpolated `${variablesJson}`,
   * which nothing ever set, and every task completion failed with HTTP 500
   * `Unknown property used in expression`. This test passed throughout.
   */
  it('interpolates nothing the engine might not have set', () => {
    const xml = build();

    expect(xml).not.toContain('variablesJson');
    // Bare `${action}` throws when unset; the accessor form answers null.
    expect(xml).not.toContain('"action":"${action}"');
  });

  it('routes one conditional flow per action out of a state', () => {
    const xml = build();

    expect(xml).toContain(
      '<sequenceFlow id="flow_working_gateway_complete" sourceRef="working_gateway" targetRef="done">',
    );
    expect(xml).toContain(
      '<sequenceFlow id="flow_working_gateway_cancel" sourceRef="working_gateway" targetRef="done">',
    );
    expect(xml).toContain("${action == 'complete'}");
    expect(xml).toContain("${action == 'cancel'}");
  });

  it("ands an action's own condition onto the button guard", () => {
    const xml = build(STATES, [
      { fromStateKey: 'waiting', actionKey: 'receive', toStateKey: 'working' },
      {
        fromStateKey: 'waiting',
        actionKey: 'reject',
        toStateKey: 'done',
        condition: 'amount > 100000',
      },
    ]);

    expect(xml).toContain(
      "${action == 'reject' &amp;&amp; (amount &gt; 100000)}",
    );
  });

  /**
   * Found by deploying to a real engine: Flowable refuses an exclusive gateway
   * whose single outgoing flow carries a condition
   * (`flowable-exclusive-gateway-condition-not-allowed-on-single-seq-flow`),
   * and fails the whole deployment with HTTP 500. Every unit test here passed
   * before that deployment was attempted.
   */
  it('emits no gateway for a state with only one way out', () => {
    const xml = build(STATES, [
      { fromStateKey: 'waiting', actionKey: 'receive', toStateKey: 'working' },
      { fromStateKey: 'working', actionKey: 'complete', toStateKey: 'done' },
    ]);

    expect(xml).not.toContain('waiting_gateway');
    expect(xml).toContain(
      '<sequenceFlow id="flow_waiting_receive" sourceRef="waiting_callback" targetRef="working" />',
    );
    // …and no condition anywhere, since there is nothing to choose between.
    expect(xml).not.toContain('conditionExpression');
  });

  /**
   * An approval state routes like any other. Who may decide it is resolved at
   * runtime from the org chart — freezing names into the XML would point at
   * the wrong people the moment the chart changed.
   */
  it('emits no approver names for an approval state', () => {
    const xml = build(
      [
        {
          key: 'check',
          phase: 'pending_approval',
          kind: 'approval',
          isStart: true,
        },
        { key: 'done', phase: 'approved', kind: 'end', isStart: false },
      ],
      [{ fromStateKey: 'check', actionKey: 'approve', toStateKey: 'done' }],
    );

    expect(xml).toContain('<userTask id="check"');
    expect(xml).not.toMatch(/candidateUsers|assignee=/);
  });

  it('escapes text that would otherwise break the document', () => {
    const xml = buildBpmn(
      { processKey: 'wf', name: 'ส่วนลด <"R&D">' },
      [{ key: 'a', phase: 'draft', kind: 'end', isStart: true }],
      [],
      OPTIONS,
    );

    expect(xml).toContain('name="ส่วนลด &lt;&quot;R&amp;D&quot;&gt;"');
  });

  it('refuses to build a graph with no start state', () => {
    expect(() =>
      build([{ key: 'a', phase: 'draft', kind: 'end', isStart: false }], []),
    ).toThrow(/assertPublishable/);
  });
});
