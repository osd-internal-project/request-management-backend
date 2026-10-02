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
import { NotificationsService } from '../notifications/notifications.service';
import { MoveUatDto, SaveUatFindingDto } from './dto/project.dto';
import {
  ProjectTestItemRepository,
  ProjectUatFindingRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import {
  findingProblems,
  MAX_UAT_TEXT,
  moveProblems,
  uatState,
} from './uat-rules';

interface FindingRow {
  id: string;
  seq: number;
  title: string;
  description: string | null;
  severity: string;
  testItemId: string | null;
  reportedBy: string | null;
  reportedOn: Date;
  ownerUserId: string | null;
  status: string;
  fixNote: string | null;
  fixedAt: Date | null;
  fixedBy: string | null;
  confirmedByName: string | null;
  confirmedOn: Date | null;
  deferReason: string | null;
  reopenNote: string | null;
  createdBy: string;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDay = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`);

/**
 * CD-222 สนับสนุน UAT — what the customer finds while testing, how serious
 * each point is, and where its fix stands: fixed (how), then confirmed by
 * the customer (who, when) — or reopened when they do not accept it. A
 * major or minor point may be deferred past acceptance by the manager, with
 * the reason; a blocker may not, and until the customer confirms its fix
 * the readiness review (CD-225) does not pass.
 *
 * Who: whoever sees the project reads it; the team records points, fixes
 * and confirmations; `pm.project.manage` or the project's manager defers.
 */
@Injectable()
export class UatService {
  private readonly logger = new Logger(UatService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly findings: ProjectUatFindingRepository,
    private readonly testItems: ProjectTestItemRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [rows, tests] = await Promise.all([
      this.rows(projectId),
      this.testItems.findMany({
        where: { projectId, deletedAt: null },
        orderBy: { seq: 'asc' },
        select: { id: true, seq: true, text: true },
      }) as Promise<{ id: string; seq: number; text: string }[]>,
    ]);
    const names = await this.displayNames(
      rows.flatMap((row) => [row.ownerUserId, row.fixedBy]),
    );
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      ...this.stateOf(rows),
      tests: tests.map((row) => ({
        id: row.id,
        label: `T-${row.seq}: ${row.text}`,
      })),
      findings: rows.map((row) => {
        const test = tests.find((item) => item.id === row.testItemId);
        return {
          id: row.id,
          label: `U-${row.seq}`,
          title: row.title,
          description: row.description,
          severity: row.severity,
          testItem: test ? { id: test.id, label: `T-${test.seq}` } : null,
          reportedBy: row.reportedBy,
          reportedOn: day(row.reportedOn),
          ownerUserId: row.ownerUserId,
          ownerName: row.ownerUserId
            ? (names.get(row.ownerUserId) ?? null)
            : null,
          status: row.status,
          fixNote: row.fixNote,
          fixedAt: row.fixedAt,
          fixedByName: row.fixedBy ? (names.get(row.fixedBy) ?? null) : null,
          confirmedByName: row.confirmedByName,
          confirmedOn: day(row.confirmedOn),
          deferReason: row.deferReason,
          reopenNote: row.reopenNote,
        };
      }),
    };
  }

  /** For readiness (CD-225): the blockers not yet confirmed fixed. */
  async state(projectId: string) {
    return this.stateOf(await this.rows(projectId));
  }

  async add(
    projectId: string,
    dto: SaveUatFindingDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const input = await this.inputOf(projectId, access, dto, null, now);
    const created = await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectUatFinding.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectUatFinding.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          ...input,
          reportedOn: asDay(input.reportedOn),
          createdBy: actor.userId,
        },
        select: { id: true, seq: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.uat.raised',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            findingId: row.id,
            label: `U-${row.seq}`,
            title: input.title,
            severity: input.severity,
          },
        },
        { prisma },
      );
      return row;
    });
    if (input.ownerUserId) {
      await this.tellOwner(
        access,
        input.ownerUserId,
        created.seq,
        input.title,
        actor,
      );
    }
    return this.view(projectId, actor);
  }

  /** Its words, severity, owner — while it is open. */
  async update(
    projectId: string,
    findingId: string,
    dto: SaveUatFindingDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireFinding(projectId, findingId);
    if (current.status !== 'open') {
      throw new AppError('CONFLICT', 'แก้ได้เฉพาะประเด็นที่ยังเปิดอยู่');
    }
    const input = await this.inputOf(projectId, access, dto, current, now);
    await this.transactions.execute(async (prisma) => {
      await this.findings.update(
        {
          where: { id: findingId },
          data: {
            ...input,
            reportedOn: asDay(input.reportedOn),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.uat.updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: {
            findingId,
            title: current.title,
            severity: current.severity,
            ownerUserId: current.ownerUserId,
          },
          after: { findingId, ...input },
        },
        { prisma },
      );
    });
    if (input.ownerUserId && input.ownerUserId !== current.ownerUserId) {
      await this.tellOwner(
        access,
        input.ownerUserId,
        current.seq,
        input.title,
        actor,
      );
    }
    return this.view(projectId, actor);
  }

  /** fix · confirm · reopen · defer · undefer. */
  async move(
    projectId: string,
    findingId: string,
    action: string,
    dto: MoveUatDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireFinding(projectId, findingId);
    const note = (dto.note ?? '').trim().slice(0, MAX_UAT_TEXT);
    const confirmedOn = dto.confirmed_on?.slice(0, 10) ?? null;
    const { problems, to } = moveProblems({
      action,
      status: current.status,
      severity: current.severity,
      note,
      confirmedBy: dto.confirmed_by ?? '',
      confirmedOn,
      today: bangkokDay(now),
      canEdit: access.canEdit,
    });
    if (problems.length || !to) {
      throw new AppError(
        action === 'defer' || action === 'undefer'
          ? access.canEdit
            ? 'VALIDATION_FAILED'
            : 'FORBIDDEN'
          : 'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'uat', reason })),
      );
    }
    const data =
      action === 'fix'
        ? { fixNote: note, fixedAt: now, fixedBy: actor.userId }
        : action === 'confirm'
          ? {
              confirmedByName: (dto.confirmed_by ?? '').trim().slice(0, 255),
              confirmedOn: asDay(confirmedOn!),
            }
          : action === 'reopen'
            ? { reopenNote: note, confirmedByName: null, confirmedOn: null }
            : action === 'defer'
              ? { deferReason: note }
              : { deferReason: null };
    await this.transactions.execute(async (prisma) => {
      const claimed = await prisma.projectUatFinding.updateMany({
        where: { id: findingId, status: current.status },
        data: { ...data, status: to, updatedBy: actor.userId },
      });
      if (!claimed.count) {
        throw new AppError('CONFLICT', 'ประเด็นนี้เปลี่ยนสถานะไปแล้ว');
      }
      await this.audit.record(
        {
          eventType: `pm.uat.${action}`,
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { findingId, status: current.status },
          after: { findingId, status: to, note: note || null },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private stateOf(rows: FindingRow[]) {
    return uatState(
      rows.map((row) => ({
        label: `U-${row.seq}`,
        severity: row.severity,
        status: row.status,
      })),
    );
  }

  private async inputOf(
    projectId: string,
    access: Access,
    dto: SaveUatFindingDto,
    current: FindingRow | null,
    now: Date,
  ) {
    const input = {
      title: (dto.title ?? current?.title ?? '').trim(),
      description:
        dto.description === undefined
          ? (current?.description ?? null)
          : dto.description.trim().slice(0, MAX_UAT_TEXT) || null,
      severity: dto.severity ?? current?.severity ?? '',
      testItemId:
        dto.test_item_id === undefined
          ? (current?.testItemId ?? null)
          : dto.test_item_id || null,
      reportedBy:
        dto.reported_by === undefined
          ? (current?.reportedBy ?? null)
          : dto.reported_by.trim().slice(0, 255) || null,
      reportedOn:
        dto.reported_on?.slice(0, 10) ?? day(current?.reportedOn ?? null) ?? '',
      ownerUserId:
        dto.owner_user_id === undefined
          ? (current?.ownerUserId ?? null)
          : dto.owner_user_id || null,
    };
    const problems = findingProblems({
      title: input.title,
      severity: input.severity,
      reportedOn: input.reportedOn || null,
      today: bangkokDay(now),
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'uat', reason })),
      );
    }
    if (input.testItemId) {
      const found = await this.testItems.count({
        where: { id: input.testItemId, projectId },
      });
      if (!found) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบข้อทดสอบในโครงการนี้');
      }
    }
    if (input.ownerUserId) {
      const found = await this.people.count({
        where: {
          id: input.ownerUserId,
          companies: { some: { companyId: access.project.companyId } },
        },
      });
      if (!found) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ผู้รับผิดชอบไม่ได้อยู่ในบริษัทนี้',
        );
      }
    }
    return input;
  }

  private async rows(projectId: string) {
    return (await this.findings.findMany({
      where: { projectId },
      orderBy: { seq: 'asc' },
    })) as FindingRow[];
  }

  private async requireFinding(projectId: string, findingId: string) {
    const row = (await this.findings.findFirst({
      where: { id: findingId, projectId },
    })) as FindingRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบประเด็น UAT');
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกประเด็น UAT ได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
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

  private async tellOwner(
    access: Access,
    userId: string,
    seq: number,
    title: string,
    actor: Principal,
  ) {
    if (userId === actor.userId) return;
    await this.notifications
      .uatAssigned(
        userId,
        access.project.companyId,
        access.project,
        `U-${seq}`,
        title,
      )
      .catch((error: Error) =>
        this.logger.warn(`UAT notice not sent: ${error.message}`),
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
