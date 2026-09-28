import { Injectable } from '@nestjs/common';
import {
  accessSubject,
  AppError,
  auditActor,
  AuditWriter,
  awaitingDecisionWhere,
  decidableStepWhere,
  PrismaTransactionService,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { PageQueryDto, Principal } from '@request-management/share';
import { Prisma } from '@prisma/client';
import type { ApprovalMatrix, RequestStatus } from '@prisma/client';
import { ResolvedApprover, assertStepOneResolvable } from './approval-chain';
import { snapshotHash } from './snapshot';
import { assertTransition } from '../requests/request-state-machine';
import { evaluateCondition } from '../requests/request-flow';
import { nextRequestEventSeq } from '../requests/request-event-seq';
import { RequestFlowService } from '../request-flow/request-flow.service';
import { SlaService } from '../sla/sla.service';
import { answersOf, stepOf } from '../requests/request-flow';
import { scopeOf } from '../requests/request-flow-v2';
import { ApprovalMatrixService } from './approval-matrix.service';
import { AccessService, type MatrixLevel } from '../access/access.service';
import type { Delegation } from '@prisma/client';
import {
  ApprovalCaseRepository,
  CaseWithSteps,
} from './approval-case.repository';

/**
 * A case loaded for a decision, with the request facts a scope grant is
 * matched against.
 *
 * Narrower than joining the request whole, and separate from
 * {@link CaseWithSteps} so that the many places loading a case without a
 * decision in mind are not made to pay for the join.
 */
type CaseForDecision = CaseWithSteps & {
  request: {
    requesterId: string;
    receiverUserId: string | null;
    assigneeUserId: string | null;
    requesterOrgUnitId: string | null;
    receiverOrgUnitId: string | null;
  } | null;
};
import { DelegationRepository } from './delegation.repository';
import {
  ApprovalContext,
  ApprovalContextClient,
} from '../principal/approval-context.client';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS, type DomainEvent } from '../events/event-catalog';
import {
  BatchDecideDto,
  DecideDto,
  OpenCaseDto,
  PreviewChainDto,
} from './dto/approval.dto';

/**
 * The route a request would take, computed before it exists (§16 หน้าที่ 3).
 *
 * Amounts stay decimal strings all the way to the screen: they are money, and
 * turning them into JavaScript numbers here is how a rounded ceiling starts
 * disagreeing with the one the engine actually routed under.
 */
export interface ChainPreview {
  amount: string | null;
  currency: string;
  steps: {
    step_no: number;
    /** What the ladder said — a position, `named`, `supervisor:N`, or `org`. */
    position: string;
    /** `null` when the chart has nobody to fill this step. */
    user_id: string | null;
    display_name: string | null;
    /** Everyone who could decide it; any one of them is enough. */
    candidate_user_ids: string[];
  }[];
}

/** One outcome inside a batch — APV-04 reports each case separately. */
export interface BatchResult {
  case_id: string;
  ok: boolean;
  status?: string;
  error?: { code: string; message: string };
}

/** Consecutive all-skipped approval steps one decision may pass through. */
const MAX_AUTO_HOPS = 20;

@Injectable()
export class ApprovalsService {
  constructor(
    private readonly cases: ApprovalCaseRepository,
    private readonly delegations: DelegationRepository,
    private readonly matrix: ApprovalMatrixService,
    private readonly access: AccessService,
    private readonly context: ApprovalContextClient,
    private readonly notifications: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly flows: RequestFlowService,
    private readonly sla: SlaService,
  ) {}

  // --- APV-02 / APV-07: opening a case ------------------------------------

  /**
   * Computes the chain and opens the case, atomically.
   *
   * The caller never names approvers — §8.1 is explicit that the system
   * derives them, so a requester cannot route around an expensive approver.
   * The case and all of its steps are written in one transaction: a case with
   * a missing step would sit in the inbox of nobody at all.
   */
  async openCase(
    dto: OpenCaseDto,
    actor: Principal,
    authorization: string,
  ): Promise<CaseWithSteps> {
    const requesterId = dto.requester_user_id ?? actor.userId;
    const companyId = actor.activeCompanyId;

    const { matrix, chain } = await this.planChain({
      subjectType: dto.subject_type,
      amount: dto.amount ?? null,
      requesterId,
      chartOwnerId: dto.chart_owner_user_id ?? null,
      companyId,
      authorization,
      answers: dto.payload ?? {},
    });

    assertStepOneResolvable(chain);

    return this.persistCase(dto, actor, chain, {
      requesterId,
      companyId,
      matrixId: matrix.id,
      matrixVersion: matrix.version,
      currency: dto.currency ?? matrix.currency,
    });
  }

  /**
   * Opens a case from a ladder a v2 flow step carries, not a published matrix,
   * so the request keeps the ladder it was created under.
   */
  async openCaseWithLevels(
    input: {
      subjectType: string;
      subjectId: string;
      requesterId: string;
      workerId: string | null;
      levels: readonly MatrixLevel[];
      payload: Record<string, unknown>;
      requestId?: string;
    },
    actor: Principal,
  ): Promise<CaseWithSteps> {
    const companyId = actor.activeCompanyId;
    // The chart is read from this database, so a decision (which has no token) can open the next case.
    const requesterUnit = await this.access.orgUnitIdOf(
      input.requesterId,
      companyId,
    );
    const workerUnit = input.workerId
      ? await this.access.orgUnitIdOf(input.workerId, companyId)
      : requesterUnit;

    const chain = await this.resolveLevels(
      input.levels,
      {
        requesterId: input.requesterId,
        orgUnitId: requesterUnit,
        orgUnitFor: (level) =>
          level.chartOf === 'worker' ? workerUnit : requesterUnit,
      },
      { answers: input.payload },
    );
    assertStepOneResolvable(chain);

    return this.persistCase(
      {
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        payload: input.payload,
      },
      actor,
      chain,
      {
        requesterId: input.requesterId,
        companyId,
        matrixId: null,
        matrixVersion: null,
        currency: null,
        requestId: input.requestId,
      },
    );
  }

