import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Prisma } from '@prisma/client';
import {
  answersOf,
  nextForward,
  stepOf,
  type Flow,
  type FlowStep,
} from '../requests/request-flow';
import { nextRequestEventSeq } from '../requests/request-event-seq';
import {
  holderOf,
  roleOf,
  scopeOf,
  statusOnEntry,
  v2Milestones,
  type MilestoneFacts,
  type V2Milestone,
} from '../requests/request-flow-v2';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import {
  RequestFlowRepository,
  toFlow,
  type FlowVersionRow,
} from './request-flow.repository';

export type StepOutcome =
  'forward' | 'backward' | 'completed' | 'cancelled' | 'rejected';

/** The request columns the v2 runtime reads to place a holder. */
export interface V2Request {
  readonly id: string;
  readonly requesterId: string;
  readonly receiverUserId: string | null;
  readonly assigneeUserId: string | null;
  readonly stepHolderUserId: string | null;
  readonly completedAt: Date | null;
  readonly requestNo: string | null;
}

const V2_REQUEST_SELECT = {
  id: true,
  requesterId: true,
  receiverUserId: true,
  assigneeUserId: true,
  stepHolderUserId: true,
  completedAt: true,
  requestNo: true,
  flowVersionId: true,
  currentStepCode: true,
  formData: true,
  stepFormData: true,
} as const;

interface StepHolder {
  readonly id: string;
  readonly requesterId: string;
}

/**
 * Moves a request between the steps of its pinned flow. Shared by requests
 * and approvals so a step's exit approval can land the request on its next step.
 */
@Injectable()
export class RequestFlowService {
  constructor(
    private readonly flows: RequestFlowRepository,
    private readonly domainEvents: DomainEventsService,
  ) {}

  latestFor(
    companyId: string,
    requestTypeId: string,
  ): Promise<FlowVersionRow | null> {
    return this.flows.findLatest(companyId, requestTypeId);
  }

  async load(
    flowVersionId: string,
    prisma?: Prisma.TransactionClient,
  ): Promise<Flow> {
    const row = await this.flows.findVersion(flowVersionId, { prisma });
    if (!row) {
      throw new AppError('REQ_STEP_INVALID', 'ไม่พบ flow ที่คำขอนี้ผูกไว้');
    }
    return toFlow(row);
  }

  /** Puts the request on `step`: assignee rule, step run and timeline entry. */
  async enter(
    prisma: Prisma.TransactionClient,
    request: StepHolder,
    step: FlowStep,
    actor: Principal,
  ): Promise<void> {
    const rule = step.assigneeRule;
    const assignee =
      rule?.type === 'requester'
        ? { assigneeUserId: request.requesterId }
        : rule?.type === 'user'
          ? { assigneeUserId: rule.userId }
          : {};

    await prisma.request.update({
      where: { id: request.id },
      data: {
        currentStepCode: step.code,
        ...assignee,
        updatedBy: actor.userId,
      },
    });
    await prisma.requestStepRun.create({
      data: {
        requestId: request.id,
        stepCode: step.code,
        enteredBy: actor.userId,
      },
    });
    await this.recordStepEvent(
      prisma,
      request.id,
      'request.step.entered',
      actor,
      {
        step: step.code,
        name: step.name,
      },
    );
  }

  async leave(
    prisma: Prisma.TransactionClient,
    requestId: string,
    stepCode: string,
    outcome: StepOutcome,
    actor: Principal,
  ): Promise<void> {
    await prisma.requestStepRun.updateMany({
      where: { requestId, stepCode, leftAt: null },
      data: { leftAt: new Date(), outcome },
    });
    await this.recordStepEvent(prisma, requestId, 'request.step.left', actor, {
      step: stepCode,
      outcome,
    });
  }

  async move(
    prisma: Prisma.TransactionClient,
    request: StepHolder,
    flow: Flow,
    fromCode: string,
    toCode: string,
    outcome: 'forward' | 'backward',
    actor: Principal,
  ): Promise<void> {
    await this.leave(prisma, request.id, fromCode, outcome, actor);
    await this.enter(prisma, request, stepOf(flow, toCode), actor);
  }

