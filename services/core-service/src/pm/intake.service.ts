import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CustomerTimelineService } from '../crm/customer-timeline.service';
import { SalesHandoverRepository } from '../crm/handover.repositories';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { NotificationsService } from '../notifications/notifications.service';
import { SolutionVersionRepository } from '../presales/solution.repositories';
import { AnswerIntakeDto, ReturnIntakeDto } from './dto/project.dto';
import {
  acceptProblems,
  answer,
  gapsByGroup,
  gapText,
  type IntakeGroup,
  type IntakeLineState,
  type IntakeSources,
  intakeLines,
  readAnswers,
  withAnswers,
} from './intake-rules';
import {
  ProjectIntakeRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface IntakeRow {
  id: string;
  status: 'pending' | 'returned' | 'accepted';
  answers: unknown;
  round: number;
  history: unknown;
  acceptedBy: string | null;
  acceptedAt: Date | null;
}

interface ProjectFacts {
  opportunityId: string | null;
  solutionVersionId: string | null;
  baseline: unknown;
  missing: string[];
}

interface Deal {
  id: string;
  companyId: string;
  customerId: string | null;
  opportunityCode: string;
  ownerUserId: string | null;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

export interface IntakeHistoryEntry {
  action: 'returned' | 'accepted' | 'refreshed';
  at: string;
  by: string;
  byName: string;
  round: number;
  lines: string[];
}

const GROUP_LABELS: Record<IntakeGroup, string> = {
  sales: 'ทีมขาย',
  technical: 'ทีมเทคนิค (Pre-Sales)',
  contract: 'สัญญา',
  company: 'รายการของบริษัท',
};

const historyOf = (value: unknown): IntakeHistoryEntry[] =>
  Array.isArray(value) ? (value as IntakeHistoryEntry[]) : [];

/**
 * CD-176 รับมอบงาน — before a project's budget is confirmed, its manager
 * receives the work from Sales and the technical team: each line, composed
 * from the sales handover (CD-84), the baseline's Solution, scope and BOQ
 * (CD-144), the contract and the company's own lines, is marked correct or
 * incomplete with a reason. All correct → received. Incomplete lines go
 * back to the side that answers for them — Sales the sales and company
 * lines, the Solution's authors the technical ones, the contract's owner
 * its — told by notice and on the deal's timeline. Once fixed, the manager
 * takes the baseline again; a line whose detail changed is asked again.
 *
 * Who: whoever sees the project reads it; the manager (or
 * `pm.project.manage`) answers, takes the baseline again, returns and
 * receives.
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly intakes: ProjectIntakeRepository,
    private readonly handovers: SalesHandoverRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const intake = await this.row(projectId);
    if (!intake) {
      // A project from before receipt existed — nothing to receive.
      return { canEdit: false, status: null, lines: [], history: [] };
    }
    const lines = await this.lines(access, intake);
    const history = historyOf(intake.history);
    const names = await this.displayNames([
      ...lines.map((line) => line.by),
      intake.acceptedBy,
    ]);
    return {
      canEdit: access.canEdit && intake.status !== 'accepted',
      status: intake.status,
      round: intake.round,
      acceptedAt: intake.acceptedAt,
      acceptedByName: intake.acceptedBy
        ? (names.get(intake.acceptedBy) ?? null)
        : null,
      problems: acceptProblems(lines),
      lines: lines.map((line) => ({
        ...line,
        byName: line.by ? (names.get(line.by) ?? null) : null,
      })),
      history: [...history].reverse(),
    };
  }

  /** For the budget (CD-179) and project health: received or not. */
  async state(projectId: string) {
    const intake = await this.row(projectId);
    return { status: intake?.status ?? null };
  }

  /** Mark one line correct, or incomplete with a reason. */
  async answer(
    projectId: string,
    dto: AnswerIntakeDto,
    actor: Principal,
    now = new Date(),
  ) {
    const { access, intake } = await this.editable(projectId, actor);
    const line = (await this.lines(access, intake)).find(
      (row) => row.code === dto.code,
    );
    if (!line) throw new AppError('NOT_FOUND', 'ไม่พบรายการรับมอบนี้');
    const note = dto.note?.trim() || null;
    if (dto.result === 'incomplete' && !note) {
      throw new AppError('VALIDATION_FAILED', 'ระบุว่าไม่ครบอย่างไร', [
        { field: 'note', reason: 'required' },
      ]);
    }
    await this.intakes.update({
      where: { id: intake.id },
      data: {
        answers: answer(readAnswers(intake.answers), {
          code: line.code,
          detail: line.detail,
          result: dto.result,
          note,
          by: actor.userId,
          at: now.toISOString(),
        }) as unknown as Prisma.InputJsonValue,
        updatedBy: actor.userId,
      },
    });
    return this.view(projectId, actor);
  }

  /**
   * Take the baseline again — the contract, the approved Solution, the
   * installments as they stand now. Lines whose detail changed are asked
   * again; the rest keep their verdict.
   */
  async refresh(projectId: string, actor: Principal, now = new Date()) {
    const { access, intake } = await this.editable(projectId, actor);
    const { missing } = await this.projects.rebuildBaseline(
      projectId,
      access.project.companyId,
      now,
    );
    await this.intakes.update({
      where: { id: intake.id },
      data: {
        history: [
          ...historyOf(intake.history),
          this.entry('refreshed', actor, intake.round, now, missing),
        ] as unknown as Prisma.InputJsonValue,
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'pm.intake.refreshed',
      companyId: access.project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { missing },
    });
    return this.view(projectId, actor);
  }

  /** Every line correct → the work is received. */
  async accept(projectId: string, actor: Principal, now = new Date()) {
    const { access, intake } = await this.editable(projectId, actor);
    const lines = await this.lines(access, intake);
    const problems = acceptProblems(lines);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    const deal = await this.dealOf(projectId);
    await this.transactions.execute(async (prisma) => {
      const claimed = await this.intakes.updateMany(
        {
          where: { id: intake.id, status: { not: 'accepted' } },
          data: {
            status: 'accepted',
            accepted: lines as unknown as Prisma.InputJsonValue,
            acceptedBy: actor.userId,
            acceptedAt: now,
            history: [
              ...historyOf(intake.history),
              this.entry('accepted', actor, intake.round, now, []),
            ] as unknown as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (claimed.count !== 1) {
        throw new AppError('CONFLICT', 'รับมอบงานนี้ไปแล้ว');
      }
      await this.audit.record(
        {
          eventType: 'pm.intake.accepted',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { round: intake.round, lines: lines.length },
        },
        { prisma },
      );
      await this.publish(
        deal,
        `${access.project.projectNo}: ผู้จัดการโครงการรับมอบงานแล้ว`,
        'opportunity.project_intake_accepted',
        actor,
        prisma,
      );
    });
    const told = deal?.ownerUserId ? [deal.ownerUserId] : [];
    for (const userId of told) {
      if (userId === actor.userId) continue;
      await this.notifications
        .projectIntakeAccepted(userId, access.project.companyId, {
          project: access.project,
        })
        .catch((error: Error) =>
          this.logger.warn(`intake notice not sent: ${error.message}`),
        );
    }
    return this.view(projectId, actor);
  }

  /**
   * Send the work back: each side is told its own incomplete lines. The
   * project waits as returned until the manager receives it.
   */
  async returnWork(
    projectId: string,
    dto: ReturnIntakeDto,
    actor: Principal,
    now = new Date(),
  ) {
    const { access, intake } = await this.editable(projectId, actor);
    const lines = await this.lines(access, intake);
    const gaps = gapsByGroup(lines);
    if (!gaps.size) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ทำเครื่องหมาย "ไม่ครบ" พร้อมเหตุผลอย่างน้อยหนึ่งข้อก่อนตีกลับ',
      );
    }
    const note = dto.note?.trim() || null;
    const round = intake.round + 1;
    const gapLines = [...gaps.values()].flat().map(gapText);
    const deal = await this.dealOf(projectId);
    const recipients = await this.recipients(projectId, access, deal);

    await this.transactions.execute(async (prisma) => {
      await this.intakes.update(
        {
          where: { id: intake.id },
          data: {
            status: 'returned',
            round,
            history: [
              ...historyOf(intake.history),
              this.entry('returned', actor, round, now, gapLines),
            ] as unknown as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.intake.returned',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            round,
            note,
            gaps: Object.fromEntries(
              [...gaps].map(([group, rows]) => [group, rows.map(gapText)]),
            ),
          },
        },
        { prisma },
      );
      await this.publish(
        deal,
        `${access.project.projectNo}: ผู้จัดการโครงการตีกลับงาน — ${gapLines.join(' · ')}`.slice(
          0,
          300,
        ),
        'opportunity.project_intake_returned',
        actor,
        prisma,
      );
    });

    // each side its own gaps
    for (const [group, rows] of gaps) {
      for (const userId of recipients[group]) {
        if (userId === actor.userId) continue;
        await this.notifications
          .projectIntakeReturned(userId, access.project.companyId, {
            project: access.project,
            side: GROUP_LABELS[group],
            gaps: rows.map(gapText).join(' · '),
            note,
          })
          .catch((error: Error) =>
            this.logger.warn(`intake notice not sent: ${error.message}`),
          );
      }
    }
    return this.view(projectId, actor);
  }

  // --- helpers -------------------------------------------------------------------

  private async row(projectId: string) {
    return (await this.intakes.findFirst({
      where: { projectId },
      select: {
        id: true,
        status: true,
        answers: true,
        round: true,
        history: true,
        acceptedBy: true,
        acceptedAt: true,
      },
    })) as IntakeRow | null;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'รับมอบงานได้เฉพาะผู้จัดการโครงการ ของโครงการที่ยังดำเนินอยู่',
      );
    }
    const intake = await this.row(projectId);
    if (!intake) throw new AppError('NOT_FOUND', 'โครงการนี้ไม่มีการรับมอบงาน');
    if (intake.status === 'accepted') {
      throw new AppError('CONFLICT', 'รับมอบงานนี้ไปแล้ว');
    }
    return { access, intake };
  }

  /** The lines as they stand now, with the manager's verdicts. */
  private async lines(
    access: Access,
    intake: IntakeRow,
  ): Promise<IntakeLineState[]> {
    const facts = await this.facts(access.project.id);
    const [handover, config] = await Promise.all([
      facts.opportunityId
        ? (this.handovers.findFirst({
            where: { opportunityId: facts.opportunityId },
            select: { status: true, round: true, items: true },
          }) as Promise<{
            status: string;
            round: number;
            items: unknown;
          } | null>)
        : Promise.resolve(null),
      this.configs.findFirst({
        where: { companyId: access.project.companyId },
        select: { projectIntakeChecklist: true },
      }) as Promise<{ projectIntakeChecklist: string[] | null } | null>,
    ]);
    const sources: IntakeSources = {
      handover: handover
        ? {
            status: handover.status,
            round: handover.round,
            // the items as the salesperson last saved them (CD-84)
            items: Array.isArray(handover.items)
              ? (handover.items as {
                  code: string;
                  label: string;
                  checked: boolean;
                  detail: string | null;
                }[])
              : [],
          }
        : null,
      baseline: facts.baseline ?? {},
      missing: facts.missing,
      companyLines: config?.projectIntakeChecklist ?? [],
    };
    return withAnswers(intakeLines(sources), readAnswers(intake.answers));
  }

  private async facts(projectId: string) {
    return (await this.projectRows.findFirst({
      where: { id: projectId },
      select: {
        opportunityId: true,
        solutionVersionId: true,
        baseline: true,
        missing: true,
      },
    })) as ProjectFacts;
  }

  private async dealOf(projectId: string): Promise<Deal | null> {
    const facts = await this.facts(projectId);
    if (!facts.opportunityId) return null;
    return await this.opportunities.findFirst({
      where: { id: facts.opportunityId },
      select: {
        id: true,
        companyId: true,
        customerId: true,
        opportunityCode: true,
        ownerUserId: true,
      },
    });
  }

  /** Who answers for each group's lines. */
  private async recipients(
    projectId: string,
    access: Access,
    deal: Deal | null,
  ): Promise<Record<IntakeGroup, string[]>> {
    const facts = await this.facts(projectId);
    const handover = facts.opportunityId
      ? ((await this.handovers.findFirst({
          where: { opportunityId: facts.opportunityId },
          select: { submittedBy: true },
        })) as { submittedBy: string | null } | null)
      : null;
    const version = facts.solutionVersionId
      ? ((await this.versions.findFirst({
          where: { id: facts.solutionVersionId },
          select: { createdBy: true, lockedBy: true },
        })) as { createdBy: string; lockedBy: string | null } | null)
      : null;
    const unique = (ids: (string | null | undefined)[]) => [
      ...new Set(ids.filter((id): id is string => Boolean(id))),
    ];
    const sales = unique([deal?.ownerUserId, handover?.submittedBy]);
    return {
      sales,
      company: sales,
      // no approved Solution → Sales chases it
      technical: version
        ? unique([version.createdBy, version.lockedBy])
        : sales,
      contract: unique([access.project.contract.ownerUserId]),
    };
  }

  private entry(
    action: IntakeHistoryEntry['action'],
    actor: Principal,
    round: number,
    now: Date,
    lines: string[],
  ): IntakeHistoryEntry {
    return {
      action,
      at: now.toISOString(),
      by: actor.userId,
      byName: actor.displayName,
      round,
      lines,
    };
  }

  private async publish(
    deal: Deal | null,
    summary: string,
    eventType: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
  ) {
    if (!deal?.customerId) return;
    await this.timeline.publish(
      {
        companyId: deal.companyId,
        customerId: deal.customerId,
        refType: 'opportunity',
        refId: deal.id,
        eventType,
        summary,
        actorId: auditActor(actor).actorId,
        actorName: actor.displayName,
      },
      { prisma },
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
