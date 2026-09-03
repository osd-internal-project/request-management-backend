import { Injectable } from '@nestjs/common';
import {
  accessSubject,
  AppError,
  auditActor,
  AuditWriter,
  decidableStepWhere,
  PrismaTransactionService,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { PageQueryDto, Principal } from '@request-management/share';
import type { ApprovalMatrix, Prisma } from '@prisma/client';
import { ResolvedApprover, assertStepOneResolvable } from './approval-chain';
import { snapshotHash } from './snapshot';
import { ApprovalMatrixService } from './approval-matrix.service';
import { AccessService, type MatrixLevel } from '../access/access.service';
import type { Delegation } from '@prisma/client';
import {
  ApprovalCaseRepository,
  CaseWithSteps,
} from './approval-case.repository';
import { DelegationRepository } from './delegation.repository';
import {
  ApprovalContext,
  ApprovalContextClient,
} from '../principal/approval-context.client';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
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
    });

    assertStepOneResolvable(chain);

    const opened = await this.transactions.execute(async (prisma) => {
      const created = await prisma.approvalCase.create({
        data: {
          companyId,
          subjectType: dto.subject_type,
          subjectId: dto.subject_id,
          amount: dto.amount ?? null,
          currency: dto.currency ?? matrix.currency,
          snapshotHash: snapshotHash(dto.payload ?? {}),
          matrixId: matrix.id,
          matrixVersion: matrix.version,
          callbackEvent: dto.callback_event ?? null,
          payload: (dto.payload ?? {}) as Prisma.InputJsonValue,
          createdBy: requesterId,
          steps: {
            create: chain.map((step, index) => ({
              stepNo: index + 1,
              approverRole: step.position,
              approverUserId: step.userId,
              candidateUserIds: [...step.candidateUserIds],
              // Only step 1 is actionable; the rest wait their turn, which is
              // what stops the ladder being skipped.
              status: index === 0 ? 'pending' : 'waiting',
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
            matrixVersion: matrix.version,
            chain: chain.map((step) => step.position),
          },
        },
        { prisma },
      );

      return created;
    });

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
        approver_id: opened.steps[0]?.approverUserId ?? null,
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

    const chain = await this.resolveLevels(levels, {
      requesterId: input.requesterId,
      orgUnitId: context.orgUnitId ?? null,
    });

    return { matrix, chain, context };
  }

  /**
   * Turns each level into the people who may decide it.
   *
   * A level nobody fills is **dropped**, not left empty: that is how the
   * self-approval rule has always behaved for a named office, and a step with
   * no possible approver would stall the case for ever. Step 1 having nobody
   * is the one case that is refused, by `assertStepOneResolvable`.
   */
  private async resolveLevels(
    levels: readonly MatrixLevel[],
    subject: { requesterId: string; orgUnitId: string | null },
  ): Promise<ResolvedApprover[]> {
    const resolved: ResolvedApprover[] = [];

    for (const level of levels) {
      const candidates = await this.access.approverCandidatesOf(level, subject);
      if (!candidates.length) continue;

      resolved.push({
        position:
          level.type === 'supervisor' ? `supervisor:${level.up}` : 'org',
        userId: candidates[0],
        candidateUserIds: candidates,
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
   * data (`user_id: null`) and the submit itself is what refuses.
   */
  async previewChain(
    dto: PreviewChainDto,
    actor: Principal,
    authorization: string,
  ): Promise<ChainPreview> {
    const amount = dto.amount ?? null;

    const { chain, context } = await this.planChain({
      subjectType: dto.subject_type,
      amount,
      requesterId: actor.userId,
      companyId: actor.activeCompanyId,
      authorization,
    });

    return {
      amount,
      currency: dto.currency ?? 'THB',
      steps: chain.map((step, index) => ({
        step_no: index + 1,
        position: step.position,
        user_id: step.userId,
        display_name: step.userId
          ? (context.displayNames[step.userId] ?? null)
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
  async hasPublishedMatrix(
    subjectType: string,
    companyId: string,
    _authorization: string,
  ): Promise<boolean> {
    return this.matrix.hasEffective(companyId, subjectType, new Date());
  }

  /** Whether any approval matrix version routes this subject at all. */
  countMatricesFor(subjectType: string): Promise<number> {
    return this.matrix.countForSubject(subjectType);
  }

  /**
   * The next slot in a request's timeline.
   *
   * `RequestEvent` is unique on `(requestId, seq)` and append-only (REQ-07), so
   * the number has to be read inside the same transaction that writes the row.
   */
  private async nextRequestEventSeq(
    prisma: Prisma.TransactionClient,
    requestId: string,
  ): Promise<number> {
    const last = await prisma.requestEvent.findFirst({
      where: { requestId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });

    return (last?.seq ?? 0) + 1;
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
      Every decision carries a reason, approvals included (H2.2 ยกเว้นไม่ได้).

      §8 required one only for a rejection. An approval with nothing said is
      the harder gap: a request that was approved and nobody can say on what
      basis is exactly what an authority-usage report is asked to answer
      afterwards, and by then the person who clicked has forgotten.
    */
    if (!dto.note?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุคำอธิบายประกอบการตัดสินใจ',
        [{ field: 'note', reason: 'required' }],
      );
    }

    const decided = await this.transactions.execute(async (prisma) => {
      const found = await prisma.approvalCase.findUnique({
        where: { id: caseId },
        include: { steps: { orderBy: { stepNo: 'asc' } } },
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

      const step = found.steps.find(
        (candidate) => candidate.stepNo === found.currentStep,
      );

      if (!step) {
        throw new AppError('CONFLICT', 'ไม่พบชั้นอนุมัติปัจจุบัน');
      }

      const delegation = await this.authorise(prisma, found, step, actor);

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

      const isLastStep = found.currentStep >= found.steps.length;
      const nextStatus =
        dto.decision === 'reject'
          ? 'rejected'
          : dto.decision === 'return'
            ? 'returned'
            : isLastStep
              ? 'approved'
              : 'pending';

      const updated = await prisma.approvalCase.update({
        where: { id: found.id },
        data: {
          status: nextStatus,
          currentStep:
            nextStatus === 'pending'
              ? found.currentStep + 1
              : found.currentStep,
          decidedAt: nextStatus === 'pending' ? null : new Date(),
        },
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

        const toStatus =
          nextStatus === 'approved'
            ? preWork
              ? 'submitted'
              : 'approved'
            : nextStatus === 'rejected'
              ? 'rejected'
              : preWork
                ? 'returned'
                : 'in_progress';

        await prisma.request.update({
          where: { id: found.requestId },
          data: { status: toStatus, updatedBy: actor.userId },
        });

        await prisma.requestEvent.create({
          data: {
            requestId: found.requestId,
            seq: await this.nextRequestEventSeq(prisma, found.requestId),
            type: `request.review.${dto.decision}`,
            actorId: actor.userId,
            fromStatus: 'pending_approval',
            toStatus,
            data: { caseId: found.id, note: dto.note ?? null },
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
            seq: await this.nextRequestEventSeq(prisma, found.requestId),
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
        await prisma.approvalStep.updateMany({
          where: { caseId: found.id, stepNo: updated.currentStep },
          data: { status: 'pending' },
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

    await this.notifications.decisionMade(decided, dto.decision);

    return decided;
  }

  /**
   * APV-03: may this person act on this step?
   *
   * Returns the delegation used, or `null` when they are the named approver.
   * A delegation is looked up **now**, not at submit — that is what makes work
   * already sitting in a queue route to whoever is covering.
   */
  private async authorise(
    prisma: Prisma.TransactionClient,
    found: CaseWithSteps,
    step: CaseWithSteps['steps'][number],
    actor: Principal,
  ) {
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

    if (candidates.includes(actor.userId)) return null;

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

    if (!delegation) {
      throw new AppError('APV_NOT_YOUR_TURN', 'คุณไม่ใช่ผู้อนุมัติของชั้นนี้', [
        { field: 'step_no', reason: String(step.stepNo) },
      ]);
    }

    return delegation;
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
    const where: Prisma.ApprovalCaseWhereInput = {
      companyId: actor.activeCompanyId,
      status: 'pending',
      steps: {
        some: {
          status: 'pending',
          ...(decidableStepWhere(
            accessSubject(actor, covering),
          ) as Prisma.ApprovalStepWhereInput),
        },
      },
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
