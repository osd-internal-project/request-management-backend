import type { StateInput } from './workflow-rules';

/**
 * Turns the configuration tables into the BPMN Flowable actually runs.
 *
 * **The tables are the source of truth; this output is a projection.** Nobody
 * authors BPMN by hand, and nothing reads the deployed XML back to answer a
 * question — the admin screen, the action list and the callback all read
 * `workflow_states` / `workflow_actions`. Flowable's copy exists so an engine
 * that knows nothing about this domain can still say what comes next.
 *
 * Pure on purpose, like `approval-chain.ts` and `matrix-rules.ts`: no database,
 * no network, so a test can assert the exact XML for a route rather than
 * standing up an engine to find out what was generated.
 *
 * # The shape of one state
 *
 * ```
 *   ┌──────────┐   ┌───────────┐   ┌──────────┐
 *   │ userTask │──▶│ http task │──▶│ gateway  │──▶ … next state's userTask
 *   │  {key}   │   │ callback  │   │ on action│
 *   └──────────┘   └───────────┘   └──────────┘
 * ```
 *
 * The HTTP task between the task and the gateway is the whole design: **the
 * workflow writes to the database, the application does not write on its
 * behalf.** Completing a task hands the engine the form; the engine then calls
 * back into core-service with the state it has arrived at and the actions
 * available there, and that callback is what updates `requests`.
 *
 * It is deliberately `flowable:async="false"`. Run asynchronously, the engine
 * would return from `completeTask` before the callback had written anything,
 * and the screen that pressed the button would re-read the request and see the
 * state it had just left — the classic "I pressed it and nothing happened".
 */

export interface DefinitionInput {
  readonly processKey: string;
  readonly name: string;
}

export interface ActionInput {
  readonly fromStateKey: string;
  readonly actionKey: string;
  readonly toStateKey: string;
  /** Optional guard on workflow variables, e.g. `amount > 100000`. */
  readonly condition?: string | null;
}

export interface BuildOptions {
  /** Absolute URL of `POST /internal/workflow/callback`. */
  readonly callbackUrl: string;
  /**
   * The shared secret the callback route demands.
   *
   * Baked into the deployed XML, which is why the route it opens is reachable
   * only inside the deployment's own network — see `workflow-callback.guard.ts`.
   */
  readonly callbackSecret: string;
}

