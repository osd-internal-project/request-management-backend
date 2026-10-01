import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  budgetTotals,
  cleanLines,
  draftFromBaseline,
  lockProblems,
  type BudgetLine,
} from './budget-rules';
import { SaveBudgetDto } from './dto/project.dto';
import {
  ProjectBudgetRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface BudgetRow {
  id: string;
  versionNo: number;
  status: string;
  lines: unknown;
  total: Prisma.Decimal;
  contractValue: Prisma.Decimal | null;
  note: string | null;
  changeRequestId: string | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
}

const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);
const readLines = (value: unknown): BudgetLine[] =>
  Array.isArray(value) ? (value as BudgetLine[]) : [];

/**
 * CD-179 งบอ้างอิง — the budget the project is held to: drawn from what
 * was sold (the baseline's BOQ costs and labour), completed by the
 * manager while a draft, then locked. A locked budget changes only through
 * a change request (CD-185), which writes the next version. Actual cost
 * to compare against comes from SAP (CD-190).
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager drafts and locks it.
 */
@Injectable()
export class BudgetService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly budgets: ProjectBudgetRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const { canEdit } = await this.projects.access(projectId, actor);
    const rows = await this.rows(projectId);
    const current =
      rows.find((row) => row.status === 'draft') ??
      rows.find((row) => row.status === 'locked') ??
      null;
    const names = await this.displayNames(
      rows.flatMap((row) => [row.createdBy, row.lockedBy]),
    );
    return {
      canEdit,
      current: current ? this.present(current, names) : null,
      versions: rows.map((row) => ({
        id: row.id,
        versionNo: row.versionNo,
        status: row.status,
        total: Number(row.total),
        changeRequestId: row.changeRequestId,
        lockedAt: row.lockedAt,
        lockedByName: row.lockedBy ? (names.get(row.lockedBy) ?? null) : null,
      })),
      // CD-190 — actual cost from SAP is not connected yet
      actual: null,
    };
  }

  /** The first draft, from the baseline — once per project. */
  async start(projectId: string, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    if (await this.budgets.count({ where: { projectId } })) {
      throw new AppError('CONFLICT', 'โครงการนี้มีงบอ้างอิงแล้ว');
    }
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { baseline: true, contractValue: true },
    })) as {
      baseline: Parameters<typeof draftFromBaseline>[0];
      contractValue: Prisma.Decimal | null;
    } | null;
    const lines = draftFromBaseline(row?.baseline ?? null);
    const contractValue = num(row?.contractValue ?? null);
    await this.transactions.execute(async (prisma) => {
      const created = (await this.budgets.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            versionNo: 1,
            lines: lines as unknown as Prisma.InputJsonValue,
            total: budgetTotals(lines, contractValue).total,
            contractValue,
            createdBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'pm.budget.drafted',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_budget',
          resourceId: created.id,
          after: { projectId, versionNo: 1, lines: lines.length },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async saveDraft(projectId: string, dto: SaveBudgetDto, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const draft = await this.requireDraft(projectId);
    const { lines, problems } = cleanLines(dto.lines);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    const totals = budgetTotals(lines, num(draft.contractValue));
    await this.transactions.execute(async (prisma) => {
      await this.budgets.update(
        {
          where: { id: draft.id },
          data: {
            lines: lines as unknown as Prisma.InputJsonValue,
            total: totals.total,
            ...(dto.note !== undefined
              ? { note: dto.note.trim() || null }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.budget.saved',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_budget',
          resourceId: draft.id,
          before: { total: Number(draft.total) },
          after: { total: totals.total, lines: lines.length },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Locked: from now on it changes only through a change request. */
  async lock(projectId: string, actor: Principal, now = new Date()) {
    const { project } = await this.editable(projectId, actor);
    const draft = await this.requireDraft(projectId);
    const problems = lockProblems(readLines(draft.lines));
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const updated = await prisma.projectBudget.updateMany({
        where: { id: draft.id, status: 'draft' },
        data: { status: 'locked', lockedAt: now, lockedBy: actor.userId },
      });
      if (!updated.count) {
        throw new AppError('CONFLICT', 'งบนี้ยืนยันไปแล้ว');
      }
      // the version it replaces, if a change request wrote this one
      await prisma.projectBudget.updateMany({
        where: { projectId, status: 'locked', id: { not: draft.id } },
        data: { status: 'superseded' },
      });
      await this.audit.record(
        {
          eventType: 'pm.budget.locked',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_budget',
          resourceId: draft.id,
          after: { versionNo: draft.versionNo, total: Number(draft.total) },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -------------------------------------------------------------------

  private present(row: BudgetRow, names: Map<string, string>) {
    const lines = readLines(row.lines);
    return {
      id: row.id,
      versionNo: row.versionNo,
      status: row.status,
      lines,
      contractValue: num(row.contractValue),
      ...budgetTotals(lines, num(row.contractValue)),
      note: row.note,
      changeRequestId: row.changeRequestId,
      createdAt: row.createdAt,
      createdByName: names.get(row.createdBy) ?? null,
      updatedAt: row.updatedAt,
      lockedAt: row.lockedAt,
      lockedByName: row.lockedBy ? (names.get(row.lockedBy) ?? null) : null,
      lockProblems: row.status === 'draft' ? lockProblems(lines) : [],
    };
  }

  private async rows(projectId: string) {
    return (await this.budgets.findMany({
      where: { projectId },
      orderBy: { versionNo: 'desc' },
    })) as BudgetRow[];
  }

  private async requireDraft(projectId: string) {
    const row = (await this.budgets.findFirst({
      where: { projectId, status: 'draft' },
    })) as BudgetRow | null;
    if (!row) {
      throw new AppError(
        'CONFLICT',
        'ไม่มีร่างงบ — งบที่ยืนยันแล้วเปลี่ยนได้ผ่านคำขอเปลี่ยนแปลงเท่านั้น',
      );
    }
    return row;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'จัดทำงบได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
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
