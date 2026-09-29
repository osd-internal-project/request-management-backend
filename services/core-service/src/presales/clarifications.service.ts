import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import {
  SolutionClarificationRepository,
  SolutionVersionRepository,
} from './solution.repositories';
import { SolutionsService } from './solutions.service';
import { scopeResolutionProblem } from './solution-rules';
import type {
  AnswerClarificationDto,
  CreateClarificationDto,
  ResolveClarificationDto,
  UpdateClarificationDto,
} from './dto/solution.dto';

/** One Solution's Q&A; more is a different conversation. */
export const MAX_CLARIFICATIONS = 300;

interface ClarificationRow {
  id: string;
  solutionId: string;
  question: string;
  answer: string | null;
  answerRecordedAt: Date | null;
  answeredOnVersionNo: number | null;
  affectsScope: boolean;
  scopeResolvedVersionNo: number | null;
}

/** A calendar day, read at UTC midnight so no zone shifts it. */
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const today = () => day(new Date().toISOString().slice(0, 10));

/**
 * CD-140 — ชี้แจงประเด็นเทคนิค (user decisions 29 ก.ย. 2569):
 *
 * - a Q&A log on the Solution, apart from its versions: each question with
 *   when it was asked and by whom; each answer with the customer's
 *   respondent, the day they answered and who recorded it;
 * - an answer may change the scope. It then stays open until Pre-Sales
 *   names the version whose SOW reflects it — a draft, or one locked after
 *   the answer — and while any is open the Solution cannot be sent for
 *   approval (`approvalBlocker`);
 * - Pre-Sales and the salesperson on the deal both talk to the customer, so
 *   both ask and record answers; only Pre-Sales closes a scope change or
 *   removes an entry.
 *
 * Planned for ระยะที่ 3 (CD-22): answered entries flow into KBMS as drafts.
 */