  /**
   * v2: opens the case of the approval step the request stands on. A ladder
   * whose every level is skipped approves at once, so the work moves on — which
   * may land on another approval step, hence the loop.
   */
  async openStepCaseV2(requestId: string, actor: Principal): Promise<void> {
    for (let hop = 0; hop < MAX_AUTO_HOPS; hop += 1) {
      const request = await this.transactions.execute((prisma) =>
        prisma.request.findUniqueOrThrow({
          where: { id: requestId },
          select: {
            id: true,
            requestNo: true,
            typeCode: true,
            requesterId: true,
            receiverUserId: true,
            assigneeUserId: true,
            flowVersionId: true,
            currentStepCode: true,
            formData: true,
            stepFormData: true,
          },
        }),
      );
      if (!request.flowVersionId || !request.currentStepCode) return;

      const flow = await this.flows.load(request.flowVersionId);
      const step = stepOf(flow, request.currentStepCode);
      if (scopeOf(step) !== 'pending_approval') return;

      const opened = await this.openCaseWithLevels(
        {
          subjectType: `request:${request.typeCode}:step:${step.code}`,
          subjectId: request.requestNo ?? request.id,
          requesterId: request.requesterId,
          workerId: request.assigneeUserId ?? request.receiverUserId,
          // Checked by `assertValidLevels` when the flow was published.
          levels: step.approvalLevels as MatrixLevel[],
          payload: answersOf(request.formData, request.stepFormData),
          requestId,
        },
        actor,
      );
      if (opened.status === 'pending') return;

      const next = await this.transactions.execute((prisma) =>
        this.flows.afterDecisionV2(prisma, requestId, 'approve', actor),
      );
      if (!next) return;
    }
  }

  /** Writes the case and its steps in one transaction, then announces the first step. */
  private async persistCase(
    dto: Pick<
      OpenCaseDto,
      'subject_type' | 'subject_id' | 'payload' | 'amount' | 'callback_event'
    >,
    actor: Principal,
    chain: readonly ResolvedApprover[],
    meta: {
      requesterId: string;
      companyId: string;
      matrixId: string | null;
      matrixVersion: number | null;
      currency: string | null;
      /** Set up front for a flow step's case, so its first notice links the request. */
      requestId?: string;
    },
  ): Promise<CaseWithSteps> {
    const { requesterId, companyId } = meta;

    const firstAsked = chain.findIndex((step) => !step.skipReason);
    // Every level skipped: the case opens already decided, so nothing waits on anyone.
    const nothingToAsk = firstAsked < 0;

    const opened = await this.transactions.execute(async (prisma) => {
      const created = await prisma.approvalCase.create({
        data: {
          companyId,
          subjectType: dto.subject_type,
          subjectId: dto.subject_id,
          amount: dto.amount ?? null,
          currency: meta.currency,
          snapshotHash: snapshotHash(dto.payload ?? {}),
          matrixId: meta.matrixId,
          matrixVersion: meta.matrixVersion,
          requestId: meta.requestId ?? null,
          callbackEvent: dto.callback_event ?? null,
          payload: (dto.payload ?? {}) as Prisma.InputJsonValue,
          createdBy: requesterId,
          currentStep: nothingToAsk ? chain.length : firstAsked + 1,
          ...(nothingToAsk
            ? { status: 'approved' as const, decidedAt: new Date() }
            : {}),
          steps: {
            create: chain.map((step, index) => ({
              stepNo: index + 1,
              approverRole: step.position,
              approverUserId: step.userId,
              candidateUserIds: [...step.candidateUserIds],
              mode: step.mode ?? 'any',
              noteRequired: step.noteRequired ?? 'always',
              slaHours: step.slaHours ?? null,
              skipReason: step.skipReason ?? null,
              // Only the first asked step is actionable; the rest wait their
              // turn, which is what stops the ladder being skipped.
              status: step.skipReason
                ? 'skipped'
                : index === firstAsked
                  ? 'pending'
                  : 'waiting',
            })),
          },
        },
        include: { steps: { orderBy: { stepNo: 'asc' } } },
      });

      await this.audit.record(
        {
          eventType: 'approval.case.opened',
          companyId,
          ...auditActor(actor),
          resourceType: 'approval_case',
          resourceId: created.id,
          after: {
            subjectType: dto.subject_type,
            subjectId: dto.subject_id,
            amount: dto.amount ?? null,
            matrixVersion: meta.matrixVersion,
            chain: chain.map((step) => step.position),
          },
        },
        { prisma },
      );

      const asked = created.steps.find(
        (step) => step.stepNo === created.currentStep,
      );
      if (created.status === 'pending' && asked?.slaHours) {
        const dueAt = await this.stepDueAt(prisma, created, asked.slaHours);
        asked.dueAt = dueAt;
        await prisma.approvalStep.update({
          where: { id: asked.id },
          data: { dueAt },
        });
      }

      return created;
    });

    if (opened.status !== 'pending') return opened;

    await this.notifications.awaitingApproval(opened, companyId);

    // §11.8 — "you have work waiting" is triggered by this, not by the
    // notification call above: other consumers need the same signal.
    await this.domainEvents.emit({
      name: DOMAIN_EVENTS.approvalStepPending,
      payload: {
        company_id: companyId,
        case_id: opened.id,
        request_id: opened.requestId,
        step: opened.currentStep,
        approver_id:
          opened.steps.find((step) => step.stepNo === opened.currentStep)
            ?.approverUserId ?? null,
      },
    });

    return opened;
  }