  /** After a step's exit approval: moves on to the step the answers lead to. */
  async advanceAfterApproval(
    prisma: Prisma.TransactionClient,
    requestId: string,
    actor: Principal,
  ): Promise<void> {
    const request = await prisma.request.findUniqueOrThrow({
      where: { id: requestId },
      select: {
        id: true,
        requesterId: true,
        flowVersionId: true,
        currentStepCode: true,
        formData: true,
        stepFormData: true,
      },
    });
    if (!request.flowVersionId || !request.currentStepCode) {
      throw new AppError('REQ_STEP_INVALID', 'คำขอนี้ไม่ได้อยู่ในขั้นตอนใด');
    }

    const flow = await this.load(request.flowVersionId, prisma);
    const next = nextForward(
      flow,
      request.currentStepCode,
      answersOf(request.formData, request.stepFormData),
    );
    if (!next) {
      throw new AppError('REQ_STEP_INVALID', 'ขั้นนี้ไม่มีขั้นถัดไป');
    }

    await this.move(
      prisma,
      request,
      flow,
      request.currentStepCode,
      next,
      'forward',
      actor,
    );
  }

  /** 1 or 2 for a request on a flow; null for one on the fixed lifecycle. */
  async schemaVersionOf(
    prisma: Prisma.TransactionClient,
    requestId: string,
  ): Promise<number | null> {
    const row = await prisma.request.findUnique({
      where: { id: requestId },
      select: { flowVersion: { select: { schemaVersion: true } } },
    });
    return row?.flowVersion?.schemaVersion ?? null;
  }

  /**
   * v2: puts the request on `step` — its status becomes the step's scope and
   * the holder follows the scope. Returns the step when its approval case must
   * be opened after commit.
   */
  async enterV2(
    prisma: Prisma.TransactionClient,
    request: V2Request,
    step: FlowStep,
    actor: Principal,
  ): Promise<FlowStep | null> {
    const scope = scopeOf(step);
    const data: Prisma.RequestUncheckedUpdateInput = {
      currentStepCode: step.code,
      status: statusOnEntry(scope, Boolean(request.requestNo)),
      updatedBy: actor.userId,
    };

    if (roleOf(scope) === 'requester') data.stepHolderUserId = null;
    if (scope === 'submitted') {
      data.receiverUserId = await this.personFor(
        prisma,
        request,
        step,
        request.receiverUserId,
      );
      data.assigneeUserId = null;
    }
    if (scope === 'in_progress') {
      data.assigneeUserId = await this.personFor(
        prisma,
        request,
        step,
        request.assigneeUserId ?? request.receiverUserId,
      );
    }
    if (scope === 'approved' && !request.completedAt)
      data.completedAt = new Date();

    await prisma.request.update({ where: { id: request.id }, data });
    await prisma.requestStepRun.create({
      data: {
        requestId: request.id,
        stepCode: step.code,
        enteredBy: actor.userId,
      },
    });
    await this.recordStepEvent(
      prisma,
      request.id,
      'request.step.entered',
      actor,
      {
        step: step.code,
        name: step.name,
        scope,
      },
    );

    return scope === 'pending_approval' ? step : null;
  }

  /** v2: closes the stay, recording who held the step for a later "same person" rule. */
  async leaveV2(
    prisma: Prisma.TransactionClient,
    request: V2Request,
    step: FlowStep,
    outcome: StepOutcome,
    actor: Principal,
  ): Promise<void> {
    await prisma.requestStepRun.updateMany({
      where: { requestId: request.id, stepCode: step.code, leftAt: null },
      data: {
        leftAt: new Date(),
        outcome,
        heldBy: holderOf(scopeOf(step), request),
      },
    });
    await this.recordStepEvent(prisma, request.id, 'request.step.left', actor, {
      step: step.code,
      // The timeline prints "จบขั้น: <name>" — the code alone means nothing to a reader.
      name: step.name,
      outcome,
    });
  }

  async moveV2(
    prisma: Prisma.TransactionClient,
    request: V2Request,
    flow: Flow,
    fromCode: string,
    toCode: string,
    outcome: 'forward' | 'backward',
    actor: Principal,
  ): Promise<FlowStep | null> {
    await this.leaveV2(prisma, request, stepOf(flow, fromCode), outcome, actor);
    return this.enterV2(prisma, request, stepOf(flow, toCode), actor);
  }

