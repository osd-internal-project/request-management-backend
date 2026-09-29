import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { SolutionRequirementRepository } from './solution.repositories';
import { SolutionsService } from './solutions.service';
import {
  assessmentProblem,
  type RequirementAssessment,
} from './solution-rules';
import type {
  AnswerRequirementDto,
  CreateRequirementDto,
  UpdateRequirementDto,
} from './dto/solution.dto';

/** Enough for one opportunity's brief; a longer list is a different problem. */
export const MAX_REQUIREMENTS = 200;

interface RequirementRow {
  id: string;
  solutionId: string;
  assessment: RequirementAssessment;
  note: string;
  text: string;
  kind: string;
  customerAnswer: string | null;
}

/**
 * CD-131 — วิเคราะห์ความต้องการ (user decisions 29 ก.ย. 2569):
 *
 * - a list on the Solution, apart from its versions — the analysis keeps
 *   moving while the design is drafted, and never needs a new version;
 * - each item is business or technical and is assessed as feasible, not
 *   feasible (with the reason) or needs information from the customer (with
 *   the question). The customer's answer is recorded on the item;
 * - a version cannot lock while an item is unassessed or still waiting on
 *   the customer — `SolutionsService.lock` asks `requirementGaps`.
 *
 * Pre-Sales (`presales.solution.manage`) edits the analysis. The customer's
 * answer may also be recorded by a salesperson on the deal
 * (`crm.sales.manage`): they are the ones talking to the customer.
 */
@Injectable()
export class RequirementsService {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly requirements: SolutionRequirementRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async add(solutionId: string, dto: CreateRequirementDto, actor: Principal) {
    const solution = await this.solutions.requireManageable(solutionId, actor);
    const count = await this.requirements.count({
      where: { solutionId, deletedAt: null },
    });
    if (count >= MAX_REQUIREMENTS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ความต้องการได้ไม่เกิน ${MAX_REQUIREMENTS} ข้อ`,
        [{ field: 'text', reason: 'too_many' }],
      );
    }
    await this.transactions.execute(async (prisma) => {
      // seq counts removed items too, so a number never returns.
      const last = (await this.requirements.findFirst(
        {
          where: { solutionId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.requirements.create(
        {
          data: {
            companyId: solution.companyId,
            solutionId,
            seq: (last?.seq ?? 0) + 1,
            kind: dto.kind,
            text: dto.text.trim(),
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.audit.record(
        {
          eventType: 'presales.solution.requirement_added',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: solutionId,
          after: {
            requirementId: created.id,
            seq: created.seq,
            kind: dto.kind,
          },
        },
        { prisma },
      );
    });
    return this.solutions.findOne(solutionId, actor);
  }

  async update(
    solutionId: string,
    requirementId: string,
    dto: UpdateRequirementDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(solutionId, actor);
    const row = await this.requireItem(solutionId, requirementId);
    const assessment = dto.assessment ?? row.assessment;
    const note = dto.note ?? row.note;
    const problem = assessmentProblem(assessment, note);
    if (problem) {
      throw new AppError('VALIDATION_FAILED', problem, [
        { field: 'note', reason: 'required' },
      ]);
    }
    // Asking again is a new question: the old answer no longer answers it.
    const reasked =
      assessment === 'needs_info' &&
      (row.assessment !== 'needs_info' || note.trim() !== row.note.trim());

    await this.transactions.execute(async (prisma) => {
      await this.requirements.update(
        {
          where: { id: requirementId },
          data: {
            ...(dto.kind ? { kind: dto.kind } : {}),
            ...(dto.text !== undefined ? { text: dto.text.trim() } : {}),
            assessment,
            note: note.trim(),
            ...(reasked
              ? { customerAnswer: null, answeredAt: null, answeredBy: null }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'presales.solution.requirement_assessed',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: solutionId,
          before: { requirementId, assessment: row.assessment },
          after: { requirementId, assessment, reasked },
        },
        { prisma },
      );
    });
    return this.solutions.findOne(solutionId, actor);
  }

  /** The customer's answer to what Pre-Sales asked. */
  async answer(
    solutionId: string,
    requirementId: string,
    dto: AnswerRequirementDto,
    actor: Principal,
  ) {
    if (
      !this.solutions.canManage(actor) &&
      !this.solutions.canAnswerAsSales(actor)
    ) {
      throw new AppError('FORBIDDEN', 'ไม่มีสิทธิ์บันทึกคำตอบของลูกค้า');
    }
    // Sales reach it only through a deal they can see (404 otherwise).
    const solution = await this.solutions.requireReadable(solutionId, actor);
    const row = await this.requireItem(solutionId, requirementId);
    if (row.assessment !== 'needs_info') {
      throw new AppError(
        'CONFLICT',
        'ข้อนี้ไม่ได้รอข้อมูลจากลูกค้า — บันทึกคำตอบไม่ได้',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.requirements.update(
        {
          where: { id: requirementId },
          data: {
            customerAnswer: dto.answer.trim(),
            answeredAt: new Date(),
            answeredBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'presales.solution.requirement_answered',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: solutionId,
          before: { requirementId, answer: row.customerAnswer },
          after: { requirementId, answer: dto.answer.trim() },
        },
        { prisma },
      );
    });
    return this.solutions.findOne(solutionId, actor);
  }

  /** Soft delete — the item stays findable, and its number is not reused. */
  async remove(solutionId: string, requirementId: string, actor: Principal) {
    const solution = await this.solutions.requireManageable(solutionId, actor);
    const row = await this.requireItem(solutionId, requirementId);
    await this.transactions.execute(async (prisma) => {
      await this.requirements.update(
        {
          where: { id: requirementId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'presales.solution.requirement_removed',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: solutionId,
          before: { requirementId, text: row.text, assessment: row.assessment },
        },
        { prisma },
      );
    });
    return this.solutions.findOne(solutionId, actor);
  }

  private async requireItem(
    solutionId: string,
    requirementId: string,
  ): Promise<RequirementRow> {
    const row = (await this.requirements.findFirst({
      where: { id: requirementId, solutionId, deletedAt: null },
    })) as RequirementRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบความต้องการที่ระบุ');
    return row;
  }
}
