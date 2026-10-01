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
import { ChangeRequestsService } from './change-requests.service';
import { changeFromLog, logProblems, owesChange } from './customer-log-rules';
import { SaveCustomerLogDto } from './dto/project.dto';
import { ProjectCustomerLogRepository } from './project.repositories';
import { ProjectsService } from './projects.service';

interface LogRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  kind: string;
  occurredOn: Date;
  contactName: string | null;
  summary: string;
  decision: string | null;
  affectsScope: boolean;
  changeRequestId: string | null;
  createdAt: Date;
  createdBy: string;
}

const day = (value: Date) => value.toISOString().slice(0, 10);

/**
 * CD-186 ประสานงานลูกค้า — what passed with the customer that bears on the
 * project, and what they decided. A decision that changes the scope must
 * become a change request (CD-185): it stays flagged until it has, and the
 * count travels with the project (CD-191 will not close over it).
 *
 * Who: whoever sees the project reads the log; its manager, its team and
 * `pm.project.manage` write it — whoever deals with the customer.
 */
@Injectable()
export class CustomerLogsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly logs: ProjectCustomerLogRepository,
    private readonly changes: ChangeRequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const rows = (await this.logs.findMany({
      where: { projectId },
      orderBy: [{ occurredOn: 'desc' }, { seq: 'desc' }],
    })) as LogRow[];
    const [names, labels] = await Promise.all([
      this.displayNames(rows.map((row) => row.createdBy)),
      this.changes.labels(
        rows
          .map((row) => row.changeRequestId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]);
    return {
      canWrite: this.mayWrite(access, actor),
      canConvert: access.canEdit,
      owesChange: rows.filter(owesChange).length,
      logs: rows.map((row) => ({
        id: row.id,
        seq: row.seq,
        label: `C-${row.seq}`,
        kind: row.kind,
        occurredOn: day(row.occurredOn),
        contactName: row.contactName,
        summary: row.summary,
        decision: row.decision,
        affectsScope: row.affectsScope,
        owesChange: owesChange(row),
        changeRequest: row.changeRequestId
          ? {
              id: row.changeRequestId,
              label: labels.get(row.changeRequestId) ?? '',
            }
          : null,
        createdAt: row.createdAt,
        createdByName: names.get(row.createdBy) ?? null,
      })),
    };
  }

  async create(
    projectId: string,
    dto: SaveCustomerLogDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    this.assertWriter(access, actor);
    const input = this.inputOf(dto, null, now);
    await this.transactions.execute(async (prisma) => {
      const last = (await this.logs.findFirst(
        {
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const row = (await this.logs.create(
        {
          data: {
            companyId: access.project.companyId,
            projectId,
            seq: (last?.seq ?? 0) + 1,
            ...input,
            occurredOn: new Date(`${input.occurredOn}T00:00:00Z`),
            createdBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'pm.customer_log.created',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project_customer_log',
          resourceId: row.id,
          after: {
            projectId,
            kind: input.kind,
            affectsScope: input.affectsScope,
          },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor);
  }

  /** Corrected by whoever wrote it, or the manager — until it became a change. */
  async update(
    projectId: string,
    logId: string,
    dto: SaveCustomerLogDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    const current = await this.requireLog(projectId, logId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'แก้ได้เฉพาะผู้บันทึก ผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    if (current.changeRequestId) {
      throw new AppError(
        'CONFLICT',
        'บันทึกนี้แปลงเป็นคำขอเปลี่ยนแปลงแล้ว — แก้ที่คำขอแทน',
      );
    }
    const input = this.inputOf(dto, current, now);
    await this.transactions.execute(async (prisma) => {
      await this.logs.update(
        {
          where: { id: logId },
          data: {
            ...input,
            occurredOn: new Date(`${input.occurredOn}T00:00:00Z`),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.customer_log.updated',
          companyId: current.companyId,
          ...auditActor(actor),
          resourceType: 'project_customer_log',
          resourceId: logId,
          after: { ...dto },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor);
  }

  /** The scope decision becomes a change request draft (the manager's call). */
  async toChange(projectId: string, logId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'แปลงเป็นคำขอเปลี่ยนแปลงได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const current = await this.requireLog(projectId, logId);
    if (!current.affectsScope || !current.decision) {
      throw new AppError(
        'CONFLICT',
        'บันทึกนี้ไม่ได้เป็นการตัดสินใจที่กระทบขอบเขต',
      );
    }
    if (current.changeRequestId) {
      throw new AppError('CONFLICT', 'บันทึกนี้แปลงเป็นคำขอเปลี่ยนแปลงแล้ว');
    }
    const created = await this.changes.create(
      projectId,
      changeFromLog({
        seq: current.seq,
        occurredOn: day(current.occurredOn),
        contactName: current.contactName,
        decision: current.decision,
        summary: current.summary,
      }),
      actor,
    );
    await this.logs.update({
      where: { id: logId },
      data: { changeRequestId: created.changeId, updatedBy: actor.userId },
    });
    return {
      ...(await this.list(projectId, actor)),
      changeId: created.changeId,
    };
  }

  /** Decisions on the scope still owed a change request (for CD-191). */
  async owed(projectId: string): Promise<number> {
    return this.logs.count({
      where: { projectId, affectsScope: true, changeRequestId: null },
    });
  }

  // --- helpers -------------------------------------------------------------------

  private inputOf(dto: SaveCustomerLogDto, current: LogRow | null, now: Date) {
    const input = {
      kind: dto.kind ?? current?.kind ?? 'meeting',
      occurredOn:
        dto.occurred_on?.slice(0, 10) ??
        (current ? day(current.occurredOn) : null),
      contactName:
        dto.contact_name !== undefined
          ? dto.contact_name.trim() || null
          : (current?.contactName ?? null),
      summary: (dto.summary ?? current?.summary ?? '').trim(),
      decision:
        dto.decision !== undefined
          ? dto.decision.trim() || null
          : (current?.decision ?? null),
      affectsScope: dto.affects_scope ?? current?.affectsScope ?? false,
    };
    const problems = logProblems({ ...input, today: bangkokDay(now) });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'log', reason })),
      );
    }
    return input as typeof input & { occurredOn: string };
  }

  private mayWrite(
    access: Awaited<ReturnType<ProjectsService['access']>>,
    actor: Principal,
  ) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return (
      running &&
      (access.canEdit ||
        access.project.members.some((member) => member.userId === actor.userId))
    );
  }

  private assertWriter(
    access: Awaited<ReturnType<ProjectsService['access']>>,
    actor: Principal,
  ) {
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกการประสานงานได้เฉพาะทีมโครงการ ผู้จัดการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
  }

  private async requireLog(projectId: string, logId: string) {
    const row = (await this.logs.findFirst({
      where: { id: logId, projectId },
    })) as LogRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบบันทึกที่ระบุ');
    return row;
  }

  private async displayNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
