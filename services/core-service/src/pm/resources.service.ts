import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { approvalStateOf } from '../crm/contract-terms';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { thaiToday } from '../crm/vendor-costs';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { AvailabilityService } from '../hr/availability.service';
import { HrBookingRepository } from '../hr/hr.repositories';
import type { DayAvailability } from '../hr/leave-rules';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import {
  BookResourceDto,
  SaveResourceRequestDto,
  WorkloadQueryDto,
} from './dto/project.dto';
import {
  ProjectBookingPriorityRepository,
  ProjectRepository,
  ProjectResourceRequestRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import {
  bookingClash,
  MAX_RESOURCE_TEXT,
  priorityProblems,
  resourceRequestProblems,
  weeklyLoad,
} from './resource-rules';

interface BookingRow {
  id: string;
  userId: string;
  startDate: Date;
  endDate: Date;
  hoursPerDay: unknown;
  note: string;
  createdBy: string;
}

interface RequestRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  role: string;
  skillId: string | null;
  headcount: number;
  startDate: Date;
  endDate: Date;
  hoursPerDay: unknown;
  note: string | null;
  status: string;
  requestId: string | null;
  error: string | null;
  submittedAt: Date | null;
  submittedBy: string | null;
  decidedAt: Date | null;
  fulfilledAt: Date | null;
  createdBy: string;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date) => value.toISOString().slice(0, 10);
const addDays = (value: string, days: number) =>
  new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
/** CD-232 answers at most 92 days at a time. */
const WINDOW = 92;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * CD-180 จัดสรรทรัพยากร — who works on the project and when (bookings,
 * CD-232), checked against everything else they are booked on and their
 * leave: a booking past what someone has free must say which project comes
 * first and why, and the managers of the projects it clashes with are told.
 * When the team is not enough, the manager asks for more people through the
 * request engine (CrmConfig.projectResourceTypeCode, PM → Engineer). Across
 * projects, the team's load shows week by week.
 *
 * Who: whoever sees the project reads its team; the manager (or
 * `pm.project.manage`) books, cancels and asks for people.
 */
@Injectable()
export class ResourcesService implements OnModuleInit {
  private readonly logger = new Logger(ResourcesService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly availability: AvailabilityService,
    private readonly bookings: HrBookingRepository,
    private readonly priorities: ProjectBookingPriorityRepository,
    private readonly resourceRequests: ProjectResourceRequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    for (const name of [
      DOMAIN_EVENTS.requestApproved,
      DOMAIN_EVENTS.requestCompleted,
      DOMAIN_EVENTS.requestRejected,
      DOMAIN_EVENTS.requestCancelled,
    ]) {
      this.events.on(name, (event) => {
        const payload = event.payload as { request_id?: string };
        if (!payload.request_id) return Promise.resolve();
        return this.syncRequest(payload.request_id).catch((error: Error) =>
          this.logger.warn(`resource request not synced: ${error.message}`),
        );
      });
    }
  }

