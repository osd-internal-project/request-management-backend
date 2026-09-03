import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  PrismaService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma, type Request as RequestRow } from '@prisma/client';
import { FlowableClient } from './flowable.client';
import {
  WorkflowInstanceRepository,
  WorkflowRepository,
} from './workflow.repository';
import { hasAuthority, type Authority } from '../requests/available-actions';
import { WRITABLE_TARGET_COLUMNS } from './workflow-rules';
import type { WorkflowCallbackDto } from './dto/workflow.dto';

/** Flowable renders an unset variable as this string, not as an empty value. */
const ENGINE_NULL = 'null';

/**
 * Driving a request through its workflow.
 *
 * The division of labour, which is the whole point of the design:
 *
 * ```
 *  this service          the engine              the callback
 *  ────────────          ──────────              ────────────
 *  checks authority  →   decides where it   →    writes status, form data,
 *  hands over the        goes next               the event and the audit row
 *  form
 * ```
 *
 * **Nothing here writes the request's status.** `perform` completes a task and
 * stops; the row changes when the engine calls `applyCallback` back. That is
 * what makes the route configuration rather than code — this service has no
 * opinion about what `receive` means or where it leads.
 *
 * What it does keep is the one thing the engine must never hold: **who is
 * allowed to press the button.** `hasAuthority` is the same function the
 * legacy state machine's action list uses, so a workflow cannot widen access
 * that §7.1's路 path would refuse (ROLE-01).
 *
 * # Why the transaction is where it is
 *
 * `perform` deliberately opens **no** transaction around the engine call. The
 * flow is a loop — core-service → Flowable → core-service — and a transaction
 * held open across that HTTP call would still be holding its connection when
 * the callback arrives wanting one of its own to write the same row. Under any
 * real load that is a pool deadlock, and it surfaces as an unexplained timeout
 * rather than as an error anybody can act on.
 *
 * So: check, release, call. All the writing happens in `applyCallback`, which
 * is a separate request with a transaction of its own.
 */
@Injectable()
export class WorkflowRuntimeService {
  private readonly logger = new Logger(WorkflowRuntimeService.name);