  /**
   * Works out which tier applies and who the approvers would be.
   *
   * Shared by `openCase` and `previewChain` on purpose: §16 หน้าที่ 3 shows the
   * user the route *before* they submit, and a preview computed by a second
   * copy of this logic would start disagreeing with the real routing the
   * moment a ceiling changed — which is exactly the promise the screen makes.
   */
  private async planChain(input: {
    subjectType: string;
    amount: string | null;
    requesterId: string;
    /** Whose chart a supervisor level climbs. Defaults to the requester. */
    chartOwnerId?: string | null;
    companyId: string;
    authorization: string;
    /** Preview only — see `resolveLevels`. */
    keepUnresolved?: boolean;
    /** The request's answers, for level conditions; absent treats every level as applying. */
    answers?: Readonly<Record<string, unknown>>;
  }): Promise<{
    matrix: ApprovalMatrix;
    chain: ResolvedApprover[];
    context: ApprovalContext;
  }> {
    const matrix = await this.matrix.requireEffective(
      input.companyId,
      input.subjectType,
      new Date(),
    );

    /*
      Two people, deliberately.

      The **chart owner** decides which org unit a `หัวหน้าทีม` level counts up
      from — before the work that is the requester, after it the person who
      carried the ticket. The **requester** is who APV-02 removes from every
      level. They were the same value until 1 ก.ย. 2569, which is why approval
      of Marketing's work was routing through Sales' managers.
    */
    const context = await this.context.resolve(
      input.authorization,
      input.chartOwnerId ?? input.requesterId,
      input.companyId,
    );

    const levels = matrix.levels as unknown as MatrixLevel[] | null;

    /*
      A ladder with no levels cannot route anything. `assertValidLevels`
      refuses to publish one, so this only happens to a version written before
      31 Aug 2026 — and those were deleted (`yarn matrix:clear-legacy`). Said
      as a named failure rather than an empty chain, because an empty chain
      would look like "no approval needed" and let the request through.
    */
    if (!levels?.length) {
      throw new AppError(
        'APV_MATRIX_NOT_FOUND',
        'ตารางอำนาจอนุมัติของประเภทงานนี้เป็นรูปแบบเก่า — ประกาศเวอร์ชันใหม่ที่หน้าตารางอำนาจอนุมัติ',
        [{ field: 'subject_type', reason: input.subjectType }],
      );
    }

    const chain = await this.resolveLevels(
      levels,
      {
        requesterId: input.requesterId,
        orgUnitId: context.orgUnitId ?? null,
      },
      { keepUnresolved: input.keepUnresolved ?? false, answers: input.answers },
    );

    return { matrix, chain, context };
  }

  /**
   * Turns each level into the people who may decide it.
   *
   * A level nobody fills is **dropped**, not left empty: that is how the
   * self-approval rule has always behaved for a named office, and a step with
   * no possible approver would stall the case for ever. Step 1 having nobody
   * is the one case that is refused, by `assertStepOneResolvable`.
   *
   * `keepUnresolved` is the preview's exception, and only the preview's.
   * Dropping a level is right when steps are being *written* — a case cannot
   * wait on nobody. It is wrong when the ladder is being *shown*: the level is
   * configured, it simply has no holder, and silently omitting it made หน้าที่ 3
   * report a shorter ladder than the one the submit would refuse over. Nothing
   * routes off a preview, so nothing stalls.
   */
  private async resolveLevels(
    levels: readonly MatrixLevel[],
    subject: {
      requesterId: string;
      orgUnitId: string | null;
      /** v2 levels climb the requester's or the worker's chart, per level. */
      orgUnitFor?: (level: MatrixLevel) => string | null;
    },
    options?: {
      readonly keepUnresolved?: boolean;
      readonly answers?: Readonly<Record<string, unknown>>;
    },
  ): Promise<ResolvedApprover[]> {
    const resolved: ResolvedApprover[] = [];
    let previousAsked: string | null = null;

    for (const level of levels) {
      const position =
        level.type === 'supervisor' ? `supervisor:${level.up}` : 'org';
      const rules = {
        mode: level.mode ?? 'any',
        noteRequired: level.noteRequired ?? 'always',
        slaHours: level.slaHours ?? null,
      } as const;

      // A level whose condition does not hold is kept, marked, and never asked.
      if (
        level.condition &&
        options?.answers &&
        !evaluateCondition(level.condition, options.answers)
      ) {
        resolved.push({
          position,
          userId: null,
          candidateUserIds: [],
          ...rules,
          skipReason: 'condition',
        });
        continue;
      }

      const candidates = await this.access.approverCandidatesOf(level, {
        requesterId: subject.requesterId,
        orgUnitId: subject.orgUnitFor?.(level) ?? subject.orgUnitId,
      });

      if (!candidates.length) {
        if (!options?.keepUnresolved) continue;

        resolved.push({
          position,
          userId: null,
          candidateUserIds: [],
          ...rules,
        });
        continue;
      }

      // The same people twice in a row approve once; the repeat is recorded as skipped.
      const who = [...candidates].sort().join(',');
      const skipReason = who === previousAsked ? 'same_approver' : null;
      if (!skipReason) previousAsked = who;

      resolved.push({
        position,
        userId: candidates[0],
        candidateUserIds: candidates,
        ...rules,
        skipReason,
      });
    }

    return resolved;
  }

