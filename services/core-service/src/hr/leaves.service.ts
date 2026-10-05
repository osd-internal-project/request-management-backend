import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HrCalendarRepository,
  HrLeaveEntitlementRepository,
  HrLeaveRepository,
  HrLeaveTypeRepository,
  HrReportingRepository,
  HrWorkRefsRepository,
} from './hr.repositories';
import {
  DecideLeaveDto,
  RequestLeaveDto,
  SaveLeaveEntitlementDto,
  SaveLeaveTypeDto,
} from './hr.dto';
import {
  daysByYear,
  DEFAULT_WORK_DAYS,
  type LeaveOnDay,
  type LeavePart,
  leaveProblems,
  leaveShares,
  leavesClash,
  type WorkDays,
} from './leave-rules';
import { EmployeesService } from './employees.service';

const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);
/** Pending and approved leave both mean "not here". */
const HOLDING = ['pending', 'approved'];

interface LeaveRow {
  id: string;
  companyId: string;
  userId: string;
  leaveTypeId: string;
  startDate: Date;
  endDate: Date;
  part: string;
  days: Prisma.Decimal;
  reason: string;
  status: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  cancelledAt: Date | null;
  createdAt: Date;
  leaveType: { id: string; code: string; name: string };
}

interface TypeRow {
  id: string;
  code: string;
  name: string;
  annualDays: Prisma.Decimal | null;
  sortOrder: number;
  active: boolean;
}

/**
 * CD-232 — leave (part of CD-17 HR).
 *
 * A person asks for leave of one of the company's kinds — whole days over a
 * range, or a morning or afternoon on one day. It counts working days only
 * (the company calendar SLA and the project plan use), is held against the
 * year's allowance (the kind's default, or what HR set for that person), and
 * goes to the person's supervisor; anyone above them or HR approves or
 * rejects it (with a reason). Pending and approved leave both make someone
 * unavailable (`AvailabilityService`).
 */
@Injectable()
export class LeavesService {
  constructor(
    private readonly types: HrLeaveTypeRepository,
    private readonly entitlements: HrLeaveEntitlementRepository,
    private readonly leaves: HrLeaveRepository,
    private readonly calendars: HrCalendarRepository,
    private readonly reporting: HrReportingRepository,
    private readonly refs: HrWorkRefsRepository,
    private readonly employees: EmployeesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
  ) {}

  // --- kinds of leave and allowances (HR) -------------------------------------

  async listTypes(actor: Principal) {
    const rows = (await this.types.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(isHrManager(actor) ? {} : { active: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })) as unknown as TypeRow[];
    return { items: rows.map(typeView) };
  }

  async saveType(actor: Principal, id: string | null, dto: SaveLeaveTypeDto) {
    const companyId = actor.activeCompanyId;
    const data = {
      name: dto.name.trim(),
      ...(dto.annual_days !== undefined
        ? {
            annualDays: dto.annual_days === null ? null : half(dto.annual_days),
          }
        : {}),
      ...(dto.sort_order !== undefined ? { sortOrder: dto.sort_order } : {}),
      ...(dto.active !== undefined ? { active: dto.active } : {}),
    };
    if (!data.name)
      throw new AppError('VALIDATION_FAILED', 'ต้องมีชื่อประเภทการลา');
    let saved: TypeRow;
    if (id) {
      const found = await this.types.findFirst({ where: { id, companyId } });
      if (!found) throw new AppError('NOT_FOUND', 'ไม่พบประเภทการลาที่ระบุ');
      saved = await this.types.update({
        where: { id },
        data,
      });
    } else {
      const code = dto.code?.toUpperCase();
      if (!code)
        throw new AppError('VALIDATION_FAILED', 'ต้องมีรหัสประเภทการลา');
      if (await this.types.findFirst({ where: { companyId, code } })) {
        throw new AppError('CONFLICT', `รหัส ${code} มีอยู่แล้ว`);
      }
      saved = await this.types.create({
        data: { companyId, code, ...data },
      });
    }
    await this.audit.record({
      eventType: id ? 'hr.leave_type.updated' : 'hr.leave_type.created',
      companyId,
      ...auditActor(actor),
      resourceType: 'hr_leave_type',
      resourceId: saved.id,
      after: typeView(saved),
    });
    return typeView(saved);
  }