  async view(projectId: string, actor: Principal, today = thaiToday()) {
    const access = await this.projects.access(projectId, actor);
    const companyId = access.project.companyId;
    const [rows, priorities, requests, typeCode] = await Promise.all([
      this.bookings.findMany({
        where: { companyId, projectId, cancelledAt: null },
        orderBy: [{ startDate: 'asc' }],
      }) as Promise<BookingRow[]>,
      this.priorities.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      }) as Promise<
        {
          bookingId: string;
          priority: string;
          reason: string;
          conflictProjectIds: string[];
        }[]
      >,
      this.requestRowsOf(projectId),
      this.typeCode(companyId),
    ]);
    // what still runs: the days each booking is past what is free
    const live = rows.filter((row) => day(row.endDate) >= today);
    const short = await this.shortDays(companyId, live, today);
    const names = await this.displayNames([
      ...rows.map((row) => row.userId),
      ...requests.flatMap((row) => [row.createdBy, row.submittedBy]),
    ]);
    const labels = await this.projectLabels(
      companyId,
      priorities.flatMap((row) => row.conflictProjectIds),
    );
    const requestNos = await this.requestNos(requests.map((r) => r.requestId));
    return {
      canEdit: access.canEdit,
      typeSet: Boolean(typeCode),
      bookings: rows.map((row) => {
        const priority = priorities.find((p) => p.bookingId === row.id);
        return {
          id: row.id,
          userId: row.userId,
          name: names.get(row.userId) ?? row.userId,
          startDate: day(row.startDate),
          endDate: day(row.endDate),
          hoursPerDay: Number(row.hoursPerDay),
          note: row.note,
          past: day(row.endDate) < today,
          overbookedDays: short.get(row.id) ?? 0,
          priority: priority
            ? {
                priority: priority.priority,
                reason: priority.reason,
                conflicts: priority.conflictProjectIds.map(
                  (id) => labels.get(id) ?? id,
                ),
              }
            : null,
        };
      }),
      requests: requests.map((row) => ({
        id: row.id,
        label: `RR-${row.seq}`,
        role: row.role,
        skillId: row.skillId,
        headcount: row.headcount,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        hoursPerDay: Number(row.hoursPerDay),
        note: row.note,
        status: row.status,
        requestNo: row.requestId
          ? (requestNos.get(row.requestId) ?? null)
          : null,
        error: row.error,
        submittedByName: row.submittedBy
          ? (names.get(row.submittedBy) ?? null)
          : null,
        decidedAt: row.decidedAt,
        fulfilledAt: row.fulfilledAt,
      })),
    };
  }

  /** Before booking: the days that would not fit, and whose projects. */
  async preview(projectId: string, dto: BookResourceDto, actor: Principal) {
    const access = await this.manager(projectId, actor);
    return this.clashOf(access, dto);
  }

  async book(projectId: string, dto: BookResourceDto, actor: Principal) {
    const access = await this.manager(projectId, actor);
    const clash = await this.clashOf(access, dto);
    const reason = (dto.reason ?? '').trim().slice(0, MAX_RESOURCE_TEXT);
    const problems = priorityProblems({
      overbooked: clash.overbooked.length,
      priority: dto.priority,
      reason,
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((why) => ({ field: 'priority', reason: why })),
      );
    }
    const created = await this.availability.createBooking(actor, {
      user_id: dto.user_id,
      project_id: projectId,
      start_date: dto.start_date,
      end_date: dto.end_date,
      hours_per_day: dto.hours_per_day,
      note: dto.note,
    });
    if (clash.overbooked.length) {
      const companyId = access.project.companyId;
      await this.transactions.execute(async (prisma) => {
        await prisma.projectBookingPriority.create({
          data: {
            companyId,
            projectId,
            bookingId: created.booking.id,
            userId: dto.user_id,
            priority: dto.priority!,
            reason,
            conflictProjectIds: clash.conflicts.map((row) => row.projectId),
            overbookedDays: clash.overbooked.length,
            createdBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            eventType: 'pm.resource.overbooked',
            companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              bookingId: created.booking.id,
              userId: dto.user_id,
              priority: dto.priority,
              reason,
              overbookedDays: clash.overbooked.length,
              conflictProjectIds: clash.conflicts.map((row) => row.projectId),
            },
          },
          { prisma },
        );
      });
      // the managers of the projects it clashes with
      const person = await this.displayNames([dto.user_id]);
      for (const other of clash.conflicts) {
        if (other.managerUserId === actor.userId) continue;
        await this.notifications
          .resourceConflict(other.managerUserId, companyId, {
            project: access.project,
            otherProject: other.label,
            person: person.get(dto.user_id) ?? dto.user_id,
            from: dto.start_date,
            to: dto.end_date,
            priority: dto.priority!,
            reason,
          })
          .catch(() => undefined);
      }
    }
    return this.view(projectId, actor);
  }

  async cancelBooking(projectId: string, bookingId: string, actor: Principal) {
    const access = await this.manager(projectId, actor);
    const found = await this.bookings.count({
      where: {
        id: bookingId,
        projectId,
        companyId: access.project.companyId,
        cancelledAt: null,
      },
    });
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบการจองที่ระบุ');
    await this.availability.cancelBooking(actor, bookingId);
    return this.view(projectId, actor);
  }

  // --- asking for more people -------------------------------------------------------

  /** Made and sent in one go; a send that fails stays a draft to retry. */
  async ask(
    projectId: string,
    dto: SaveResourceRequestDto,
    actor: Principal,
    authorization: string,
  ) {
    const access = await this.manager(projectId, actor);
    const input = {
      role: dto.role.trim(),
      headcount: dto.headcount,
      startDate: dto.start_date,
      endDate: dto.end_date,
      hoursPerDay: dto.hours_per_day,
    };
    const problems = resourceRequestProblems({ ...input, today: thaiToday() });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'resource_request', reason })),
      );
    }
    const id = await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectResourceRequest.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectResourceRequest.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          role: input.role,
          skillId: dto.skill_id || null,
          headcount: input.headcount,
          startDate: new Date(`${input.startDate}T00:00:00Z`),
          endDate: new Date(`${input.endDate}T00:00:00Z`),
          hoursPerDay: input.hoursPerDay,
          note: dto.note?.trim().slice(0, MAX_RESOURCE_TEXT) || null,
          createdBy: actor.userId,
        },
        select: { id: true, seq: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.resource.requested',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            resourceRequestId: row.id,
            label: `RR-${row.seq}`,
            ...input,
          },
        },
        { prisma },
      );
      return row.id;
    });
    return this.submit(projectId, id, actor, authorization);
  }

  async submit(
    projectId: string,
    resourceRequestId: string,
    actor: Principal,
    authorization: string,
    now = new Date(),
  ) {
    const access = await this.manager(projectId, actor);
    const row = await this.requireRequest(projectId, resourceRequestId);
    if (row.status !== 'draft') {
      throw new AppError('CONFLICT', 'คำขอนี้ส่งไปแล้ว');
    }
    const typeCode = await this.typeCode(access.project.companyId);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอทีมเพิ่มในหน้าตั้งค่า CRM — บันทึกเป็นร่างไว้แล้ว',
      );
    }
    const project = access.project;
    const label = `RR-${row.seq}`;
    let requestId: string | null = null;
    let error: string | null = null;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'project',
          ref_id: project.projectNo,
          form_data: {
            subject: `${project.projectNo} ขอทีมเพิ่ม ${label}: ${row.role} ${row.headcount} คน`,
            project_no: project.projectNo,
            resource_request_no: label,
            role: row.role,
            headcount: row.headcount,
            start_date: day(row.startDate),
            end_date: day(row.endDate),
            hours_per_day: Number(row.hoursPerDay),
            detail: [
              `${row.role} × ${row.headcount} คน`,
              `${day(row.startDate)} ถึง ${day(row.endDate)} วันละ ${Number(row.hoursPerDay)} ชม.`,
              row.note ?? '',
            ]
              .filter(Boolean)
              .join('\n'),
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
      await this.requests.submit(requestId, actor, authorization);
    } catch (failure) {
      error = requestId
        ? `สร้างร่างคำขอแล้วแต่ยื่นไม่ผ่าน: ${messageOf(failure)}`
        : `สร้างคำขอไม่ได้: ${messageOf(failure)}`;
    }
    if (!requestId) {
      await this.resourceRequests.update({
        where: { id: resourceRequestId },
        data: { error },
      });
      throw new AppError('CONFLICT', error ?? 'สร้างคำขอไม่ได้');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectResourceRequest.update({
        where: { id: resourceRequestId },
        data: {
          status: 'submitted',
          requestId,
          error,
          submittedAt: now,
          submittedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.resource.request_submitted',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { resourceRequestId, label, requestId },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Approved and the people booked: closed by the manager. */
  async fulfil(projectId: string, resourceRequestId: string, actor: Principal) {
    await this.manager(projectId, actor);
    const row = await this.requireRequest(projectId, resourceRequestId);
    if (row.status !== 'approved') {
      throw new AppError('CONFLICT', 'ปิดได้เฉพาะคำขอที่อนุมัติแล้ว');
    }
    await this.resourceRequests.update({
      where: { id: resourceRequestId },
      data: {
        status: 'fulfilled',
        fulfilledAt: new Date(),
        fulfilledBy: actor.userId,
      },
    });
    return this.view(projectId, actor);
  }

  /** A draft withdrawn. */
  async cancelRequest(
    projectId: string,
    resourceRequestId: string,
    actor: Principal,
  ) {
    await this.manager(projectId, actor);
    const row = await this.requireRequest(projectId, resourceRequestId);
    if (row.status !== 'draft') {
      throw new AppError('CONFLICT', 'ยกเลิกได้เฉพาะคำขอที่ยังเป็นร่าง');
    }
    await this.resourceRequests.update({
      where: { id: resourceRequestId },
      data: { status: 'cancelled' },
    });
    return this.view(projectId, actor);
  }

  /** The approvers' decision on a request for people. Once only. */
  async syncRequest(requestId: string, now = new Date()) {
    const row = (await this.resourceRequests.findFirst({
      where: { requestId, status: 'submitted' },
    })) as RequestRow | null;
    if (!row) return;
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { status: true },
    })) as { status: string } | null;
    const state = approvalStateOf(true, request);
    if (state !== 'approved' && state !== 'rejected') return;
    const claimed = await this.resourceRequests.updateMany({
      where: { id: row.id, status: 'submitted' },
      data: { status: state, decidedAt: now },
    });
    if (!claimed.count) return;
    await this.audit.record({
      eventType: `pm.resource.request_${state}`,
      companyId: row.companyId,
      actorId: null,
      actorUsername: 'system',
      resourceType: 'project',
      resourceId: row.projectId,
      after: { resourceRequestId: row.id, label: `RR-${row.seq}`, state },
    });
  }

  // --- across projects ---------------------------------------------------------------

  /** The team's load week by week — whom the caller may see (CD-232's rules). */
  async workload(actor: Principal, query: WorkloadQueryDto) {
    const weeks = Math.min(Math.max(Number(query.weeks) || 8, 1), 13);
    // from the Monday of the week asked for
    const at = Date.parse(`${query.from}T00:00:00Z`);
    if (Number.isNaN(at)) {
      throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง');
    }
    const weekday = new Date(at).getUTCDay() || 7;
    const from = addDays(query.from, 1 - weekday);
    const to = addDays(from, weeks * 7 - 1);
    const grid = await this.availability.availability(actor, {
      from,
      to,
      ...(query.skill_id ? { skill_id: query.skill_id } : {}),
    });
    return {
      from,
      to,
      weeks: Array.from({ length: weeks }, (_, i) => addDays(from, i * 7)),
      projects: grid.projects,
      people: grid.people.map((person) => {
        const { days, totals, ...rest } = person as typeof person & {
          days: DayAvailability[];
        };
        return { ...rest, totals, weeks: weeklyLoad(days) };
      }),
    };
  }

  // --- helpers -----------------------------------------------------------------------

  private async clashOf(access: Access, dto: BookResourceDto) {
    const companyId = access.project.companyId;
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(dto.start_date) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dto.end_date) ||
      dto.end_date < dto.start_date
    ) {
      throw new AppError('VALIDATION_FAILED', 'ช่วงวันที่ไม่ถูกต้อง');
    }
    const days = await this.daysOf(
      companyId,
      dto.user_id,
      dto.start_date,
      dto.end_date,
    );
    const clash = bookingClash(days, dto.hours_per_day, access.project.id);
    const projects = clash.conflictProjectIds.length
      ? ((await this.projectRows.findMany({
          where: { companyId, id: { in: clash.conflictProjectIds } },
          select: {
            id: true,
            projectNo: true,
            name: true,
            managerUserId: true,
          },
        })) as {
          id: string;
          projectNo: string;
          name: string;
          managerUserId: string;
        }[])
      : [];
    const managers = await this.displayNames(
      projects.map((row) => row.managerUserId),
    );
    return {
      overbooked: clash.overbooked,
      conflicts: projects.map((row) => ({
        projectId: row.id,
        label: `${row.projectNo} · ${row.name}`,
        managerUserId: row.managerUserId,
        managerName: managers.get(row.managerUserId) ?? null,
      })),
    };
  }

  /** One person's days over any stretch, 92 days at a time. */
  private async daysOf(
    companyId: string,
    userId: string,
    from: string,
    to: string,
  ) {
    const days: DayAvailability[] = [];
    for (let start = from; start <= to; start = addDays(start, WINDOW)) {
      const end =
        addDays(start, WINDOW - 1) < to ? addDays(start, WINDOW - 1) : to;
      const grid = await this.availability.availabilityFor(
        companyId,
        [userId],
        start,
        end,
      );
      days.push(...(grid.get(userId) ?? []));
    }
    return days;
  }

  /** Per booking still running: working days past what the person has free. */
  private async shortDays(
    companyId: string,
    rows: BookingRow[],
    today: string,
  ) {
    const short = new Map<string, number>();
    if (!rows.length) return short;
    const byUser = new Map<string, BookingRow[]>();
    for (const row of rows) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    }
    for (const [userId, own] of byUser) {
      const from = own
        .map((row) => day(row.startDate))
        .reduce((min, value) => (value < min ? value : min));
      const start = from < today ? today : from;
      const end = own
        .map((row) => day(row.endDate))
        .reduce((max, value) => (value > max ? value : max));
      // the near quarter is what a manager can still change
      const until =
        addDays(start, WINDOW - 1) < end ? addDays(start, WINDOW - 1) : end;
      if (until < start) continue;
      const days = await this.daysOf(companyId, userId, start, until);
      for (const row of own) {
        short.set(
          row.id,
          days.filter(
            (d) =>
              d.working &&
              d.free < 0 &&
              d.booked.some((b) => b.bookingId === row.id),
          ).length,
        );
      }
    }
    return short;
  }

  private async requestRowsOf(projectId: string) {
    return (await this.resourceRequests.findMany({
      where: { projectId, status: { not: 'cancelled' } },
      orderBy: { seq: 'desc' },
    })) as RequestRow[];
  }

  private async requireRequest(projectId: string, id: string) {
    const row = (await this.resourceRequests.findFirst({
      where: { id, projectId },
    })) as RequestRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบคำขอทีมเพิ่ม');
    return row;
  }

  private async typeCode(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { projectResourceTypeCode: true },
    })) as { projectResourceTypeCode: string | null } | null;
    return row?.projectResourceTypeCode ?? null;
  }

  private async manager(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'จัดทีมได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    return access;
  }

  private async projectLabels(companyId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.projectRows.findMany({
      where: { companyId, id: { in: unique } },
      select: { id: true, projectNo: true, name: true },
    })) as { id: string; projectNo: string; name: string }[];
    return new Map(
      rows.map((row) => [row.id, `${row.projectNo} · ${row.name}`]),
    );
  }

  private async requestNos(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.requestRows.findMany({
      where: { id: { in: unique } },
      select: { id: true, requestNo: true },
    })) as { id: string; requestNo: string | null }[];
    return new Map(rows.map((row) => [row.id, row.requestNo ?? row.id]));
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