  /** v2: leaving the last step ends the request. */
  async finishV2(
    prisma: Prisma.TransactionClient,
    request: V2Request,
    step: FlowStep,
    actor: Principal,
  ): Promise<void> {
    await this.leaveV2(prisma, request, step, 'completed', actor);
    const now = new Date();
    await prisma.request.update({
      where: { id: request.id },
      data: {
        status: 'closed',
        closedAt: now,
        completedAt: request.completedAt ?? now,
        updatedBy: actor.userId,
      },
    });
  }

  /**
   * v2: where an approval step's decision sends the work — approve along its
   * forward exit, return to `returnToStepCode`, reject ends it. Returns the next
   * approval step whose case must be opened after commit.
   */
  async afterDecisionV2(
    prisma: Prisma.TransactionClient,
    requestId: string,
    decision: 'approve' | 'reject' | 'return',
    actor: Principal,
  ): Promise<FlowStep | null> {
    const request = await prisma.request.findUniqueOrThrow({
      where: { id: requestId },
      select: V2_REQUEST_SELECT,
    });
    if (!request.flowVersionId || !request.currentStepCode) {
      throw new AppError('REQ_STEP_INVALID', 'คำขอนี้ไม่ได้อยู่ในขั้นตอนใด');
    }
    const flow = await this.load(request.flowVersionId, prisma);
    const current = stepOf(flow, request.currentStepCode);

    if (decision === 'reject') {
      await this.leaveV2(prisma, request, current, 'rejected', actor);
      return null;
    }

    const target =
      decision === 'approve'
        ? nextForward(
            flow,
            current.code,
            answersOf(request.formData, request.stepFormData),
          )
        : (current.returnToStepCode ?? null);
    if (!target) {
      throw new AppError('REQ_STEP_INVALID', 'ขั้นอนุมัตินี้ไม่มีขั้นถัดไป');
    }

    return this.moveV2(
      prisma,
      request,
      flow,
      current.code,
      target,
      decision === 'approve' ? 'forward' : 'backward',
      actor,
    );
  }

  /** After commit: the v1 domain events a v2 move crossed, for CRM and other listeners. */
  async announceV2(requestId: string, from: MilestoneFacts): Promise<void> {
    const request = await this.flows.findRequestFacts(requestId);
    if (!request) return;

    // Every move lands on a step; consumers key on the code, so a repeat is harmless.
    if (request.currentStepCode && request.status !== 'closed') {
      await this.domainEvents.emit({
        name: DOMAIN_EVENTS.requestStepEntered,
        payload: {
          company_id: request.companyId,
          request_id: request.id,
          request_no: request.requestNo,
          type_code: request.typeCode,
          step_code: request.currentStepCode,
          status: request.status,
        },
      });
    }

    for (const milestone of v2Milestones(from, request)) {
      await this.domainEvents.emit({
        name: MILESTONE_EVENTS[milestone],
        payload: {
          company_id: request.companyId,
          request_id: request.id,
          request_no: request.requestNo,
          type_code: request.typeCode,
          requester_id: request.requesterId,
        },
      });
    }
  }

  /** The person a step's receiver rule names, falling back to `current`. */
  private async personFor(
    prisma: Prisma.TransactionClient,
    request: V2Request,
    step: FlowStep,
    current: string | null,
  ): Promise<string | null> {
    const rule = step.receiverRule;
    if (!rule || rule.type === 'keep') return current;
    if (rule.type === 'user') return rule.userId;
    if (rule.type === 'receiver') return request.receiverUserId ?? current;

    const last = await prisma.requestStepRun.findFirst({
      where: {
        requestId: request.id,
        stepCode: rule.stepCode,
        heldBy: { not: null },
      },
      orderBy: { enteredAt: 'desc' },
      select: { heldBy: true },
    });
    return last?.heldBy ?? current;
  }

  private async recordStepEvent(
    prisma: Prisma.TransactionClient,
    requestId: string,
    type: string,
    actor: Principal,
    data: Prisma.InputJsonValue,
  ): Promise<void> {
    await prisma.requestEvent.create({
      data: {
        requestId,
        seq: await nextRequestEventSeq(prisma, requestId),
        type,
        actorId: actor.isServiceAccount ? null : actor.userId,
        actorLabel: actor.displayName || actor.username,
        data,
      },
    });
  }
}

const MILESTONE_EVENTS = {
  preApproved: DOMAIN_EVENTS.requestPreApproved,
  completed: DOMAIN_EVENTS.requestCompleted,
  approved: DOMAIN_EVENTS.requestApproved,
} as const satisfies Record<V2Milestone, string>;