  async listEntitlements(actor: Principal, year: number) {
    const companyId = actor.activeCompanyId;
    const rows = (await this.entitlements.findMany({
      where: { companyId, year },
      include: { leaveType: { select: { name: true } } },
      orderBy: [{ userId: 'asc' }],
    })) as unknown as {
      id: string;
      userId: string;
      leaveTypeId: string;
      year: number;
      days: Prisma.Decimal;
      leaveType: { name: string };
    }[];
    const names = await this.refs.names([
      ...new Set(rows.map((r) => r.userId)),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        name: names.get(row.userId) ?? row.userId,
        leaveTypeId: row.leaveTypeId,
        leaveType: row.leaveType.name,
        year: row.year,
        days: Number(row.days),
      })),
    };
  }

  async saveEntitlement(actor: Principal, dto: SaveLeaveEntitlementDto) {
    const companyId = actor.activeCompanyId;
    await this.requireType(companyId, dto.leave_type_id);
    if (!(await this.employees.staffRows(companyId, [dto.user_id])).length) {
      throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุ');
    }
    const key = {
      companyId,
      userId: dto.user_id,
      leaveTypeId: dto.leave_type_id,
      year: dto.year,
    };
    const saved = await this.entitlements.upsert({
      where: { companyId_userId_leaveTypeId_year: key },
      create: { ...key, days: half(dto.days), updatedBy: actor.userId },
      update: { days: half(dto.days), updatedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'hr.leave_entitlement.saved',
      companyId,
      ...auditActor(actor),
      resourceType: 'user',
      resourceId: dto.user_id,
      after: {
        leaveTypeId: dto.leave_type_id,
        year: dto.year,
        days: half(dto.days),
      },
    });
    return { id: saved.id, ...key, days: half(dto.days) };
  }

  // --- a person's leave -------------------------------------------------------

  /** Allowance, used, pending and left, per kind, for one person and year. */
  async balances(actor: Principal, userId: string, year: number) {
    const companyId = actor.activeCompanyId;
    if (!(await this.maySee(actor, userId))) {
      throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุ');
    }
    return { items: await this.balanceRows(companyId, userId, year) };
  }

  /** My leave in a year, with my balances. */
  async mine(actor: Principal, year: number) {
    const companyId = actor.activeCompanyId;
    const rows = (await this.leaves.findMany({
      where: {
        companyId,
        userId: actor.userId,
        startDate: { lte: date(`${year}-12-31`) },
        endDate: { gte: date(`${year}-01-01`) },
      },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
      orderBy: [{ startDate: 'desc' }],
    })) as unknown as LeaveRow[];
    const deciders = await this.refs.names(
      [...new Set(rows.map((row) => row.decidedBy))].filter(
        (id): id is string => !!id,
      ),
    );
    return {
      year,
      today: thaiToday(),
      items: rows.map((row) => ({
        ...leaveView(row),
        decidedByName: row.decidedBy
          ? (deciders.get(row.decidedBy) ?? null)
          : null,
      })),
      balances: await this.balanceRows(companyId, actor.userId, year),
    };
  }

  async request(actor: Principal, dto: RequestLeaveDto) {
    const companyId = actor.activeCompanyId;
    const part = (dto.part ?? 'full') as LeavePart;
    const type = await this.requireType(companyId, dto.leave_type_id);
    if (!type.active) {
      throw new AppError('VALIDATION_FAILED', 'ประเภทการลานี้เลิกใช้แล้ว');
    }
    const calendar = await this.workDays(companyId);
    const problems = leaveProblems(
      dto.start_date,
      dto.end_date,
      part,
      calendar,
    );
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    const span = { startDate: dto.start_date, endDate: dto.end_date, part };

    const mine = (await this.leaves.findMany({
      where: {
        companyId,
        userId: actor.userId,
        status: { in: HOLDING },
        startDate: { lte: date(dto.end_date) },
        endDate: { gte: date(dto.start_date) },
      },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    })) as unknown as LeaveRow[];
    const clash = mine.find((row) => leavesClash(span, spanOf(row)));
    if (clash) {
      throw new AppError(
        'CONFLICT',
        `ซ้อนกับ${clash.leaveType.name} ${day(clash.startDate)} ที่${clash.status === 'pending' ? 'รออนุมัติ' : 'อนุมัติแล้ว'}`,
      );
    }

    // Held against each year's allowance (pending counts, so it cannot be overdrawn).
    for (const [year, wanted] of daysByYear(span, calendar)) {
      const balance = (
        await this.balanceRows(companyId, actor.userId, year)
      ).find((row) => row.leaveTypeId === type.id);
      if (balance?.remaining != null && wanted > balance.remaining) {
        throw new AppError(
          'VALIDATION_FAILED',
          `สิทธิ์${type.name}ปี ${year + 543} เหลือ ${balance.remaining} วัน แต่ขอ ${wanted} วัน`,
        );
      }
    }

    const days = leaveShares(
      dto.start_date,
      dto.end_date,
      part,
      calendar,
    ).reduce((sum, share) => sum + share.share, 0);
    const created = (await this.leaves.create({
      data: {
        companyId,
        userId: actor.userId,
        leaveTypeId: type.id,
        startDate: date(dto.start_date),
        endDate: date(dto.end_date),
        part,
        days,
        reason: dto.reason?.trim() ?? '',
      },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    })) as unknown as LeaveRow;
    await this.audit.record({
      eventType: 'hr.leave.requested',
      companyId,
      ...auditActor(actor),
      resourceType: 'hr_leave',
      resourceId: created.id,
      after: { type: type.code, ...span, days },
    });
    const me = await this.refs.supervisorOf(actor.userId);
    if (me?.supervisorUserId) {
      await this.notifications.leaveRequested(
        me.supervisorUserId,
        companyId,
        {
          id: created.id,
          startDate: span.startDate,
          endDate: span.endDate,
          days,
        },
        me.displayName,
        type.name,
      );
    }
    return leaveView(created);
  }

  /** The owner withdraws a pending leave, or an approved one not yet begun; HR any. */
  async cancel(actor: Principal, id: string) {
    const leave = await this.requireLeave(actor.activeCompanyId, id);
    const owner = leave.userId === actor.userId;
    if (!owner && !isHrManager(actor)) {
      throw new AppError('NOT_FOUND', 'ไม่พบใบลาที่ระบุ');
    }
    if (!HOLDING.includes(leave.status)) {
      throw new AppError('CONFLICT', 'ใบลานี้ปิดไปแล้ว');
    }
    if (
      owner &&
      !isHrManager(actor) &&
      leave.status === 'approved' &&
      day(leave.startDate) <= thaiToday()
    ) {
      throw new AppError(
        'CONFLICT',
        'ลาที่อนุมัติแล้วและเริ่มไปแล้ว ยกเลิกเองไม่ได้ — ติดต่อฝ่ายบุคคล',
      );
    }
    return this.move(actor, leave, {
      status: 'cancelled',
      cancelledAt: new Date(),
    });
  }

  /** Leave waiting for me: my people's (any depth), or everyone's for HR. */
  async pending(actor: Principal) {
    const below = await this.reporting.subordinatesOf(actor.userId);
    const rows = (await this.leaves.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: 'pending',
        ...(isHrManager(actor)
          ? { userId: { not: actor.userId } }
          : { userId: { in: below.filter((id) => id !== actor.userId) } }),
      },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
      orderBy: [{ startDate: 'asc' }],
    })) as unknown as LeaveRow[];
    const names = await this.refs.names([
      ...new Set(rows.map((r) => r.userId)),
    ]);
    return {
      items: rows.map((row) => ({
        ...leaveView(row),
        name: names.get(row.userId) ?? row.userId,
      })),
    };
  }

  async approve(actor: Principal, id: string, dto: DecideLeaveDto) {
    const leave = await this.decidable(actor, id);
    return this.decide(actor, leave, true, dto.note?.trim() ?? '');
  }

  async reject(actor: Principal, id: string, dto: DecideLeaveDto) {
    const note = dto.note?.trim() ?? '';
    if (!note)
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่ไม่อนุมัติ');
    const leave = await this.decidable(actor, id);
    return this.decide(actor, leave, false, note);
  }

  // --- for availability -------------------------------------------------------

  /** The company's working weekdays and holidays. */
  async workDays(companyId: string): Promise<WorkDays> {
    const row = (await this.calendars.findFirst({
      where: { companyId },
      select: { workingWeekdays: true, holidays: true },
    })) as { workingWeekdays: number[]; holidays: unknown } | null;
    if (!row) return DEFAULT_WORK_DAYS;
    return {
      workingWeekdays: row.workingWeekdays.length
        ? row.workingWeekdays
        : DEFAULT_WORK_DAYS.workingWeekdays,
      holidays: Array.isArray(row.holidays)
        ? row.holidays.filter((d): d is string => typeof d === 'string')
        : [],
    };
  }

  /**
   * Pending and approved leave of `userIds` touching `from`–`to`. The kind is
   * named only where `showKind(userId)` says the viewer may know it.
   */
  async holding(
    companyId: string,
    userIds: string[],
    from: string,
    to: string,
    showKind: (userId: string) => boolean,
  ) {
    if (!userIds.length) return new Map<string, LeaveOnDay[]>();
    const rows = (await this.leaves.findMany({
      where: {
        companyId,
        userId: { in: userIds },
        status: { in: HOLDING },
        startDate: { lte: date(to) },
        endDate: { gte: date(from) },
      },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    })) as unknown as LeaveRow[];
    const out = new Map<string, LeaveOnDay[]>();
    for (const row of rows) {
      const list = out.get(row.userId) ?? [];
      list.push({
        id: row.id,
        ...spanOf(row),
        status: row.status,
        typeName: showKind(row.userId) ? row.leaveType.name : null,
      });
      out.set(row.userId, list);
    }
    return out;
  }

  // --- helpers ----------------------------------------------------------------

  private async balanceRows(companyId: string, userId: string, year: number) {
    const [types, overrides, rows, calendar] = await Promise.all([
      this.types.findMany({
        where: { companyId, active: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }) as unknown as Promise<TypeRow[]>,
      this.entitlements.findMany({
        where: { companyId, userId, year },
        select: { leaveTypeId: true, days: true },
      }) as unknown as Promise<{ leaveTypeId: string; days: Prisma.Decimal }[]>,
      this.leaves.findMany({
        where: {
          companyId,
          userId,
          status: { in: HOLDING },
          startDate: { lte: date(`${year}-12-31`) },
          endDate: { gte: date(`${year}-01-01`) },
        },
        select: {
          leaveTypeId: true,
          startDate: true,
          endDate: true,
          part: true,
          status: true,
        },
      }) as unknown as Promise<
        {
          leaveTypeId: string;
          startDate: Date;
          endDate: Date;
          part: string;
          status: string;
        }[]
      >,
      this.workDays(companyId),
    ]);
    const override = new Map(
      overrides.map((row) => [row.leaveTypeId, Number(row.days)]),
    );
    return types.map((type) => {
      let used = 0;
      let pending = 0;
      for (const row of rows.filter((r) => r.leaveTypeId === type.id)) {
        const days = daysByYear(spanOf(row), calendar).get(year) ?? 0;
        if (row.status === 'approved') used += days;
        else pending += days;
      }
      const quota =
        override.get(type.id) ??
        (type.annualDays === null ? null : Number(type.annualDays));
      return {
        leaveTypeId: type.id,
        code: type.code,
        name: type.name,
        quota,
        used,
        pending,
        remaining: quota === null ? null : quota - used - pending,
      };
    });
  }

  private async requireType(companyId: string, id: string) {
    const type = (await this.types.findFirst({
      where: { id, companyId },
    })) as unknown as TypeRow | null;
    if (!type) throw new AppError('NOT_FOUND', 'ไม่พบประเภทการลาที่ระบุ');
    return type;
  }

  private async requireLeave(companyId: string, id: string) {
    const leave = (await this.leaves.findFirst({
      where: { id, companyId },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    })) as unknown as LeaveRow | null;
    if (!leave) throw new AppError('NOT_FOUND', 'ไม่พบใบลาที่ระบุ');
    return leave;
  }

  /** Self, HR, or anyone above them in the reporting lines. */
  private async maySee(actor: Principal, userId: string) {
    if (userId === actor.userId || isHr(actor)) return true;
    return (await this.reporting.subordinatesOf(actor.userId)).includes(userId);
  }

  private async decidable(actor: Principal, id: string) {
    const leave = await this.requireLeave(actor.activeCompanyId, id);
    if (leave.userId === actor.userId) {
      throw new AppError('FORBIDDEN', 'อนุมัติใบลาของตัวเองไม่ได้');
    }
    const may =
      isHrManager(actor) ||
      (await this.reporting.subordinatesOf(actor.userId)).includes(
        leave.userId,
      );
    if (!may) throw new AppError('NOT_FOUND', 'ไม่พบใบลาที่ระบุ');
    if (leave.status !== 'pending') {
      throw new AppError('CONFLICT', 'ใบลานี้ไม่ได้รออนุมัติ');
    }
    return leave;
  }

  private async decide(
    actor: Principal,
    leave: LeaveRow,
    approved: boolean,
    note: string,
  ) {
    const result = await this.move(actor, leave, {
      status: approved ? 'approved' : 'rejected',
      decidedBy: actor.userId,
      decidedAt: new Date(),
      decisionNote: note || null,
    });
    await this.notifications.leaveDecided(
      leave.userId,
      leave.companyId,
      {
        id: leave.id,
        startDate: day(leave.startDate),
        endDate: day(leave.endDate),
      },
      leave.leaveType.name,
      approved,
      note,
    );
    return result;
  }

  private async move(
    actor: Principal,
    leave: LeaveRow,
    data: Prisma.HrLeaveUpdateManyMutationInput & { status: string },
  ) {
    const moved = await this.leaves.updateMany({
      where: { id: leave.id, status: leave.status },
      data,
    });
    if (!moved.count) {
      throw new AppError('CONFLICT', 'ใบลาถูกเปลี่ยนไปแล้ว — โหลดใหม่');
    }
    await this.audit.record({
      eventType: `hr.leave.${data.status}`,
      companyId: leave.companyId,
      ...auditActor(actor),
      resourceType: 'hr_leave',
      resourceId: leave.id,
      before: { status: leave.status },
      after: {
        status: data.status,
        note: typeof data.decisionNote === 'string' ? data.decisionNote : null,
      },
    });
    return this.requireLeave(leave.companyId, leave.id).then(leaveView);
  }
}

function isHr(actor: Principal) {
  return (
    actor.permissions.includes('hr.employee.read') ||
    actor.permissions.includes('hr.employee.manage')
  );
}

function isHrManager(actor: Principal) {
  return actor.permissions.includes('hr.employee.manage');
}

/** Halves only — leave is counted in whole and half days. */
function half(value: number) {
  return Math.round(value * 2) / 2;
}

function spanOf(row: { startDate: Date; endDate: Date; part: string }) {
  return {
    startDate: day(row.startDate),
    endDate: day(row.endDate),
    part: row.part,
  };
}

function typeView(row: TypeRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    annualDays: row.annualDays === null ? null : Number(row.annualDays),
    sortOrder: row.sortOrder,
    active: row.active,
  };
}

function leaveView(row: LeaveRow) {
  return {
    id: row.id,
    userId: row.userId,
    leaveTypeId: row.leaveTypeId,
    leaveType: row.leaveType.name,
    ...spanOf(row),
    days: Number(row.days),
    reason: row.reason,
    status: row.status,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
  };
}