@Injectable()
export class ClarificationsService {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly clarifications: SolutionClarificationRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async ask(id: string, dto: CreateClarificationDto, actor: Principal) {
    const solution = await this.requireWriter(id, actor);
    const count = await this.clarifications.count({
      where: { solutionId: id, deletedAt: null },
    });
    if (count >= MAX_CLARIFICATIONS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `คำถามได้ไม่เกิน ${MAX_CLARIFICATIONS} ข้อ`,
        [{ field: 'question', reason: 'too_many' }],
      );
    }
    await this.transactions.execute(async (prisma) => {
      // seq counts removed entries too, so a number never returns.
      const last = (await this.clarifications.findFirst(
        {
          where: { solutionId: id },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.clarifications.create(
        {
          data: {
            companyId: solution.companyId,
            solutionId: id,
            seq: (last?.seq ?? 0) + 1,
            question: dto.question.trim(),
            askedOn: dto.asked_on ? day(dto.asked_on) : today(),
            askedBy: actor.userId,
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.record(
        'presales.solution.clarification_asked',
        solution.companyId,
        id,
        actor,
        prisma,
        { after: { clarificationId: created.id, seq: created.seq } },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Reword the question — until it has been answered. */
  async edit(
    id: string,
    clarificationId: string,
    dto: UpdateClarificationDto,
    actor: Principal,
  ) {
    const solution = await this.requireWriter(id, actor);
    const row = await this.requireItem(id, clarificationId);
    if (row.answer) {
      throw new AppError('CONFLICT', 'ข้อนี้ได้คำตอบแล้ว — แก้คำถามไม่ได้');
    }
    await this.transactions.execute(async (prisma) => {
      await this.clarifications.update(
        {
          where: { id: clarificationId },
          data: { question: dto.question.trim(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.clarification_edited',
        solution.companyId,
        id,
        actor,
        prisma,
        {
          before: { clarificationId, question: row.question },
          after: { clarificationId, question: dto.question.trim() },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /**
   * The customer's answer. Answering again replaces it and, when it changes
   * the scope, opens the scope change again — the SOW must follow the
   * latest answer.
   */
  async answer(
    id: string,
    clarificationId: string,
    dto: AnswerClarificationDto,
    actor: Principal,
  ) {
    const solution = await this.requireWriter(id, actor);
    const row = await this.requireItem(id, clarificationId);
    const affectsScope = dto.affects_scope ?? false;
    await this.transactions.execute(async (prisma) => {
      await this.clarifications.update(
        {
          where: { id: clarificationId },
          data: {
            answer: dto.answer.trim(),
            respondent: dto.respondent.trim(),
            answeredOn: day(dto.answered_on),
            answerRecordedBy: actor.userId,
            answerRecordedAt: new Date(),
            answeredOnVersionNo: solution.currentVersionNo,
            affectsScope,
            scopeResolvedVersionNo: null,
            scopeResolvedAt: null,
            scopeResolvedBy: null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.clarification_answered',
        solution.companyId,
        id,
        actor,
        prisma,
        {
          before: { clarificationId, answer: row.answer },
          after: {
            clarificationId,
            answer: dto.answer.trim(),
            respondent: dto.respondent.trim(),
            answeredOn: dto.answered_on,
            affectsScope,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Close a scope-changing answer with the version whose SOW now has it. */
  async resolveScope(
    id: string,
    clarificationId: string,
    dto: ResolveClarificationDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const row = await this.requireItem(id, clarificationId);
    if (!row.affectsScope) {
      throw new AppError('CONFLICT', 'คำตอบข้อนี้ไม่ได้กระทบขอบเขต');
    }
    if (row.scopeResolvedVersionNo !== null) {
      throw new AppError(
        'CONFLICT',
        `แก้ SOW แล้วในเวอร์ชัน ${row.scopeResolvedVersionNo}`,
      );
    }
    const version = (await this.versions.findFirst({
      where: { solutionId: id, versionNo: dto.version_no },
      select: { versionNo: true, status: true, lockedAt: true },
    })) as { versionNo: number; status: string; lockedAt: Date | null } | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    const problem = scopeResolutionProblem(row, version);
    if (problem) {
      throw new AppError('VALIDATION_FAILED', problem, [
        { field: 'version_no', reason: problem },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await this.clarifications.update(
        {
          where: { id: clarificationId },
          data: {
            scopeResolvedVersionNo: version.versionNo,
            scopeResolvedAt: new Date(),
            scopeResolvedBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.clarification_scope_resolved',
        solution.companyId,
        id,
        actor,
        prisma,
        { after: { clarificationId, versionNo: version.versionNo } },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Soft delete — the entry stays findable; its number is not reused. */
  async remove(id: string, clarificationId: string, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const row = await this.requireItem(id, clarificationId);
    await this.transactions.execute(async (prisma) => {
      await this.clarifications.update(
        {
          where: { id: clarificationId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.clarification_removed',
        solution.companyId,
        id,
        actor,
        prisma,
        { before: { clarificationId, question: row.question } },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Pre-Sales, or the salesperson on a deal they can see (404 otherwise). */
  private async requireWriter(id: string, actor: Principal) {
    if (
      !this.solutions.canManage(actor) &&
      !this.solutions.canAnswerAsSales(actor)
    ) {
      throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์บันทึกคำถาม-คำตอบ');
    }
    return this.solutions.requireReadable(id, actor);
  }

  private async requireItem(
    solutionId: string,
    clarificationId: string,
  ): Promise<ClarificationRow> {
    const row = (await this.clarifications.findFirst({
      where: { id: clarificationId, solutionId, deletedAt: null },
    })) as ClarificationRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบคำถามที่ระบุ');
    return row;
  }

  private record(
    eventType: string,
    companyId: string,
    solutionId: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
    change: {
      before?: Prisma.InputJsonValue;
      after?: Prisma.InputJsonValue;
    },
  ) {
    return this.audit.record(
      {
        eventType,
        companyId,
        ...auditActor(actor),
        resourceType: 'solution',
        resourceId: solutionId,
        ...change,
      },
      { prisma },
    );
  }
}
