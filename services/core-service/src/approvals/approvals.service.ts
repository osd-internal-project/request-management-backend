import { Injectable } from '@nestjs/common';
import {
  AppError,
  auditActor,
  AuditWriter,
  PrismaTransactionService,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { PageQueryDto, Principal } from '@request-management/share';
import type { Prisma } from '@prisma/client';
import {
  MatrixTier,
  assertStepOneResolvable,
  resolveChain,
  selectTier,
} from './approval-chain';
import { snapshotHash } from './snapshot';
import { ApprovalMatrixService } from './approval-matrix.service';
import {
  ApprovalCaseRepository,
  CaseWithSteps,
} from './approval-case.repository';
import { DelegationRepository } from './delegation.repository';
import { ApprovalContextClient } from '../principal/approval-context.client';
import { NotificationsService } from '../notifications/notifications.service';
import { BatchDecideDto, DecideDto, OpenCaseDto } from './dto/approval.dto';

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
    private readonly context: ApprovalContextClient,
    private readonly notifications: NotificationsService,
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
    const now = new Date();

    const matrix = await this.matrix.requireEffective(
      companyId,
      dto.subject_type,
      now,
    );

    const tiers = matrix.tiers as unknown as MatrixTier[];
    const tier = selectTier(tiers, dto.amount ?? null);

    const context = await this.context.resolve(
      authorization,
      requesterId,
      companyId,
    );

    // The chain is a lookup into what user-service already told us, so the
    // walk upward never issues another request mid-transaction.
    const chain = resolveChain({
      chain: tier.chain,
      requesterId,
      requesterSupervisorId: context.supervisorUserId,
      roleHolders: context.roleHolders,
      supervisorOf: (userId) => {
        const index = [context.supervisorUserId, ...context.supervisorChain]
          .filter((id): id is string => id !== null)
          .indexOf(userId);
        return index >= 0 ? (context.supervisorChain[index] ?? null) : null;
      },
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

    return opened;
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
    // §8: "Rejection always requires a reason." A rejection with no stated
    // cause is unappealable and unreportable.
    if (dto.decision !== 'approve' && !dto.note?.trim()) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุเหตุผลเมื่อไม่อนุมัติหรือส่งกลับแก้ไข',
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
    if (step.approverUserId === actor.userId) return null;

    const delegation = step.approverUserId
      ? await this.delegations.findActiveFor(
          found.companyId,
          step.approverUserId,
          actor.userId,
          new Date(),
          { prisma },
        )
      : null;

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

  /** Cases waiting on this person, including anything they cover (APV-03). */
  async inbox(actor: Principal, query: PageQueryDto) {
    const { skip, take } = toSkipTake(query);
    const now = new Date();

    const covering = await this.delegations.delegatorsFor(
      actor.activeCompanyId,
      actor.userId,
      now,
    );

    const where: Prisma.ApprovalCaseWhereInput = {
      companyId: actor.activeCompanyId,
      status: 'pending',
      steps: {
        some: {
          status: 'pending',
          approverUserId: { in: [actor.userId, ...covering] },
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
