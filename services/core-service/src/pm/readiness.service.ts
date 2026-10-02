import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { bangkokDay } from '../crm/kyc-rules';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { NotificationsService } from '../notifications/notifications.service';
import { CheckReadinessDto, SaveReadinessItemDto } from './dto/project.dto';
import {
  checkProblems,
  DEFAULT_READINESS_CHECKLIST,
  fromChecklist,
  MAX_READINESS_ITEMS,
  MAX_READINESS_TEXT,
  readiness,
  systemChecks,
} from './readiness-rules';
import {
  ProjectIssueRepository,
  ProjectReadinessItemRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { TestsService } from './tests.service';
import { AsBuiltService } from './as-built.service';
import { UatService } from './uat.service';

interface LineRow {
  id: string;
  seq: number;
  text: string;
  inspectorUserId: string | null;
  result: string | null;
  checkedOn: Date | null;
  note: string | null;
  checkedBy: string | null;
  checkedAt: Date | null;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-225 ตรวจความพร้อมก่อนส่งมอบ — the last look before handover: the
 * company checklist copied into the project when the manager starts the
 * check (lines added or removed per project), each line passed or failed by
 * the inspector the manager named, on a date; and the checks the system
 * makes itself — every test passed (CD-221), no issue open. All of it holds
 * = ready, which is what acceptance (CD-189) asks for.
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager starts it, edits the lines and names inspectors; a
 * line's inspector (or the manager) records its result.
 */
@Injectable()
export class ReadinessService {
  private readonly logger = new Logger(ReadinessService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly lines: ProjectReadinessItemRepository,
    private readonly issues: ProjectIssueRepository,
    private readonly tests: TestsService,
    private readonly asBuilt: AsBuiltService,
    private readonly uat: UatService,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [rows, state] = await Promise.all([
      this.rows(projectId),
      this.state(projectId, access.project.companyId),
    ]);
    const names = await this.displayNames(
      rows.flatMap((row) => [row.inspectorUserId, row.checkedBy]),
    );
    return {
      canEdit: access.canEdit,
      started: rows.length > 0,
      ...state,
      lines: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        text: row.text,
        inspectorUserId: row.inspectorUserId,
        inspectorName: row.inspectorUserId
          ? (names.get(row.inspectorUserId) ?? null)
          : null,
        result: row.result,
        checkedOn: day(row.checkedOn),
        note: row.note,
        checkedByName: row.checkedBy
          ? (names.get(row.checkedBy) ?? null)
          : null,
        checkedAt: row.checkedAt,
        mayCheck: this.mayCheck(access, row, actor),
      })),
    };
  }

  /** For acceptance (CD-189): ready or not, and what stands in the way. */
  async state(projectId: string, companyId: string) {
    const [rows, coverage, issuesOpen, asBuilt, uat] = await Promise.all([
      this.rows(projectId),
      this.tests.coverage(projectId),
      this.issues.count({ where: { projectId, status: 'open' } }),
      this.asBuilt.state(projectId, companyId),
      this.uat.state(projectId),
    ]);
    const checks = systemChecks({
      tests: coverage,
      issuesOpen,
      asBuilt: {
        complete: asBuilt.complete,
        missing:
          asBuilt.missingDocuments.length + asBuilt.openDeviations.length,
      },
      uatBlocking: uat.blocking,
    });
    return { checks, readiness: readiness(rows, checks) };
  }

  /** The company checklist, copied in once. */
  async start(projectId: string, actor: Principal) {
    const access = await this.editable(projectId, actor);
    if (await this.lines.count({ where: { projectId, deletedAt: null } })) {
      throw new AppError('CONFLICT', 'เริ่มตรวจความพร้อมแล้ว');
    }
    const config = (await this.configs.findFirst({
      where: { companyId: access.project.companyId },
      select: { projectReadinessChecklist: true },
    })) as { projectReadinessChecklist: string[] | null } | null;
    const template = fromChecklist(
      config?.projectReadinessChecklist ?? DEFAULT_READINESS_CHECKLIST,
    );
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectReadinessItem.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      await prisma.projectReadinessItem.createMany({
        data: template.map((text, index) => ({
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + index + 1,
          text,
          createdBy: actor.userId,
        })),
      });
      await this.audit.record(
        {
          eventType: 'pm.readiness.started',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { lines: template },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async add(projectId: string, dto: SaveReadinessItemDto, actor: Principal) {
    const access = await this.editable(projectId, actor);
    const text = this.textOf(dto.text);
    const inspector = dto.inspector_user_id || null;
    if (inspector) await this.assertPerson(access.project.companyId, inspector);
    const count = await this.lines.count({
      where: { projectId, deletedAt: null },
    });
    if (count >= MAX_READINESS_ITEMS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `รายการตรวจได้ไม่เกิน ${MAX_READINESS_ITEMS} ข้อ`,
      );
    }
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectReadinessItem.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectReadinessItem.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          text,
          inspectorUserId: inspector,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.readiness.line_added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { lineId: row.id, text, inspectorUserId: inspector },
        },
        { prisma },
      );
    });
    if (inspector) await this.tellInspector(access, inspector, text, actor);
    return this.view(projectId, actor);
  }

  /** New words or a new inspector; new words mean it is checked again. */
  async update(
    projectId: string,
    lineId: string,
    dto: SaveReadinessItemDto,
    actor: Principal,
  ) {
    const access = await this.editable(projectId, actor);
    const line = await this.requireLine(projectId, lineId);
    const text = dto.text === undefined ? undefined : this.textOf(dto.text);
    const inspector =
      dto.inspector_user_id === undefined
        ? undefined
        : dto.inspector_user_id || null;
    if (inspector) await this.assertPerson(access.project.companyId, inspector);
    const reworded = text !== undefined && text !== line.text;
    await this.transactions.execute(async (prisma) => {
      await this.lines.update(
        {
          where: { id: lineId },
          data: {
            text,
            inspectorUserId: inspector,
            ...(reworded
              ? {
                  result: null,
                  checkedOn: null,
                  note: null,
                  checkedBy: null,
                  checkedAt: null,
                }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.readiness.line_updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: {
            lineId,
            text: line.text,
            inspectorUserId: line.inspectorUserId,
            result: line.result,
          },
          after: { lineId, text, inspectorUserId: inspector, reworded },
        },
        { prisma },
      );
    });
    if (inspector && inspector !== line.inspectorUserId) {
      await this.tellInspector(access, inspector, text ?? line.text, actor);
    }
    return this.view(projectId, actor);
  }

  /** Off the checklist; the row stays, as every record does. */
  async remove(projectId: string, lineId: string, actor: Principal) {
    const access = await this.editable(projectId, actor);
    const line = await this.requireLine(projectId, lineId);
    await this.transactions.execute(async (prisma) => {
      await this.lines.update(
        {
          where: { id: lineId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.readiness.line_removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { lineId, text: line.text, result: line.result },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** The inspector's (or the manager's) verdict, dated. */
  async check(
    projectId: string,
    lineId: string,
    dto: CheckReadinessDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    const line = await this.requireLine(projectId, lineId);
    if (!this.mayCheck(access, line, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกผลตรวจได้เฉพาะผู้ตรวจที่ได้รับมอบหมาย หรือผู้จัดการโครงการ',
      );
    }
    const input = {
      result: (dto.result ?? '').trim(),
      checkedOn: dto.checked_on?.slice(0, 10) ?? null,
      note: (dto.note ?? '').trim(),
      today: bangkokDay(now),
    };
    const problems = checkProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'check', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.lines.update(
        {
          where: { id: lineId },
          data: {
            result: input.result,
            checkedOn: new Date(`${input.checkedOn}T00:00:00Z`),
            note: input.note || null,
            checkedBy: actor.userId,
            checkedAt: now,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.readiness.checked',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            lineId,
            text: line.text,
            result: input.result,
            checkedOn: input.checkedOn,
            note: input.note || null,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async rows(projectId: string) {
    return (await this.lines.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { seq: 'asc' },
      select: {
        id: true,
        seq: true,
        text: true,
        inspectorUserId: true,
        result: true,
        checkedOn: true,
        note: true,
        checkedBy: true,
        checkedAt: true,
      },
    })) as LineRow[];
  }

  private async requireLine(projectId: string, lineId: string) {
    const line = (await this.lines.findFirst({
      where: { id: lineId, projectId, deletedAt: null },
    })) as LineRow | null;
    if (!line) throw new AppError('NOT_FOUND', 'ไม่พบรายการตรวจ');
    return line;
  }

  private mayCheck(
    access: Access,
    line: { inspectorUserId: string | null },
    actor: Principal,
  ) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return running && (access.canEdit || line.inspectorUserId === actor.userId);
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'จัดรายการตรวจความพร้อมได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    return access;
  }

  private textOf(value: string | undefined) {
    const text = (value ?? '').trim();
    if (!text || text.length > MAX_READINESS_TEXT) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ต้องระบุรายการตรวจ (ไม่เกิน ${MAX_READINESS_TEXT} ตัวอักษร)`,
      );
    }
    return text;
  }

  private async assertPerson(companyId: string, userId: string) {
    const found = await this.people.count({
      where: { id: userId, companies: { some: { companyId } } },
    });
    if (!found) {
      throw new AppError('VALIDATION_FAILED', 'ผู้ตรวจไม่ได้อยู่ในบริษัทนี้', [
        { field: 'inspector_user_id', reason: 'not_found' },
      ]);
    }
  }

  private async tellInspector(
    access: Access,
    userId: string,
    text: string,
    actor: Principal,
  ) {
    if (userId === actor.userId) return;
    await this.notifications
      .readinessAssigned(userId, access.project.companyId, access.project, text)
      .catch((error: Error) =>
        this.logger.warn(`readiness notice not sent: ${error.message}`),
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