/** XML text escaping. Attribute values go through {@link attr}. */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attr(value: string): string {
  return xml(value).replace(/"/g, '&quot;');
}

/** `waiting` → `waiting_callback`, and so on. Ids must be unique per process. */
const callbackId = (stateKey: string) => `${stateKey}_callback`;
const gatewayId = (stateKey: string) => `${stateKey}_gateway`;
const flowId = (from: string, to: string) => `flow_${from}_${to}`;

/**
 * The HTTP task that lets the workflow write.
 *
 * `requestBody` is an expression the engine evaluates, and that is narrower
 * than it looks: **a JUEL expression naming a variable that is not set throws**
 * — `Unknown property used in expression` — which fails the task, not just the
 * interpolation. So the body carries only what the engine is certain to have.
 *
 * That is why there is no `variables` field. An earlier version interpolated a
 * `${variablesJson}` that nothing ever set, and every task completion died at
 * the callback with HTTP 500. The unit tests could not see it: they asserted
 * the string was in the XML, which it was. It took completing a task on a real
 * engine to find.
 *
 * core-service does not need them here anyway — it is the caller that
 * completed the task, so it already holds the payload, and `FlowableClient`
 * can read the engine's copy when it wants it.
 *
 * `execution.getVariable('action')` rather than `${action}` for the same
 * reason: the accessor answers null for an unset variable instead of throwing.
 */
function callbackTask(stateKey: string, options: BuildOptions): string {
  const body = [
    '{',
    '"process_instance_id":"${execution.processInstanceId}",',
    '"execution_id":"${execution.id}",',
    `"state_key":"${stateKey}",`,
    `"action":"\${execution.getVariable('action')}",`,
    `"actor_user_id":"\${execution.getVariable('actorUserId')}"`,
    '}',
  ].join('');

  /*
    `Idempotency-Key` reuses the interceptor this application already has
    (NFR-03): a replayed POST with the same key answers with the stored
    response instead of writing twice. Flowable retries a failed http task, so
    without it a retried callback would write a second `RequestEvent` and a
    second audit row for one button press.

    Keyed on the execution rather than the instance: one instance passes
    through many states, and each passage is its own write.
  */
  const headers = [
    'Content-Type: application/json',
    `X-Workflow-Secret: ${options.callbackSecret}`,
    `Idempotency-Key: wf-${stateKey}-\${execution.id}`,
  ].join('\n');

  return `    <serviceTask id="${attr(callbackId(stateKey))}" flowable:type="http" flowable:async="false">
      <extensionElements>
        <flowable:field name="requestMethod"><flowable:string>POST</flowable:string></flowable:field>
        <flowable:field name="requestUrl"><flowable:string>${attr(options.callbackUrl)}</flowable:string></flowable:field>
        <flowable:field name="requestHeaders"><flowable:expression>${xml(headers)}</flowable:expression></flowable:field>
        <flowable:field name="requestBody"><flowable:expression>${xml(body)}</flowable:expression></flowable:field>
        <flowable:field name="saveResponseParameters"><flowable:string>true</flowable:string></flowable:field>
        <flowable:field name="responseVariableName"><flowable:string>callbackResponse</flowable:string></flowable:field>
        <!--
          Without this the http task treats **any** response as success. A
          callback that answered 401 or 500 would leave the engine advancing to
          the next state while the database never heard about the move — the
          request's status frozen at the previous step, its instance already
          past it, and nothing anywhere reporting a problem.

          Failing the task instead keeps the two honest: the completion returns
          an error, the engine stays where it was, and the caller sees it.
        -->
        <flowable:field name="failStatusCodes"><flowable:string>400,401,403,404,405,408,429,500,502,503,504</flowable:string></flowable:field>
      </extensionElements>
    </serviceTask>
`;
}

/**
 * Builds the deployable BPMN for one workflow definition.
 *
 * Assumes the graph has already passed `assertPublishable` — a start state, no
 * orphans, no dead ends. Generating XML for a broken graph would produce a
 * deployment that fails inside Flowable with a message nobody can act on.
 */
export function buildBpmn(
  definition: DefinitionInput,
  states: readonly StateInput[],
  actions: readonly ActionInput[],
  options: BuildOptions,
): string {
  const start = states.find((state) => state.isStart);
  if (!start) {
    throw new Error(
      'buildBpmn called with no start state — assertPublishable first',
    );
  }

  const parts: string[] = [];

  parts.push(`<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowable="http://flowable.org/bpmn"
             targetNamespace="http://request-management/workflow">
  <process id="${attr(definition.processKey)}" name="${attr(definition.name)}" isExecutable="true">
    <startEvent id="start" />
    <sequenceFlow id="flow_start" sourceRef="start" targetRef="${attr(start.key)}" />
`);

  for (const state of states) {
    if (state.kind === 'end') {
      parts.push(`    <endEvent id="${attr(state.key)}" />\n`);
      continue;
    }

    // An approval state is a user task like any other as far as the route is
    // concerned. Who may decide it is resolved at runtime from the org chart
    // by the application — never frozen into this XML, which would point at
    // the wrong people the moment the chart changed.
    const outgoing = actions.filter((a) => a.fromStateKey === state.key);

    parts.push(
      `    <userTask id="${attr(state.key)}" name="${attr(state.key)}" />\n`,
      `    <sequenceFlow id="${attr(`${state.key}_to_callback`)}" sourceRef="${attr(state.key)}" targetRef="${attr(callbackId(state.key))}" />\n`,
      callbackTask(state.key, options),
    );

    /*
      One way out needs no gateway, and Flowable refuses one that has it.

      An exclusive gateway with a single outgoing flow may not carry a
      condition — `flowable-exclusive-gateway-condition-not-allowed-on-single-seq-flow`,
      which fails the whole deployment with HTTP 500. It is also the right
      shape regardless: there is nothing to choose between, so the callback
      task flows straight on to the only state it can reach.

      `workflow-rules.ts` refuses a single exit that carries a condition, so
      the case this cannot express is one the screen will not let through.
    */
    if (outgoing.length === 1) {
      parts.push(
        `    <sequenceFlow id="${attr(flowId(state.key, outgoing[0].actionKey))}" sourceRef="${attr(callbackId(state.key))}" targetRef="${attr(outgoing[0].toStateKey)}" />\n`,
      );
      continue;
    }

    parts.push(
      `    <sequenceFlow id="${attr(`${state.key}_to_gateway`)}" sourceRef="${attr(callbackId(state.key))}" targetRef="${attr(gatewayId(state.key))}" />\n`,
      `    <exclusiveGateway id="${attr(gatewayId(state.key))}" />\n`,
    );

    for (const action of outgoing) {
      // The button pressed is carried in `action`; an extra `condition` from
      // the screen narrows it further, e.g. only route to the second approval
      // level above a value.
      const guard = action.condition
        ? `\${action == '${action.actionKey}' && (${action.condition})}`
        : `\${action == '${action.actionKey}'}`;

      parts.push(
        `    <sequenceFlow id="${attr(flowId(gatewayId(state.key), action.actionKey))}" sourceRef="${attr(gatewayId(state.key))}" targetRef="${attr(action.toStateKey)}">\n`,
        `      <conditionExpression xsi:type="tFormalExpression" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${xml(guard)}</conditionExpression>\n`,
        `    </sequenceFlow>\n`,
      );
    }
  }

  parts.push(`  </process>
</definitions>
`);

  return parts.join('');
}
