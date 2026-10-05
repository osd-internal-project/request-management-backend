import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Permission,
  Principal,
} from '@request-management/share';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HrBookingRepository,
  HrReportingRepository,
  HrWorkRefsRepository,
} from './hr.repositories';
import { AvailabilityQueryDto, CreateBookingDto } from './hr.dto';
import {
  availabilityDays,
  type BookingSpan,
  daysBetween,
  isDay,
  MAX_WINDOW_DAYS,
  overbookedDays,
  spanDays,
} from './leave-rules';
import { EmployeesService } from './employees.service';
import { LeavesService } from './leaves.service';

const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);
/** Who may look across the whole company (CD-230's staffing directory). */
const STAFFING: Permission[] = [
  'hr.employee.read',
  'hr.employee.manage',
  'pm.project.manage',
  'presales.solution.manage',
];
const MAX_BOOKING_DAYS = 366;

interface BookingRow {
  id: string;
  companyId: string;
  userId: string;
  projectId: string;
  startDate: Date;
  endDate: Date;
  hoursPerDay: Prisma.Decimal;
  note: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * CD-232 — availability (part of CD-17 HR).
 *
 * A working day holds 8 hours; leave (pending or approved) and bookings take
 * from it. A booking puts a person on a project for a stretch of days at so
 * many hours a working day; the project's manager, PM or HR makes it. Going
 * past what someone has free is allowed but answered with the days it
 * overruns — CD-180 (PM resource allocation) handles the clash.
 *
 * Who is visible: PM, Pre-Sales and HR see everyone (as in the staffing
 * directory); a supervisor their people; a project manager their project's
 * team; anyone themselves. Why someone is away (the kind of leave) shows
 * only to HR, their supervisors and themselves.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    private readonly bookings: HrBookingRepository,
    private readonly reporting: HrReportingRepository,
    private readonly refs: HrWorkRefsRepository,
    private readonly employees: EmployeesService,
    private readonly leaves: LeavesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
  ) {}

  async availability(actor: Principal, query: AvailabilityQueryDto) {
    const companyId = actor.activeCompanyId;
    window(query.from, query.to);
    const below = await this.reporting.subordinatesOf(actor.userId);
    const staffing = STAFFING.some((p) => actor.permissions.includes(p));
    const mine = new Set([actor.userId, ...below]);

    let ids: string[] | undefined;
    if (query.project_id) {
      const project = await this.refs.project(companyId, query.project_id);
      if (!project || (!staffing && project.managerUserId !== actor.userId)) {
        throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
      }
      ids = [
        ...new Set([
          project.managerUserId,
          ...(await this.refs.projectPeople(project.id)),
        ]),
      ];
    } else if (query.user_ids) {
      ids = query.user_ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
        .filter((id) => staffing || mine.has(id));
    } else if (!staffing) {
      ids = [...mine];
    }
    const people = await this.employees.staffRows(
      companyId,
      ids,
      query.skill_id,
    );
    const hr = (['hr.employee.read', 'hr.employee.manage'] as const).some((p) =>
      actor.permissions.includes(p),
    );
    const grid = await this.grid(
      companyId,
      people.map((person) => person.userId),
      query.from,
      query.to,
      (userId) => hr || mine.has(userId),
    );
    const projectIds = [
      ...new Set(
        [...grid.values()].flatMap((days) =>
          days.flatMap((d) => d.booked.map((b) => b.projectId)),
        ),
      ),
    ];
    const projects = projectIds.length
      ? await this.refs.projects({ companyId, id: { in: projectIds } })
      : [];
    return {
      from: query.from,
      to: query.to,
      days: daysBetween(query.from, query.to),
      projects: Object.fromEntries(
        projects.map((p) => [p.id, `${p.projectNo} · ${p.name}`]),
      ),
      people: people.map((person) => {
        const days = grid.get(person.userId) ?? [];
        return {
          ...person,
          days,
          totals: {
            capacity: sum(days, (d) => d.capacity),
            leave: sum(days, (d) => d.leaveHours),
            booked: sum(days, (d) => d.bookedHours),
            free: sum(days, (d) => d.free),
          },
        };
      }),
    };
  }

  /**
   * Per person per day, for other modules (CD-180 resource allocation,
   * CD-235 utilisation): capacity, leave, booked and free hours.
   */
  availabilityFor(
    companyId: string,
    userIds: string[],
    from: string,
    to: string,
  ) {
    window(from, to);
    return this.grid(companyId, userIds, from, to, () => false);
  }

  async projectBookings(actor: Principal, projectId: string) {
    const project = await this.bookable(actor, projectId, false);
    const rows = (await this.bookings.findMany({
      where: { companyId: actor.activeCompanyId, projectId, cancelledAt: null },
      orderBy: [{ startDate: 'asc' }],
    })) as unknown as BookingRow[];
    const names = await this.refs.names([
      ...new Set(rows.flatMap((r) => [r.userId, r.createdBy])),
    ]);
    return {
      project: {
        id: project.id,
        label: `${project.projectNo} · ${project.name}`,
      },
      items: rows.map((row) => ({
        ...bookingView(row),
        name: names.get(row.userId) ?? row.userId,
        createdByName: names.get(row.createdBy) ?? row.createdBy,
      })),
    };
  }

  async createBooking(actor: Principal, dto: CreateBookingDto) {
    const companyId = actor.activeCompanyId;
    const project = await this.bookable(actor, dto.project_id, true);
    if (!['active', 'on_hold'].includes(project.status)) {
      throw new AppError('CONFLICT', 'โครงการนี้ปิดแล้ว จองคนเพิ่มไม่ได้');
    }
    if (!isDay(dto.start_date) || !isDay(dto.end_date)) {
      throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง');
    }
    if (dto.end_date < dto.start_date) {
      throw new AppError('VALIDATION_FAILED', 'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
    }
    if (spanDays(dto.start_date, dto.end_date) > MAX_BOOKING_DAYS) {
      throw new AppError(
        'VALIDATION_FAILED',
        `จองได้ครั้งละไม่เกิน ${MAX_BOOKING_DAYS} วัน`,
      );
    }
    if (dto.hours_per_day * 2 !== Math.round(dto.hours_per_day * 2)) {
      throw new AppError('VALIDATION_FAILED', 'ชั่วโมงต่อวันต้องทีละ 0.5');
    }
    const [person] = await this.employees.staffRows(companyId, [dto.user_id]);
    if (!person) throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุ');

    const current =
      (
        await this.grid(
          companyId,
          [dto.user_id],
          dto.start_date,
          dto.end_date,
          () => false,
        )
      ).get(dto.user_id) ?? [];
    if (!current.some((d) => d.working)) {
      throw new AppError('VALIDATION_FAILED', 'ช่วงที่จองไม่มีวันทำการ');
    }
    const overbooked = overbookedDays(current, dto.hours_per_day);

    const created = (await this.bookings.create({
      data: {
        companyId,
        userId: dto.user_id,
        projectId: project.id,
        startDate: date(dto.start_date),
        endDate: date(dto.end_date),
        hoursPerDay: dto.hours_per_day,
        note: dto.note?.trim() ?? '',
        createdBy: actor.userId,
      },
    })) as unknown as BookingRow;
    await this.audit.record({
      eventType: 'hr.booking.created',
      companyId,
      ...auditActor(actor),
      resourceType: 'hr_booking',
      resourceId: created.id,
      after: {
        userId: dto.user_id,
        projectId: project.id,
        startDate: dto.start_date,
        endDate: dto.end_date,
        hoursPerDay: dto.hours_per_day,
        overbookedDays: overbooked.length,
      },
    });
    if (dto.user_id !== actor.userId) {
      const by = await this.refs.names([actor.userId]);
      await this.notifications.bookingCreated(
        dto.user_id,
        companyId,
        {
          id: created.id,
          startDate: dto.start_date,
          endDate: dto.end_date,
          hoursPerDay: dto.hours_per_day,
        },
        `${project.projectNo} · ${project.name}`,
        by.get(actor.userId) ?? actor.userId,
      );
    }
    return { booking: bookingView(created), overbooked };
  }

  async cancelBooking(actor: Principal, id: string) {
    const booking = (await this.bookings.findFirst({
      where: { id, companyId: actor.activeCompanyId, cancelledAt: null },
    })) as unknown as BookingRow | null;
    if (!booking) throw new AppError('NOT_FOUND', 'ไม่พบการจองที่ระบุ');
    await this.bookable(actor, booking.projectId, true);
    await this.bookings.update({
      where: { id },
      data: { cancelledAt: new Date(), cancelledBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'hr.booking.cancelled',
      companyId: booking.companyId,
      ...auditActor(actor),
      resourceType: 'hr_booking',
      resourceId: id,
      before: bookingView(booking),
    });
    return { id, cancelled: true };
  }

  // --- helpers ----------------------------------------------------------------

  private async grid(
    companyId: string,
    userIds: string[],
    from: string,
    to: string,
    showKind: (userId: string) => boolean,
  ) {
    const [calendar, leaves, rows] = await Promise.all([
      this.leaves.workDays(companyId),
      this.leaves.holding(companyId, userIds, from, to, showKind),
      userIds.length
        ? (this.bookings.findMany({
            where: {
              companyId,
              userId: { in: userIds },
              cancelledAt: null,
              startDate: { lte: date(to) },
              endDate: { gte: date(from) },
            },
          }) as unknown as Promise<BookingRow[]>)
        : Promise.resolve([] as BookingRow[]),
    ]);
    const days = daysBetween(from, to);
    const byUser = new Map<string, BookingSpan[]>();
    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push({
        id: row.id,
        projectId: row.projectId,
        startDate: day(row.startDate),
        endDate: day(row.endDate),
        hoursPerDay: Number(row.hoursPerDay),
      });
      byUser.set(row.userId, list);
    }
    return new Map(
      userIds.map((userId) => [
        userId,
        availabilityDays(
          days,
          calendar,
          leaves.get(userId) ?? [],
          byUser.get(userId) ?? [],
        ),
      ]),
    );
  }

  /** The project, if the caller may see (or, with `write`, change) its bookings. */
  private async bookable(actor: Principal, projectId: string, write: boolean) {
    const project = await this.refs.project(actor.activeCompanyId, projectId);
    const may =
      !!project &&
      (project.managerUserId === actor.userId ||
        actor.permissions.includes('pm.project.manage') ||
        actor.permissions.includes('hr.employee.manage') ||
        (!write && actor.permissions.includes('hr.employee.read')));
    if (!project || !may)
      throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    return project;
  }
}

function window(from: string, to: string) {
  if (!isDay(from) || !isDay(to) || to < from) {
    throw new AppError('VALIDATION_FAILED', 'ช่วงวันที่ไม่ถูกต้อง');
  }
  if (spanDays(from, to) > MAX_WINDOW_DAYS) {
    throw new AppError(
      'VALIDATION_FAILED',
      `ดูได้ครั้งละไม่เกิน ${MAX_WINDOW_DAYS} วัน`,
    );
  }
}

function sum<T>(rows: T[], pick: (row: T) => number) {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function bookingView(row: BookingRow) {
  return {
    id: row.id,
    userId: row.userId,
    projectId: row.projectId,
    startDate: day(row.startDate),
    endDate: day(row.endDate),
    hoursPerDay: Number(row.hoursPerDay),
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