  /**
   * APV-02 preview: the route this request *would* take, without opening a
   * case (§16 หน้าที่ 3, "เส้นทางอนุมัติที่จะใช้").
   *
   * Nothing is written and no notification is sent — the screen recalculates
   * on every change to the amount. `assertStepOneResolvable` is deliberately
   * **not** called: a requester with no supervisor should see *why* they
   * cannot submit rather than a bare error, so the missing step is reported as
   * data (`user_id: null`) and the submit itself is what refuses. That promise
   * is kept by `keepUnresolved` below; for a long time the comment made it and
   * `resolveLevels` quietly dropped the step instead.
   *
   * `chart_owner_user_id` says whose chart a supervisor level climbs. Omitted,
   * it is the caller — right for the before-work ladder, and wrong for the one
   * that reviews finished work, which climbs the chart of whoever carries it.
   */
  async previewChain(
    dto: PreviewChainDto,
    actor: Principal,
    authorization: string,
  ): Promise<ChainPreview> {
    const amount = dto.amount ?? null;
    const chartOwnerId = dto.chart_owner_user_id ?? null;

    /*
      Checked here because nothing downstream does. user-service resolves a
      context by user id and ignores the company it was handed, so an id from
      another company would answer with that company's supervisors.
    */
    if (chartOwnerId && chartOwnerId !== actor.userId) {
      await this.access.assertChartOwnerInCompany(
        chartOwnerId,
        actor.activeCompanyId,
      );
    }

    const { chain, context } = await this.planChain({
      subjectType: dto.subject_type,
      amount,
      requesterId: actor.userId,
      chartOwnerId,
      companyId: actor.activeCompanyId,
      authorization,
      keepUnresolved: true,
    });

    /*
      The names, from the same place the ids came from.

      `context.displayNames` covers only what user-service resolved — the
      requester's personal supervisor chain and the role holders. A
      `supervisor:N` level is resolved here instead, off `OrgUnit.managerUserId`,
      and in this chart those are different columns: 80 of 90 users carry no
      `User.supervisorUserId` at all. Every such step arrived with an id and no
      name, and the screen printed the level's storage code — `supervisor:1` —
      where the head of the department belonged.

      Local names win where both answer: the persisted request detail reads the
      `user` table through a relation, and two screens naming the same person
      differently is worse than either name alone.
    */
    const resolved = await this.access.displayNamesOf(
      chain.flatMap((step) => (step.userId ? [step.userId] : [])),
      actor.activeCompanyId,
    );

    return {
      amount,
      currency: dto.currency ?? 'THB',
      steps: chain.map((step, index) => ({
        step_no: index + 1,
        position: step.position,
        user_id: step.userId,
        display_name: step.userId
          ? (resolved.get(step.userId) ??
            context.displayNames[step.userId] ??
            null)
          : null,
        candidate_user_ids: [...step.candidateUserIds],
      })),
    };
  }

  /**
   * Does this subject have a published ladder in this company?
   *
   * The answer decides whether finished work gets checked at all. Eighteen of
   * OSD's forty request types are Pattern C — *"คำขอนี้ไม่มีชั้นอนุมัติ"* — and
   * for them the absence of a matrix **is** the configuration. Treating it as
   * an error would make those types impossible to finish.
   */
  /** The ladder in force for `subjectType`, or null — the flow builder copies it into a step. */
  async effectiveLevels(
    subjectType: string,
    companyId: string,
  ): Promise<unknown[] | null> {
    if (!(await this.matrix.hasEffective(companyId, subjectType, new Date()))) {
      return null;
    }
    const matrix = await this.matrix.requireEffective(
      companyId,
      subjectType,
      new Date(),
    );
    return Array.isArray(matrix.levels) ? matrix.levels : null;
  }

  async hasPublishedMatrix(
    subjectType: string,
    companyId: string,
    _authorization: string,
  ): Promise<boolean> {
    return this.matrix.hasEffective(companyId, subjectType, new Date());
  }

  /** Resolves the chain without writing, so submit can refuse before it issues a number. */
  async assertRoutable(input: {
    subjectType: string;
    requesterId: string;
    chartOwnerId: string | null;
    companyId: string;
    authorization: string;
  }): Promise<void> {
    if (
      !(await this.matrix.hasEffective(
        input.companyId,
        input.subjectType,
        new Date(),
      ))
    ) {
      return;
    }

    const { chain } = await this.planChain({ ...input, amount: null });
    assertStepOneResolvable(chain);
  }

  /** Whether any approval matrix version routes this subject at all. */
  countMatricesFor(subjectType: string): Promise<number> {
    return this.matrix.countForSubject(subjectType);
  }

  // --- APV-02 / APV-03 / APV-05: deciding ---------------------------------

