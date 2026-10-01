import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { ContractRiskAssessmentRepository } from '../crm/contract-risk.service';
import { bangkokDay } from '../crm/kyc-rules';
import {
  SolutionRiskRepository,
  SolutionVersionRepository,
} from '../presales/solution.repositories';
import { ReviewRiskDto, SaveProjectRiskDto } from './dto/project.dto';
import {
  fromLegalIssues,
  fromSolutionRisks,
  levelOf,
  needsPlan,
  nextReviewOn,
  reviewOverdue,
  riskProblems,
} from './project-risk-rules';
import {
  ProjectRepository,
  ProjectRiskRepository,
  ProjectRiskReviewRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface RiskRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  source: string;
  sourceRef: string | null;
  title: string;
  description: string | null;
  likelihood: number;
  impact: number;
  ownerUserId: string | null;
  response: string | null;
  status: string;
  reviewEveryDays: number;
  lastReviewedAt: Date | null;
  nextReviewOn: Date | null;
  createdAt: Date;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDay = (value: string) => new Date(`${value}T00:00:00Z`);

/**
 * CD-183 ความเสี่ยงโครงการ — the project's risks: taken over from the
 * technical team (the approved Solution's open risks, CD-141) and Legal
 * (the contract's assessed issues, CD-158), or raised here; each with an
 * owner, a response plan and a review cycle. An open high or critical risk
 * with no plan — and a review past its day — is listed for the executives
 * across every project.
 *
 * Who: whoever sees the project reads them; `pm.project.manage` or the
 * project's manager keeps them; the risk's owner may review it.
 */
@Injectable()
export class ProjectRisksService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly risks: ProjectRiskRepository,
    private readonly reviews: ProjectRiskReviewRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly solutionRisks: SolutionRiskRepository,
    private readonly legal: ContractRiskAssessmentRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(projectId: string, actor: Principal, now = new Date()) {
    const { canEdit } = await this.projects.access(projectId, actor);
    const rows = (await this.risks.findMany({
      where: { projectId },
      orderBy: { seq: 'asc' },
    })) as RiskRow[];
    const history = (await this.reviews.findMany({
      where: { riskId: { in: rows.map((row) => row.id) } },
      orderBy: { reviewedAt: 'desc' },
    })) as {
      id: string;
      riskId: string;
      note: string;
      likelihood: number;
      impact: number;
      status: string;
      reviewedBy: string;
      reviewedAt: Date;
    }[];
    const names = await this.displayNames([
      ...rows.map((row) => row.ownerUserId),
      ...history.map((row) => row.reviewedBy),
    ]);
    const today = bangkokDay(now);
    return {
      canEdit,
      today,
      risks: rows.map((row) => ({
        ...this.present(row, names, today),
        reviews: history
          .filter((item) => item.riskId === row.id)
          .slice(0, 5)
          .map((item) => ({
            ...item,
            level: levelOf(item.likelihood, item.impact),
            reviewedByName: names.get(item.reviewedBy) ?? item.reviewedBy,
          })),
      })),
    };
  }

  async create(
    projectId: string,
    dto: SaveProjectRiskDto,
    actor: Principal,
    now = new Date(),
  ) {
    const { project } = await this.editable(projectId, actor);
    const input = {
      title: dto.title?.trim() ?? '',
      likelihood: dto.likelihood ?? 3,
      impact: dto.impact ?? 3,
      reviewEveryDays: dto.review_every_days ?? 14,
    };
    this.assertValid(input);
    await this.assertOwner(project.companyId, dto.owner_user_id);
    await this.transactions.execute(async (prisma) => {
      const seq = await this.nextSeq(projectId, prisma);
      const row = (await this.risks.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            seq,
            source: 'project',
            ...input,
            description: dto.description?.trim() || null,
            ownerUserId: dto.owner_user_id ?? null,
            response: dto.response?.trim() || null,
            nextReviewOn: asDay(
              nextReviewOn(bangkokDay(now), input.reviewEveryDays),
            ),
            createdBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.risk.created',
        row.id,
        {
          projectId,
          title: input.title,
          level: levelOf(input.likelihood, input.impact),
        },
      );
    });
    return this.list(projectId, actor, now);
  }

  async update(
    projectId: string,
    riskId: string,
    dto: SaveProjectRiskDto,
    actor: Principal,
    now = new Date(),
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requireRisk(projectId, riskId);
    const input = {
      title: dto.title?.trim() ?? current.title,
      likelihood: dto.likelihood ?? current.likelihood,
      impact: dto.impact ?? current.impact,
      reviewEveryDays: dto.review_every_days ?? current.reviewEveryDays,
    };
    this.assertValid(input);
    if (dto.owner_user_id) {
      await this.assertOwner(project.companyId, dto.owner_user_id);
    }
    const cycleChanged = input.reviewEveryDays !== current.reviewEveryDays;
    await this.transactions.execute(async (prisma) => {
      await this.risks.update(
        {
          where: { id: riskId },
          data: {
            ...input,
            ...(dto.description !== undefined
              ? { description: dto.description.trim() || null }
              : {}),
            ...(dto.owner_user_id !== undefined
              ? { ownerUserId: dto.owner_user_id }
              : {}),
            ...(dto.response !== undefined
              ? { response: dto.response.trim() || null }
              : {}),
            ...(dto.status !== undefined ? { status: dto.status } : {}),
            // a new cycle counts from the last review (or today)
            ...(cycleChanged
              ? {
                  nextReviewOn: asDay(
                    nextReviewOn(
                      day(current.lastReviewedAt) ?? bangkokDay(now),
                      input.reviewEveryDays,
                    ),
                  ),
                }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.risk.updated',
        riskId,
        {
          before: {
            likelihood: current.likelihood,
            impact: current.impact,
            status: current.status,
          },
          after: { ...dto },
        },
      );
    });
    return this.list(projectId, actor, now);
  }

  /** A review: what was found, the score and status it leaves, the next day. */
  async review(
    projectId: string,
    riskId: string,
    dto: ReviewRiskDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    const current = await this.requireRisk(projectId, riskId);
    if (!access.canEdit && current.ownerUserId !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'ทบทวนได้เฉพาะเจ้าของความเสี่ยง ผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const likelihood = dto.likelihood ?? current.likelihood;
    const impact = dto.impact ?? current.impact;
    const status = dto.status ?? current.status;
    this.assertValid({
      title: current.title,
      likelihood,
      impact,
      reviewEveryDays: current.reviewEveryDays,
    });
    if (!dto.note?.trim()) {
      throw new AppError('VALIDATION_FAILED', 'ต้องบันทึกผลการทบทวน', [
        { field: 'note', reason: 'required' },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await this.reviews.create(
        {
          data: {
            riskId,
            note: dto.note.trim(),
            likelihood,
            impact,
            status,
            reviewedBy: actor.userId,
            reviewedAt: now,
          },
        },
        { prisma },
      );
      await this.risks.update(
        {
          where: { id: riskId },
          data: {
            likelihood,
            impact,
            status,
            lastReviewedAt: now,
            nextReviewOn:
              status === 'open'
                ? asDay(nextReviewOn(bangkokDay(now), current.reviewEveryDays))
                : null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        prisma,
        current.companyId,
        actor,
        'pm.risk.reviewed',
        riskId,
        {
          likelihood,
          impact,
          status,
        },
      );
    });
    return this.list(projectId, actor, now);
  }

  /** Take over what the technical team and Legal left open — once each. */
  async takeOver(projectId: string, actor: Principal, now = new Date()) {
    const { project } = await this.editable(projectId, actor);
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { solutionVersionId: true, contractId: true },
    })) as { solutionVersionId: string | null; contractId: string } | null;
    const taken = new Set(
      (
        (await this.risks.findMany({
          where: { projectId, sourceRef: { not: null } },
          select: { sourceRef: true },
        })) as { sourceRef: string }[]
      ).map((item) => item.sourceRef),
    );
    const version = row?.solutionVersionId
      ? ((await this.versions.findFirst({
          where: { id: row.solutionVersionId },
          select: { solutionId: true },
        })) as { solutionId: string } | null)
      : null;
    const technical = version
      ? fromSolutionRisks(
          await this.solutionRisks.findMany({
            where: { solutionId: version.solutionId, deletedAt: null },
            orderBy: { seq: 'asc' },
          }),
          taken,
        )
      : [];
    const assessment = row
      ? ((await this.legal.findFirst({
          where: { contractId: row.contractId },
          select: { id: true, issues: true },
        })) as { id: string; issues: unknown } | null)
      : null;
    const legal = assessment
      ? fromLegalIssues(
          Array.isArray(assessment.issues)
            ? (assessment.issues as Parameters<typeof fromLegalIssues>[0])
            : [],
          assessment.id,
          taken,
        )
      : [];
    const drafts = [...technical, ...legal];
    if (!drafts.length) {
      throw new AppError(
        'CONFLICT',
        'ไม่มีความเสี่ยงจากทีมเทคนิคหรือฝ่ายกฎหมายที่ยังไม่ได้รับเข้ามา',
      );
    }
    await this.transactions.execute(async (prisma) => {
      let seq = (await this.nextSeq(projectId, prisma)) - 1;
      for (const draft of drafts) {
        await this.risks.create(
          {
            data: {
              companyId: project.companyId,
              projectId,
              seq: ++seq,
              ...draft,
              nextReviewOn: asDay(nextReviewOn(bangkokDay(now), 14)),
              createdBy: actor.userId,
            },
          },
          { prisma },
        );
      }
      await this.record(
        prisma,
        project.companyId,
        actor,
        'pm.risk.taken_over',
        projectId,
        {
          technical: technical.length,
          legal: legal.length,
        },
      );
    });
    return this.list(projectId, actor, now);
  }

  /**
   * For the executives: across the company's running projects, every open
   * high or critical risk without an owner or a plan, and every review past
   * its day.
   */
  async attention(actor: Principal, now = new Date()) {
    const today = bangkokDay(now);
    const rows = (await this.risks.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: 'open',
        project: { status: { in: ['active', 'on_hold'] } },
      },
      orderBy: [{ projectId: 'asc' }, { seq: 'asc' }],
      include: {
        project: {
          select: {
            id: true,
            projectNo: true,
            name: true,
            managerUserId: true,
          },
        },
      },
    })) as unknown as (RiskRow & {
      project: {
        id: string;
        projectNo: string;
        name: string;
        managerUserId: string;
      };
    })[];
    const flagged = rows.filter(
      (row) =>
        needsPlan(row) ||
        reviewOverdue(
          { status: row.status, nextReviewOn: day(row.nextReviewOn) },
          today,
        ),
    );
    const names = await this.displayNames([
      ...flagged.map((row) => row.ownerUserId),
      ...flagged.map((row) => row.project.managerUserId),
    ]);
    return flagged
      .map((row) => ({
        ...this.present(row, names, today),
        project: {
          id: row.project.id,
          projectNo: row.project.projectNo,
          name: row.project.name,
          managerName: names.get(row.project.managerUserId) ?? null,
        },
      }))
      .sort((a, b) => b.score - a.score);
  }

  // --- helpers -------------------------------------------------------------------

  private present(row: RiskRow, names: Map<string, string>, today: string) {
    const next = day(row.nextReviewOn);
    return {
      id: row.id,
      seq: row.seq,
      label: `R-${row.seq}`,
      source: row.source,
      title: row.title,
      description: row.description,
      likelihood: row.likelihood,
      impact: row.impact,
      score: row.likelihood * row.impact,
      level: levelOf(row.likelihood, row.impact),
      ownerUserId: row.ownerUserId,
      ownerName: row.ownerUserId ? (names.get(row.ownerUserId) ?? null) : null,
      response: row.response,
      status: row.status,
      reviewEveryDays: row.reviewEveryDays,
      lastReviewedAt: row.lastReviewedAt,
      nextReviewOn: next,
      needsPlan: needsPlan(row),
      reviewOverdue: reviewOverdue(
        { status: row.status, nextReviewOn: next },
        today,
      ),
    };
  }

  private async nextSeq(projectId: string, prisma: unknown) {
    const last = (await this.risks.findFirst(
      {
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      },
      { prisma: prisma as never },
    )) as { seq: number } | null;
    return (last?.seq ?? 0) + 1;
  }

  private assertValid(input: {
    title: string;
    likelihood: number;
    impact: number;
    reviewEveryDays: number;
  }) {
    const problems = riskProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'risk', reason })),
      );
    }
  }

  private async assertOwner(
    companyId: string,
    userId: string | null | undefined,
  ) {
    if (!userId) return;
    const found = await this.people.count({
      where: { id: userId, companies: { some: { companyId } } },
    });
    if (!found) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เจ้าของความเสี่ยงไม่ได้อยู่ในบริษัทนี้',
        [{ field: 'owner_user_id', reason: 'not_found' }],
      );
    }
  }

  private async requireRisk(projectId: string, riskId: string) {
    const row = (await this.risks.findFirst({
      where: { id: riskId, projectId },
    })) as RiskRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบความเสี่ยงที่ระบุ');
    return row;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'จัดการความเสี่ยงได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private record(
    prisma: unknown,
    companyId: string,
    actor: Principal,
    eventType: string,
    resourceId: string,
    after: Record<string, unknown>,
  ) {
    return this.audit.record(
      {
        eventType,
        companyId,
        ...auditActor(actor),
        resourceType:
          eventType === 'pm.risk.taken_over' ? 'project' : 'project_risk',
        resourceId,
        after: after as never,
      },
      { prisma: prisma as never },
    );
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
