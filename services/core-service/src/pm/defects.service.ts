import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { bangkokDay } from '../crm/kyc-rules';
import {
  defectMove,
  defectProblems,
  MAX_DEFECT_TEXT,
  OPEN_DEFECT,
  proves,
} from './defect-rules';
import { devSources } from './dev-plan-rules';
import { MoveDefectDto, SaveDefectDto } from './dto/project.dto';
import {
  ProjectChangeRequestRepository,
  ProjectDefectRepository,
  ProjectRepository,
  ProjectTaskRepository,
  ProjectTestItemRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { TaskEvidenceService } from './task-evidence.service';
import { testState } from './test-rules';

interface DefectRow {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  severity: string;
  sowRef: string;
  taskId: string | null;
  foundOn: Date;
  assigneeUserId: string | null;
  status: string;
  fixNote: string | null;
  fixedAt: Date | null;
  fixedBy: string | null;
  verifyNote: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  reopenNote: string | null;
  cancelNote: string | null;
  createdBy: string;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-213 ติดตามงานพัฒนาและข้อบกพร่อง — software work and its defects, line
 * by line of the SOW: each line shows its development task (CD-212), how
 * many of its test items (CD-221) passed, and the defects still open; a
 * line not yet proved stays on the list, as installation points do. A
 * defect is fixed (how), then closed only by a retest — or reopened when
 * the retest fails; while it is open the line's task cannot close (CD-218).
 *
 * Who: whoever sees the project reads it; the team records defects, fixes
 * and retests while the project runs; the manager cancels one.
 */
@Injectable()
export class DefectsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly changes: ProjectChangeRequestRepository,
    private readonly tasks: ProjectTaskRepository,
    private readonly testItems: ProjectTestItemRepository,
    private readonly defects: ProjectDefectRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly evidence: TaskEvidenceService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [sources, rows, devTasks, tests] = await Promise.all([
      this.sources(projectId),
      this.rows(projectId),
      this.tasks.findMany({
        where: { projectId, devKind: 'item', status: { not: 'cancelled' } },
        select: { id: true, title: true, status: true, sowRef: true },
      }) as Promise<
        { id: string; title: string; status: string; sowRef: string | null }[]
      >,
      this.testItems.findMany({
        where: { projectId, deletedAt: null, sourceRef: { not: null } },
        select: {
          sourceRef: true,
          waivedAt: true,
          runs: {
            orderBy: { testedAt: 'desc' },
            take: 1,
            select: { result: true },
          },
        },
      }) as unknown as Promise<
        {
          sourceRef: string | null;
          waivedAt: Date | null;
          runs: { result: string }[];
        }[]
      >,
    ]);
    const names = await this.displayNames(
      rows.flatMap((row) => [row.assigneeUserId, row.fixedBy, row.verifiedBy]),
    );
    const label = new Map(sources.map((row) => [row.ref, row.text]));
    // the SOW lines software work or a defect touches, each with its proof
    const lines = sources
      .filter(
        (source) =>
          devTasks.some((task) => task.sowRef === source.ref) ||
          rows.some((row) => row.sowRef === source.ref),
      )
      .map((source) => {
        const proof = tests
          .filter((item) => proves(item.sourceRef, source.ref))
          .map((item) => testState(item));
        const task = devTasks.find((row) => row.sowRef === source.ref) ?? null;
        const open = rows.filter(
          (row) =>
            row.sowRef === source.ref &&
            (OPEN_DEFECT as readonly string[]).includes(row.status),
        ).length;
        const passed = proof.filter(
          (state) => state === 'passed' || state === 'waived',
        ).length;
        return {
          ref: source.ref,
          text: source.text,
          task: task
            ? { id: task.id, title: task.title, status: task.status }
            : null,
          tests: proof.length,
          passed,
          openDefects: open,
          pending: !proof.length || passed < proof.length || open > 0,
        };
      });
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      choices: sources.map((row) => ({ ref: row.ref, text: row.text })),
      lines,
      pending: lines.filter((line) => line.pending).length,
      open: rows.filter((row) =>
        (OPEN_DEFECT as readonly string[]).includes(row.status),
      ).length,
      defects: rows.map((row) => ({
        id: row.id,
        label: `BUG-${row.seq}`,
        title: row.title,
        description: row.description,
        severity: row.severity,
        sowRef: row.sowRef,
        sowText: label.get(row.sowRef) ?? null,
        foundOn: day(row.foundOn),
        assigneeUserId: row.assigneeUserId,
        assigneeName: row.assigneeUserId
          ? (names.get(row.assigneeUserId) ?? null)
          : null,
        status: row.status,
        fixNote: row.fixNote,
        fixedAt: row.fixedAt,
        fixedByName: row.fixedBy ? (names.get(row.fixedBy) ?? null) : null,
        verifyNote: row.verifyNote,
        verifiedAt: row.verifiedAt,
        verifiedByName: row.verifiedBy
          ? (names.get(row.verifiedBy) ?? null)
          : null,
        reopenNote: row.reopenNote,
        cancelNote: row.cancelNote,
      })),
    };
  }

  async add(
    projectId: string,
    dto: SaveDefectDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const sowRef = (dto.sow_ref ?? '').trim();
    const input = {
      title: (dto.title ?? '').trim(),
      description: dto.description?.trim().slice(0, MAX_DEFECT_TEXT) || null,
      severity: dto.severity ?? '',
      sowRef,
      foundOn: dto.found_on?.slice(0, 10) || null,
      assigneeUserId: dto.assignee_user_id || null,
    };
    const problems = defectProblems({
      ...input,
      knownRefs: (await this.sources(projectId)).map((row) => row.ref),
      today: bangkokDay(now),
    });
    if (input.assigneeUserId) {
      const found = await this.people.count({
        where: {
          id: input.assigneeUserId,
          companies: { some: { companyId: access.project.companyId } },
        },
      });
      if (!found) problems.push('ผู้รับผิดชอบไม่ได้อยู่ในบริษัทนี้');
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'defect', reason })),
      );
    }
    // the line's software task, when there is one
    const task = (await this.tasks.findFirst({
      where: {
        projectId,
        devKind: 'item',
        sowRef,
        status: { not: 'cancelled' },
      },
      select: { id: true },
    })) as { id: string } | null;
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectDefect.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectDefect.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          ...input,
          foundOn: new Date(`${input.foundOn}T00:00:00Z`),
          taskId: task?.id ?? null,
          createdBy: actor.userId,
        },
        select: { id: true, seq: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.defect.added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            defectId: row.id,
            label: `BUG-${row.seq}`,
            title: input.title,
            severity: input.severity,
            sowRef,
          },
        },
        { prisma },
      );
    });
    // a done task whose line now has a defect is reopened
    await this.evidence.syncLine(projectId, sowRef, actor, now);
    return this.view(projectId, actor);
  }

  /** Fix, verify by retest, reopen on a failed retest, or cancel. */
  async move(
    projectId: string,
    defectId: string,
    dto: MoveDefectDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireDefect(projectId, defectId);
    const note = (dto.note ?? '').trim().slice(0, MAX_DEFECT_TEXT);
    const { problems, to } = defectMove({
      action: dto.action,
      status: current.status,
      note,
      canEdit: access.canEdit,
    });
    if (problems.length || !to) {
      throw new AppError(
        problems.some((reason) => reason.includes('เฉพาะ'))
          ? 'FORBIDDEN'
          : 'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'action', reason })),
      );
    }
    const data =
      dto.action === 'fix'
        ? { fixNote: note, fixedAt: now, fixedBy: actor.userId }
        : dto.action === 'verify'
          ? { verifyNote: note, verifiedAt: now, verifiedBy: actor.userId }
          : dto.action === 'reopen'
            ? { reopenNote: note }
            : { cancelNote: note };
    await this.transactions.execute(async (prisma) => {
      await prisma.projectDefect.update({
        where: { id: defectId },
        data: { ...data, status: to, updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: `pm.defect.${dto.action}`,
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { defectId, status: current.status },
          after: { defectId, status: to, note },
        },
        { prisma },
      );
    });
    await this.evidence.syncLine(projectId, current.sowRef, actor, now);
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async sources(projectId: string) {
    const [project, approved] = await Promise.all([
      this.projectRows.findFirst({
        where: { id: projectId },
        select: { baseline: true },
      }) as Promise<{ baseline: unknown } | null>,
      this.changes.findMany({
        where: { projectId, status: 'approved' },
        orderBy: { seq: 'asc' },
        select: { id: true, seq: true, scopeAdded: true },
      }) as Promise<{ id: string; seq: number; scopeAdded: string | null }[]>,
    ]);
    return devSources(project?.baseline ?? null, approved);
  }

  private async rows(projectId: string) {
    return (await this.defects.findMany({
      where: { projectId },
      orderBy: { seq: 'asc' },
    })) as DefectRow[];
  }

  private async requireDefect(projectId: string, defectId: string) {
    const row = (await this.defects.findFirst({
      where: { id: defectId, projectId },
    })) as DefectRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบข้อบกพร่อง');
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกข้อบกพร่องได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private mayWrite(access: Access, actor: Principal) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return (
      running &&
      (access.canEdit ||
        access.project.members.some((member) => member.userId === actor.userId))
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