  /**
   * Records one decision.
   *
   * Everything that makes a decision legitimate is checked here rather than
   * trusted from the caller: the case is still open, the step is the current
   * one, and the person deciding is the approver or someone actively
   * delegated by them.
   */
  async decide(
    caseId: string,
    dto: DecideDto,
    actor: Principal,
  ): Promise<CaseWithSteps> {
    /*
      What the request became, captured inside the transaction and announced
      only after it commits (§11.8). An object rather than a `let`: TypeScript
      does not see an assignment made inside the callback and would narrow a
      `let` back to `null` at the emit.
    */
    const outcome: {
      event: DomainEvent | null;
      partial: boolean;
      /** v2: the request just entered another approval step, whose case opens after commit. */
      nextCaseFor: string | null;
    } = {
      event: null,
      partial: false,
      nextCaseFor: null,
    };

    const decided = await this.transactions.execute(async (prisma) => {
      const found = await prisma.approvalCase.findUnique({
        where: { id: caseId },
        include: {
          steps: { orderBy: { stepNo: 'asc' } },
          /*
            The four columns a scope grant is matched against. Selected rather
            than joined whole: this runs on every decision, and the case has no
            other use for the request's payload. `typeCode`/`requestNo` ride
            along for the outcome event.
          */
          request: {
            select: {
              requesterId: true,
              receiverUserId: true,
              assigneeUserId: true,
              requesterOrgUnitId: true,
              receiverOrgUnitId: true,
              typeCode: true,
              requestNo: true,
              status: true,
            },
          },
        },
      });

      if (!found || found.companyId !== actor.activeCompanyId) {
        // SCOPE-03: out of scope answers 404, never 403 — existence is not
        // disclosed across a company boundary.
        throw new AppError('NOT_FOUND', 'ไม่พบรายการอนุมัติที่ระบุ');
      }

      if (found.status !== 'pending') {
        throw new AppError(
          'CONFLICT',
          'รายการนี้ตัดสินไปแล้ว ไม่สามารถเปลี่ยนแปลงได้',
        );
      }

      // A case left open on a request that moved on must not move it back.
      if (found.request && found.request.status !== 'pending_approval') {
        throw new AppError('REQ_STATE_INVALID', 'คำขอนี้ไม่ได้รออนุมัติแล้ว', [
          { field: 'status', reason: found.request.status },
        ]);
      }

      const step = found.steps.find(
        (candidate) => candidate.stepNo === found.currentStep,
      );

      if (!step) {
        throw new AppError('CONFLICT', 'ไม่พบชั้นอนุมัติปัจจุบัน');
      }

      const { delegation, via } = await this.authorise(
        prisma,
        found,
        step,
        actor,
      );

      // Every decision carries a note (H2.2) unless the level lets an approval go without one.
      const noteNeeded =
        step.noteRequired !== 'reject_or_return' || dto.decision !== 'approve';
      if (noteNeeded && !dto.note?.trim()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ต้องระบุคำอธิบายประกอบการตัดสินใจ',
          [{ field: 'note', reason: 'required' }],
        );
      }

      // The candidate this decision counts for: the delegator when acting under a delegation.
      const voter = delegation?.delegatorUserId ?? actor.userId;
      const counted = step.mode === 'all' && via !== 'scope_grant';

      if (counted && dto.decision === 'approve') {
        await this.castVote(prisma, step.id, voter, actor, delegation, dto);
        const tally = await this.tallyOf(prisma, step);
        if (tally.approved < tally.required) {
          outcome.partial = true;
          return this.recordPartialVote(prisma, found, step, actor, tally, dto);
        }
      }

      const nextAsked = found.steps.find(
        (candidate) =>
          candidate.stepNo > found.currentStep &&
          candidate.status !== 'skipped',
      );
      const isLastStep = !nextAsked;
      const nextStatus =
        dto.decision === 'reject'
          ? 'rejected'
          : dto.decision === 'return'
            ? 'returned'
            : isLastStep
              ? 'approved'
              : 'pending';

      // Claims the step: a second decision racing this one matches no row.
      const claimed = await prisma.approvalCase.updateMany({
        where: {
          id: found.id,
          status: 'pending',
          currentStep: found.currentStep,
        },
        data: {
          status: nextStatus,
          currentStep:
            nextStatus === 'pending'
              ? (nextAsked?.stepNo ?? found.currentStep)
              : found.currentStep,
          decidedAt: nextStatus === 'pending' ? null : new Date(),
        },
      });

      if (claimed.count === 0) {
        throw new AppError(
          'CONFLICT',
          'รายการนี้ตัดสินไปแล้ว ไม่สามารถเปลี่ยนแปลงได้',
        );
      }

      await prisma.approvalStep.update({
        where: { id: step.id },
        data: {
          status:
            dto.decision === 'approve'
              ? 'approved'
              : dto.decision === 'reject'
                ? 'rejected'
                : 'returned',
          decision: dto.decision,
          note: dto.note ?? null,
          decidedAt: new Date(),
          // APV-03: both names. `approverUserId` stays the person the chain
          // named; `decidedByUserId` is who actually acted.
          decidedByUserId: actor.userId,
          delegationId: delegation?.id ?? null,
        },
      });

      // Every decision is also a vote, so a step's history reads the same in either mode.
      if (!(counted && dto.decision === 'approve')) {
        await this.castVote(prisma, step.id, voter, actor, delegation, dto);
      }

      const updated = await prisma.approvalCase.findUniqueOrThrow({
        where: { id: found.id },
        include: { steps: { orderBy: { stepNo: 'asc' } } },
      });

      /*
        Carry the decision back to the request, in this same transaction.

        Without this the case reached `approved` and the request stayed at
        `pending_approval` for ever — approved work that no route could close,
        which is the state this whole rework was called in to fix. It is not a
        subscriber for exactly that reason: a case and its request disagreeing
        about whether the work passed is the failure, so they commit together
        or not at all.

        `return` sends the ticket back to `in_progress` — to the team that did
        the work. `returned` would mean back with the requester, which is a
        different place and a different clock.
      */
      if (found.requestId && nextStatus !== 'pending') {
        /*
          Where the request goes depends on **which stage this case is**.

          A pre-work case was approving permission to start, so approval hands
          the ticket to its receiver (`submitted`) and a send-back returns it
          to the requester (`returned`) — nobody has done any work to send it
          back to. After the work, approval accepts the result and a send-back
          goes to the team that produced it.

          Read off the subject rather than stored twice: `request:<CODE>:pre`
          is what routed the case, so it is already the answer.
        */
        const preWork = found.subjectType.endsWith(':pre');
        // A step's exit case (`request:<TYPE>:step:<CODE>`) returns the work to the team.
        const stepExit = found.subjectType.includes(':step:');

        const v2 =
          stepExit &&
          (await this.flows.schemaVersionOf(prisma, found.requestId)) === 2;

        let toStatus: RequestStatus;
        if (v2) {
          // A v2 flow decides where the work goes: the step's own exits.
          if (nextStatus === 'rejected') {
            await prisma.request.update({
              where: { id: found.requestId },
              data: { status: 'rejected', updatedBy: actor.userId },
            });
            await this.sla.stop(prisma, found.requestId, 'met');
          }
          const pendingStep = await this.flows.afterDecisionV2(
            prisma,
            found.requestId,
            dto.decision,
            actor,
          );
          if (pendingStep) outcome.nextCaseFor = found.requestId;
          toStatus = (
            await prisma.request.findUniqueOrThrow({
              where: { id: found.requestId },
              select: { status: true },
            })
          ).status;
        } else {
          toStatus =
            nextStatus === 'approved'
              ? preWork
                ? 'submitted'
                : stepExit
                  ? 'in_progress'
                  : 'approved'
              : nextStatus === 'rejected'
                ? 'rejected'
                : preWork
                  ? 'returned'
                  : 'in_progress';

          assertTransition('pending_approval', toStatus);

          await prisma.request.update({
            where: { id: found.requestId },
            data: { status: toStatus, updatedBy: actor.userId },
          });

          if (stepExit && nextStatus === 'approved') {
            await this.flows.advanceAfterApproval(
              prisma,
              found.requestId,
              actor,
            );
          }

          await this.settleWorkClock(
            prisma,
            found.requestId,
            preWork,
            nextStatus,
          );
        }

        if (
          (toStatus === 'approved' || toStatus === 'rejected') &&
          found.request
        ) {
          outcome.event = {
            name:
              toStatus === 'approved'
                ? DOMAIN_EVENTS.requestApproved
                : DOMAIN_EVENTS.requestRejected,
            payload: {
              company_id: found.companyId,
              request_id: found.requestId,
              request_no: found.request.requestNo,
              type_code: found.request.typeCode,
              requester_id: found.request.requesterId,
            },
          };
        }

        await prisma.requestEvent.create({
          data: {
            requestId: found.requestId,
            seq: await nextRequestEventSeq(prisma, found.requestId),
            type: `request.review.${dto.decision}`,
            actorId: actor.userId,
            fromStatus: 'pending_approval',
            toStatus,
            data: { caseId: found.id, note: dto.note ?? null, via },
          },
        });
      }

      /*
        An intermediate approval is a fact about the request too.

        The block above writes an event only when the case *finishes*, so on a
        two-level ladder the first approver's decision — and the remark H2.2
        makes mandatory — existed solely on `ApprovalStep.note`, which the
        request screen never reads. The timeline then showed one approval where
        two had happened, and the earlier remark was unreachable.

        No `fromStatus`/`toStatus`: the request is still `pending_approval`.
        The step moved, not the ticket.
      */
      if (found.requestId && nextStatus === 'pending') {
        await prisma.requestEvent.create({
          data: {
            requestId: found.requestId,
            seq: await nextRequestEventSeq(prisma, found.requestId),
            type: 'request.review.step',
            actorId: actor.userId,
            data: {
              caseId: found.id,
              stepNo: found.currentStep,
              nextStep: updated.currentStep,
              note: dto.note ?? null,
            },
          },
        });
      }

      // Hand the baton to the next approver in the same transaction.
      if (nextStatus === 'pending') {
        const next = found.steps.find(
          (candidate) => candidate.stepNo === updated.currentStep,
        );
        await prisma.approvalStep.updateMany({
          where: { caseId: found.id, stepNo: updated.currentStep },
          data: {
            status: 'pending',
            dueAt: next?.slaHours
              ? await this.stepDueAt(prisma, found, next.slaHours)
              : null,
          },
        });
      }

      await this.audit.record(
        {
          eventType: `approval.step.${dto.decision}d`,
          companyId: found.companyId,
          ...auditActor(actor),
          resourceType: 'approval_case',
          resourceId: found.id,
          before: { status: found.status, currentStep: found.currentStep },
          after: {
            status: nextStatus,
            stepNo: step.stepNo,
            decision: dto.decision,
            onBehalfOf: delegation ? step.approverUserId : null,
          },
        },
        { prisma },
      );

      return updated;
    });