  constructor(
    private readonly definitions: WorkflowRepository,
    private readonly instances: WorkflowInstanceRepository,
    private readonly flowable: FlowableClient,
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Starts a request on its type's published workflow.
   *
   * Called at submit for a type whose `workflowMode` is `flowable`. A type
   * with no published version is a configuration error rather than a running
   * failure, so it is named as one.
   */
  async start(request: RequestRow, actor: Principal): Promise<void> {
    const definition = await this.definitions.findPublished(
      request.companyId,
      request.requestTypeId,
    );

    if (!definition?.flowableProcessKey) {
      throw new AppError(
        'WORKFLOW_INVALID',
        'ประเภทคำขอนี้ตั้งค่าให้ใช้ผังงาน แต่ยังไม่มีผังงานที่เผยแพร่',
        [{ field: 'request_type_id', reason: request.requestTypeId }],
      );
    }

    const start = await this.prisma.workflowState.findFirst({
      where: { definitionId: definition.id, isStart: true },
    });

    if (!start) {
      throw new AppError('WORKFLOW_INVALID', 'ผังงานนี้ไม่มีสถานะเริ่มต้น');
    }

    const processInstanceId = await this.flowable.startProcess(
      definition.flowableProcessKey,
      request.id,
      {
        requestId: request.id,
        companyId: request.companyId,
        actorUserId: actor.userId,
        ...(request.formData as Record<string, unknown>),
      },
    );

    await this.instances.create({
      data: {
        requestId: request.id,
        definitionId: definition.id,
        flowableProcessInstanceId: processInstanceId,
        currentStateKey: start.key,
      },
    });
  }

  /**
   * Presses a button.
   *
   * Returns nothing: what the request looks like afterwards is whatever the
   * callback wrote, and the caller re-reads it. Making this return a status
   * would mean guessing at the engine's answer before it had given one.
   */
  async perform(
    request: RequestRow,
    actionKey: string,
    payload: Record<string, unknown>,
    actor: Principal,
  ): Promise<void> {
    const instance = await this.instances.findByRequest(request.id);

    if (!instance) {
      throw new AppError('WORKFLOW_INVALID', 'คำขอนี้ยังไม่ได้อยู่ในผังงาน', [
        { field: 'request_id', reason: request.id },
      ]);
    }

    const action = await this.prisma.workflowAction.findFirst({
      where: {
        definitionId: instance.definitionId,
        fromStateKey: instance.currentStateKey,
        actionKey,
      },
      include: { dataMaps: true },
    });

    if (!action) {
      throw new AppError(
        'REQ_STATE_INVALID',
        'ปุ่มนี้กดไม่ได้ในสถานะปัจจุบัน',
        [
          {
            field: 'action',
            reason: `${instance.currentStateKey} → ${actionKey}`,
          },
        ],
      );
    }

    // The one check the engine must never make. Same function the legacy
    // action list uses, so a workflow cannot hand out access §7.1 would refuse.
    if (!hasAuthority(action.authority as Authority, request, actor)) {
      throw new AppError('FORBIDDEN', 'คุณไม่มีสิทธิ์ทำรายการนี้กับคำขอนี้', [
        { field: 'authority', reason: action.authority },
      ]);
    }

    const task = await this.flowable.openTask(
      instance.flowableProcessInstanceId,
    );

    if (!task) {
      throw new AppError(
        'REQ_STATE_INVALID',
        'ไม่พบงานที่รออยู่ในผังงานของคำขอนี้',
      );
    }

    // `actorUserId` travels as a variable because the engine holds no
    // identities: it is how the callback can say who pressed the button.
    await this.flowable.completeTask(task.id, actionKey, {
      ...mapToVariables(payload, action.dataMaps),
      actorUserId: actor.userId,
    });
  }

  /**
   * Applies what the engine did — the only place a workflow-driven request's
   * status changes.
   *
   * Idempotent by construction as well as by the `Idempotency-Key` the
   * generated BPMN sends: applying the same arrival twice writes the same
   * status and the same state key, and the event is guarded by the instance's
   * own record of where it already is.
   */
  async applyCallback(dto: WorkflowCallbackDto): Promise<{ ok: true }> {
    const instance = await this.instances.findByProcessInstance(
      dto.process_instance_id,
    );

    if (!instance) {
      // Not an error worth failing the engine's task over — the process exists
      // and this system does not know it, which is a repair job, not a retry.
      this.logger.warn(
        `callback for unknown process instance ${dto.process_instance_id}`,
      );
      return { ok: true };
    }

    /*
      Where the request is going comes from **our own tables**, never from
      asking the engine.

      The callback runs inside the transition — the http task fires after the
      task completes and before the next one is created — so
      `GET /runtime/tasks` at this instant still answers with the state being
      left. Reading it produced a status that lagged one button behind on every
      press: `receive` recorded `waiting → waiting`, and the request sat in the
      wrong state until somebody pressed something else.

      `workflow_actions` already holds the answer, it is what generated the
      sequence flow the engine just took, and it needs no round trip.
    */
    const action = await this.prisma.workflowAction.findFirst({
      where: {
        definitionId: instance.definitionId,
        fromStateKey: dto.state_key,
        actionKey: clean(dto.action) ?? '',
      },
      include: { dataMaps: true },
    });

    if (!action) {
      this.logger.warn(
        `callback for unknown action ${dto.state_key} → ${dto.action}`,
      );
      return { ok: true };
    }

    const target = await this.prisma.workflowState.findFirst({
      where: { definitionId: instance.definitionId, key: action.toStateKey },
    });

    if (!target) {
      this.logger.warn(`callback aims at unknown state ${action.toStateKey}`);
      return { ok: true };
    }

    const actorId = clean(dto.actor_user_id);

    await this.prisma.$transaction(async (tx) => {
      const before = await tx.request.findUniqueOrThrow({
        where: { id: instance.requestId },
      });

      const columns = await writeBack(tx, before, action.dataMaps);

      await tx.request.update({
        where: { id: instance.requestId },
        data: {
          // The §7.1 phase, which is what SLA, the reports and every screen
          // read. `workflowStateKey` only names the step more precisely.
          status: target.phase,
          workflowStateKey: target.key,
          ...columns,
        },
      });

      await tx.workflowInstance.update({
        where: { id: instance.id },
        data: {
          currentStateKey: target.key,
          /*
            Not stored: at this moment the next task does not exist yet, so
            anything written here would be the id of the task just completed.
            `perform` asks the engine for the open task when it needs one,
            which is the only moment the answer is reliable.
          */
          currentTaskId: null,
          finishedAt: target.kind === 'end' ? new Date() : null,
        },
      });

      const seq = await tx.requestEvent.count({
        where: { requestId: instance.requestId },
      });

      await tx.requestEvent.create({
        data: {
          requestId: instance.requestId,
          seq: seq + 1,
          type: `workflow.${clean(dto.action) ?? 'transition'}`,
          actorId,
          actorLabel: actorId ? null : 'workflow',
          fromStatus: before.status,
          toStatus: target.phase,
          data: {
            fromStateKey: dto.state_key,
            toStateKey: target.key,
          },
        },
      });

      await this.audit.record(
        {
          eventType: 'workflow.transition',
          companyId: before.companyId,
          actorId,
          resourceType: 'request',
          resourceId: instance.requestId,
          before: { status: before.status, stateKey: dto.state_key },
          after: { status: target.phase, stateKey: target.key },
        },
        { prisma: tx },
      );
    });

    return { ok: true };
  }
}

/** Flowable sends the literal `"null"` for a variable it does not have. */
function clean(value: string | undefined): string | undefined {
  return !value || value === ENGINE_NULL ? undefined : value;
}

/** Renames the form's answers to the variable names the workflow expects. */
function mapToVariables(
  payload: Record<string, unknown>,
  dataMaps: readonly { sourceField: string; variableName: string }[],
): Record<string, unknown> {
  if (!dataMaps.length) return payload;

  return Object.fromEntries(
    dataMaps
      .filter((map) => map.sourceField in payload)
      .map((map) => [map.variableName, payload[map.sourceField]]),
  );
}

/**
 * Merges the workflow's variables back into the columns the data flow names.
 *
 * `WRITABLE_TARGET_COLUMNS` is re-checked here even though publish already
 * enforced it. A definition published before a column was removed from the
 * allow-list would otherwise keep writing to it — and the whole reason the
 * list exists is that `status`, `requestNo` and `requesterId` must never be
 * reachable from a form field.
 */
async function writeBack(
  tx: Prisma.TransactionClient,
  before: RequestRow,
  dataMaps: readonly {
    sourceField: string;
    variableName: string;
    targetColumn: string;
  }[],
): Promise<
  Partial<Record<'formData' | 'receiverFormData', Prisma.InputJsonValue>>
> {
  const allowed = dataMaps.filter((map) =>
    WRITABLE_TARGET_COLUMNS.includes(map.targetColumn),
  );

  if (!allowed.length) return {};

  const current = {
    form_data: { ...(before.formData as Record<string, unknown>) },
    receiver_form_data: {
      ...(before.receiverFormData as Record<string, unknown>),
    },
  };

  // The engine holds the authoritative copy of the variables; reading them
  // here rather than trusting the callback body keeps the write honest even if
  // the body were tampered with.
  const variables = await tx.workflowInstance
    .findUnique({
      where: { requestId: before.id },
      select: { variables: true },
    })
    .then((row) => (row?.variables ?? {}) as Record<string, unknown>);

  for (const map of allowed) {
    if (!(map.variableName in variables)) continue;
    const bucket = current[map.targetColumn as keyof typeof current];
    bucket[map.sourceField] = variables[map.variableName];
  }

  return {
    formData: current.form_data as Prisma.InputJsonValue,
    receiverFormData: current.receiver_form_data as Prisma.InputJsonValue,
  };
}
