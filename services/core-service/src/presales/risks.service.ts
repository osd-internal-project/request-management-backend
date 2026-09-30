import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { SolutionRiskRepository } from './solution.repositories';
import { SolutionsService } from './solutions.service';
import type { CreateRiskDto, UpdateRiskDto } from './dto/solution.dto';

/** One Solution's register; more is a project's, not a pre-sale's. */
export const MAX_RISKS = 200;

interface RiskRow {
  id: string;
  title: string;
  likelihood: number;
  impact: number;
  status: string;
}

/**
 * CD-141 — ความเสี่ยงทางเทคนิค (user decisions 30 ก.ย. 2569):
 *
 * - a register on the Solution, apart from its versions, kept up to date as
 *   risks are found and mitigated;
 * - likelihood and impact 1–5 each; the score is their product and the
 *   level follows from it (`riskLevel`); each risk has an owner, a
 *   mitigation plan and a status;
 * - an open high or critical risk without an owner or a plan keeps the
 *   Solution from going for approval (`approvalBlocker`). The register goes
 *   into the approval request and the handover — the project's risks when
 *   the deal closes (PM, CD-18).
 *
 * Pre-Sales writes it (`presales.solution.manage`); sales read it through
 * the Solution page.
 */
@Injectable()
export class RisksService {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly risks: SolutionRiskRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async add(id: string, dto: CreateRiskDto, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const count = await this.risks.count({
      where: { solutionId: id, deletedAt: null },
    });
    if (count >= MAX_RISKS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ความเสี่ยงได้ไม่เกิน ${MAX_RISKS} ข้อ`,
        [{ field: 'title', reason: 'too_many' }],
      );
    }
    await this.transactions.execute(async (prisma) => {
      // seq counts removed entries too, so a number never returns.
      const last = (await this.risks.findFirst(
        {
          where: { solutionId: id },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.risks.create(
        {
          data: {
            companyId: solution.companyId,
            solutionId: id,
            seq: (last?.seq ?? 0) + 1,
            title: dto.title.trim(),
            description: dto.description?.trim() ?? '',
            likelihood: dto.likelihood,
            impact: dto.impact,
            owner: dto.owner?.trim() ?? '',
            mitigation: dto.mitigation?.trim() ?? '',
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.record(
        'presales.solution.risk_added',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            riskId: created.id,
            seq: created.seq,
            likelihood: dto.likelihood,
            impact: dto.impact,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  async update(
    id: string,
    riskId: string,
    dto: UpdateRiskDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    const row = await this.requireItem(id, riskId);
    await this.transactions.execute(async (prisma) => {
      await this.risks.update(
        {
          where: { id: riskId },
          data: {
            ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description.trim() }
              : {}),
            ...(dto.likelihood !== undefined
              ? { likelihood: dto.likelihood }
              : {}),
            ...(dto.impact !== undefined ? { impact: dto.impact } : {}),
            ...(dto.owner !== undefined ? { owner: dto.owner.trim() } : {}),
            ...(dto.mitigation !== undefined
              ? { mitigation: dto.mitigation.trim() }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.risk_updated',
        solution,
        id,
        actor,
        prisma,
        {
          before: {
            riskId,
            likelihood: row.likelihood,
            impact: row.impact,
            status: row.status,
          },
          after: {
            riskId,
            likelihood: dto.likelihood ?? row.likelihood,
            impact: dto.impact ?? row.impact,
            status: dto.status ?? row.status,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Soft delete — the entry stays findable; its number is not reused. */
  async remove(id: string, riskId: string, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const row = await this.requireItem(id, riskId);
    await this.transactions.execute(async (prisma) => {
      await this.risks.update(
        {
          where: { id: riskId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.risk_removed',
        solution,
        id,
        actor,
        prisma,
        { before: { riskId, title: row.title } },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  private async requireItem(solutionId: string, riskId: string) {
    const row = (await this.risks.findFirst({
      where: { id: riskId, solutionId, deletedAt: null },
    })) as RiskRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบความเสี่ยงที่ระบุ');
    return row;
  }

  private record(
    eventType: string,
    solution: { companyId: string },
    solutionId: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
    change: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue },
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: solution.companyId,
        ...auditActor(actor),
        resourceType: 'solution',
        resourceId: solutionId,
        ...change,
      },
      { prisma },
    );
  }
}