    // A vote on an `all` step that others still owe changes nothing anyone waits on.
    if (outcome.partial) return decided;

    await this.notifications.decisionMade(
      decided,
      dto.decision,
      dto.note ?? null,
    );

    if (outcome.event) await this.domainEvents.emit(outcome.event);

    if (outcome.nextCaseFor)
      await this.openStepCaseV2(outcome.nextCaseFor, actor);

    return decided;
  }

  /**
   * APV-03: may this person act on this step, and how?
   *
   * A delegation is looked up **now**, not at submit — that is what makes work
   * already sitting in a queue route to whoever is covering.
   *
   * `via` is recorded on the request's timeline: a decision taken through a
   * scope grant is a different fact from one taken by the person the ladder
   * named, and "who approved this, and why were they allowed to" is the first
   * question asked of an approval that turns out to be wrong.
   */
  private async authorise(
    prisma: Prisma.TransactionClient,
    found: CaseForDecision,
    step: CaseWithSteps['steps'][number],
    actor: Principal,
  ): Promise<{
    delegation: Delegation | null;
    via: 'candidate' | 'delegation' | 'scope_grant';
  }> {
    // Checked first: a delegation or grant must not reopen what opening the case filtered out.
    const requesterId = found.request?.requesterId ?? found.createdBy;
    if (requesterId === actor.userId) {
      throw new AppError('APV_SELF_APPROVAL', 'อนุมัติคำขอของตัวเองไม่ได้');
    }

    /*
      Everyone the level named, any one of whom may decide.

      `approverUserId` is only the first of them, and falling back to it covers
      the cases opened before `candidateUserIds` existed — those steps were
      backfilled, but a case opened mid-deploy could still carry an empty array.
    */
    const candidates = step.candidateUserIds.length
      ? step.candidateUserIds
      : step.approverUserId
        ? [step.approverUserId]
        : [];

    if (candidates.includes(actor.userId)) {
      return { delegation: null, via: 'candidate' };
    }

    // APV-03: covering for any one of them is enough, and the history keeps
    // both names — `approverUserId` who was named, `decidedByUserId` who acted.
    let delegation: Delegation | null = null;
    for (const candidate of candidates) {
      delegation = await this.delegations.findActiveFor(
        found.companyId,
        candidate,
        actor.userId,
        new Date(),
        { prisma },
      );
      if (delegation) break;
    }

    if (delegation) return { delegation, via: 'delegation' };

    /*
      A scope grant carrying `approval.decide` (7 ก.ย. 2569) — "ฝ่ายนี้อนุมัติงาน
      ของฝ่ายนั้นได้".

      Asked **last**, and only ever to say yes: a named candidate and a
      delegate are authorised above without this being consulted, so no grant
      can take a step away from the person the ladder routed it to. That is
      what keeps a step from stalling with nobody able to decide it.

      Intersected with the caller's own permissions like every other grant, so
      §5.4 still holds — a role carrying `admin.*` cannot hold
      `approval.decide`, and therefore cannot be handed it by a grant either.
    */
    if (this.scopeMayDecide(found, actor)) {
      return { delegation: null, via: 'scope_grant' };
    }

    throw new AppError('APV_NOT_YOUR_TURN', 'คุณไม่ใช่ผู้อนุมัติของชั้นนี้', [
      { field: 'step_no', reason: String(step.stepNo) },
    ]);
  }

  /**
   * Whether a scope grant lets this person decide this case.
   *
   * Matched against the **request** the case belongs to, using the same four
   * columns every other scope question uses. A case with no request — one
   * opened by an integration for a subject of its own — is reachable by no
   * grant at all: there is nothing to match a group or a person against, and
   * inventing a match would be a grant that widened itself.
   */
  private scopeMayDecide(found: CaseForDecision, actor: Principal): boolean {
    if (!actor.permissions.includes('approval.decide')) return false;

    const reach = actor.scopedByPermission?.['approval.decide'];
    if (!reach) return false;

    const request = found.request;
    if (!request) return false;

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

  // --- APV-04: batch ------------------------------------------------------

  /**
   * Decides several cases, each in its own transaction.
   *
   * Deliberately not one transaction over the batch: an approver acting on
   * twenty cases should not lose nineteen good decisions because the twentieth
   * had already been decided by someone else. Each result is reported
   * separately.
   */
  async batchDecide(
    dto: BatchDecideDto,
    actor: Principal,
  ): Promise<{ results: BatchResult[] }> {
    const results: BatchResult[] = [];

    for (const caseId of dto.case_ids) {
      try {
        const decided = await this.decide(
          caseId,
          { decision: dto.decision, note: dto.note },
          actor,
        );
        results.push({ case_id: caseId, ok: true, status: decided.status });
      } catch (error) {
        const appError =
          error instanceof AppError
            ? error
            : new AppError('UNKNOWN', 'ไม่สามารถดำเนินการได้');

        results.push({
          case_id: caseId,
          ok: false,
          error: { code: appError.code, message: appError.message },
        });
      }
    }

    return { results };
  }

  /**
   * The team's clock after a case closes: a send-back after the work (or out
   * of a step) resumes it, a step approval resumes it, a final outcome stops it.
   */
  private async settleWorkClock(
    prisma: Prisma.TransactionClient,
    requestId: string,
    preWork: boolean,
    outcome: 'approved' | 'rejected' | 'returned' | 'pending',
  ): Promise<void> {
    // Before the work the clock has not started (it runs from the first assignment).
    if (preWork) {
      if (outcome === 'rejected')
        await this.sla.stop(prisma, requestId, 'cancelled');
      return;
    }

    const request = await prisma.request.findUniqueOrThrow({
      where: { id: requestId },
      select: { status: true },
    });
    if (request.status === 'in_progress') {
      await this.sla.resume(prisma, requestId);
      return;
    }
    if (request.status === 'approved' || request.status === 'rejected') {
      await this.sla.stop(prisma, requestId, 'met');
    }
  }

  /** The step's own deadline, on the calendar of the request type it routes. */
  private stepDueAt(
    prisma: Prisma.TransactionClient,
    approvalCase: { companyId: string; subjectType: string },
    hours: number,
  ): Promise<Date | null> {
    const typeCode =
      /^request:([^:]+)/.exec(approvalCase.subjectType)?.[1] ?? null;
    return this.sla.dueAfter(prisma, approvalCase.companyId, typeCode, hours);
  }

  /** One candidate's vote; a second vote by the same candidate is a conflict, not an overwrite. */
  private async castVote(
    prisma: Prisma.TransactionClient,
    stepId: string,
    voter: string,
    actor: Principal,
    delegation: Delegation | null,
    dto: DecideDto,
  ): Promise<void> {
    try {
      await prisma.approvalVote.create({
        data: {
          stepId,
          userId: voter,
          decidedBy: actor.userId,
          delegationId: delegation?.id ?? null,
          decision: dto.decision,
          note: dto.note ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError('CONFLICT', 'ลงความเห็นในขั้นนี้ไปแล้ว');
      }
      throw error;
    }
  }

  /** Approvals so far against everyone the `all` step needs. */
  private async tallyOf(
    prisma: Prisma.TransactionClient,
    step: CaseWithSteps['steps'][number],
  ): Promise<{ approved: number; required: number }> {
    const approved = await prisma.approvalVote.count({
      where: { stepId: step.id, decision: 'approve' },
    });
    const required = new Set(
      step.candidateUserIds.length
        ? step.candidateUserIds
        : step.approverUserId
          ? [step.approverUserId]
          : [],
    ).size;
    return { approved, required };
  }

  /** An `all` step still waiting on others: the vote is on the timeline, the case does not move. */
  private async recordPartialVote(
    prisma: Prisma.TransactionClient,
    found: CaseForDecision,
    step: CaseWithSteps['steps'][number],
    actor: Principal,
    tally: { approved: number; required: number },
    dto: DecideDto,
  ): Promise<CaseWithSteps> {
    if (found.requestId) {
      await prisma.requestEvent.create({
        data: {
          requestId: found.requestId,
          seq: await nextRequestEventSeq(prisma, found.requestId),
          type: 'request.review.vote',
          actorId: actor.userId,
          data: {
            caseId: found.id,
            stepNo: step.stepNo,
            approved: tally.approved,
            required: tally.required,
            note: dto.note ?? null,
          },
        },
      });
    }

    await this.audit.record(
      {
        eventType: 'approval.vote.cast',
        companyId: found.companyId,
        ...auditActor(actor),
        resourceType: 'approval_case',
        resourceId: found.id,
        after: { stepNo: step.stepNo, ...tally },
      },
      { prisma },
    );

    return prisma.approvalCase.findUniqueOrThrow({
      where: { id: found.id },
      include: { steps: { orderBy: { stepNo: 'asc' } } },
    });
  }

  /**
   * Closes a request's open cases when the request leaves `pending_approval`
   * by another route (cancel, return), inside that route's transaction.
   */
  async closeOpenCases(
    prisma: Prisma.TransactionClient,
    requestId: string,
    status: 'cancelled' | 'voided',
    actor: Principal,
  ): Promise<void> {
    const open = await prisma.approvalCase.findMany({
      where: { requestId, status: 'pending' },
      select: { id: true, companyId: true },
    });
    if (!open.length) return;

    await prisma.approvalCase.updateMany({
      where: { id: { in: open.map((found) => found.id) }, status: 'pending' },
      data: { status, decidedAt: new Date() },
    });

    for (const found of open) {
      await this.audit.record(
        {
          eventType: `approval.case.${status}`,
          companyId: found.companyId,
          ...auditActor(actor),
          resourceType: 'approval_case',
          resourceId: found.id,
          before: { status: 'pending' },
          after: { status, reason: 'request_moved_on' },
        },
        { prisma },
      );
    }
  }

  // --- APV-05: snapshot binding -------------------------------------------

  /**
   * Voids a case whose subject has materially changed.
   *
   * Called when the underlying data is edited. Approvals already given no
   * longer apply, because they were given against different numbers — a fresh
   * route is the only honest outcome.
   */
  async voidIfChanged(
    caseId: string,
    payload: unknown,
    actor: Principal,
  ): Promise<boolean> {
    const found = await this.cases.findWithSteps(caseId);
    if (!found || found.status !== 'pending') return false;

    const hash = snapshotHash(payload);
    if (hash === found.snapshotHash) return false;

    await this.transactions.execute(async (prisma) => {
      await prisma.approvalCase.update({
        where: { id: caseId },
        data: {
          status: 'voided',
          snapshotHash: hash,
          snapshotVersion: found.snapshotVersion + 1,
          decidedAt: new Date(),
        },
      });

      await this.audit.record(
        {
          eventType: 'approval.case.voided',
          companyId: found.companyId,
          ...auditActor(actor),
          resourceType: 'approval_case',
          resourceId: caseId,
          before: { snapshotHash: found.snapshotHash },
          after: { snapshotHash: hash, reason: 'material_edit' },
        },
        { prisma },
      );
    });

    return true;
  }

  // --- reads --------------------------------------------------------------

  /**
   * The people this person is covering for right now (APV-03).
   *
   * Public so the request lists can build an `AccessSubject` that knows about
   * delegations without reaching into the delegation table themselves — the
   * "อนุมัติ" tab has to count the same rows this module lets them decide.
   */
  coveringFor(actor: Principal): Promise<string[]> {
    return this.delegations.delegatorsFor(
      actor.activeCompanyId,
      actor.userId,
      new Date(),
    );
  }

  /** Cases waiting on this person, including anything they cover (APV-03). */
  async inbox(actor: Principal, query: PageQueryDto) {
    const { skip, take } = toSkipTake(query);
    const now = new Date();

    const covering = await this.delegations.delegatorsFor(
      actor.activeCompanyId,
      actor.userId,
      now,
    );

    /*
      One rule, shared with the "อนุมัติ" tab on หน้าที่ 2 and with `authorise`.

      This screen used to build its own condition, and the tab built a narrower
      one — so a person covering for an approver, or holding a step routed
      before `candidateUserIds` existed, worked from this inbox while the tab
      told them they had nothing.
    */
    const subject = accessSubject(actor, covering);
    const where: Prisma.ApprovalCaseWhereInput = {
      companyId: actor.activeCompanyId,
      status: 'pending',
      OR: [
        {
          steps: {
            some: {
              status: 'pending',
              ...(decidableStepWhere(subject) as Prisma.ApprovalStepWhereInput),
            },
          },
        },
        // Scope grants reach the request, not a named step — the tab's rule, applied here.
        { request: awaitingDecisionWhere(subject) },
      ],
    };

    const [rows, total] = await Promise.all([
      this.cases.search(where, { skip, take }),
      this.cases.countWhere(where),
    ]);

    return paginated(rows, query, total);
  }

  async findOne(caseId: string, actor: Principal): Promise<CaseWithSteps> {
    const found = await this.cases.findWithSteps(caseId);

    // SCOPE-03 again: a case in another company is "not found".
    if (!found || found.companyId !== actor.activeCompanyId) {
      throw new AppError('NOT_FOUND', 'ไม่พบรายการอนุมัติที่ระบุ');
    }

    return found;
  }

  /** APV-06 / history: decided cases, newest first. */
  async history(actor: Principal, query: PageQueryDto, subjectType?: string) {
    const { skip, take } = toSkipTake(query);

    const where: Prisma.ApprovalCaseWhereInput = {
      companyId: actor.activeCompanyId,
      status: { not: 'pending' },
      ...(subjectType ? { subjectType } : {}),
    };

    const [rows, total] = await Promise.all([
      this.cases.search(where, { skip, take }),
      this.cases.countWhere(where),
    ]);

    return paginated(rows, query, total);
  }
}
