import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { backgroundTick } from '../common/background-tick';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { LeavesService } from '../hr/leaves.service';
import { NotificationsService } from '../notifications/notifications.service';
import { nextRequestEventSeq } from '../requests/request-event-seq';
import { RequestRepository } from '../requests/request.repository';
import { DEFAULT_CALENDAR, type WorkingCalendar } from '../sla/business-hours';
import {
  escalationDue,
  outOfHours,
  pickOnCall,
  rotaDay,
  shiftProblems,
  type OnCallLevel,
} from './on-call-rules';
import { ListOnCallQueryDto, SaveOnCallShiftDto } from './support.dto';
import {
  ServiceCalendarRepository,
  ServiceOnCallDispatchRepository,
  ServiceOnCallShiftRepository,
} from './support.repositories';

interface ShiftRow {
  id: string;
  companyId: string;
  startOn: Date;
  endOn: Date;
  primaryUserId: string;
  backupUserId: string | null;
  note: string | null;
  createdAt: Date;
  createdBy: string;
}

interface DispatchRow {
  id: string;
  companyId: string;
  requestId: string;
  shiftId: string;
  userId: string;
  level: string;
  previousReceiverUserId: string | null;
  sentAt: Date;
  escalatedAt: Date | null;
  escalatedFromUserId: string | null;
  settledAt: Date | null;
}

interface CaseRow {
  id: string;
  companyId: string;
  status: string;
  receiverUserId: string | null;
  requestNo: string | null;
  formData: unknown;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);
const LIST_DAYS = 56;
const CASE_SELECT = {
  id: true,
  companyId: true,
  status: true,
  receiverUserId: true,
  requestNo: true,
  formData: true,
} as const;

/**
 * CD-241 ตารางเวรนอกเวลา — the service team's rota of who answers out of
 * hours (a span of days, a primary and a backup), and the routing that uses
 * it: a service job opened outside the company's working window (its
 * calendar — the SLA clock's) is made the receiver's of whoever is on call,
 * and they are told (in the app, and on Teams when it is on). The primary on
 * leave (CD-232) → the backup. Not received within the company's minutes
 * (`serviceOnCallEscalateMinutes`) → handed to the backup. The SLA clock
 * keeps running until someone receives it: sending is not answering.
 *
 * Who: `service.asset.read` reads the rota; `service.asset.manage` writes it.
 */
@Injectable()
export class OnCallService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OnCallService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly shifts: ServiceOnCallShiftRepository,
    private readonly dispatches: ServiceOnCallDispatchRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly leaves: LeavesService,
    private readonly notifications: NotificationsService,
    private readonly calendars: ServiceCalendarRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const everyMs =
      this.config.get<number>('service.onCallSweepIntervalMs') ?? 60_000;
    // `0` disables — tests never sweep.
    if (everyMs <= 0) return;
    const tick = backgroundTick(this.logger, 'on-call sweep', () =>
      this.sweep(),
    );
    this.timer = setInterval(tick, everyMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // --- the rota --------------------------------------------------------------

  /** The rota from `from` (default today) for 8 weeks, and who is on now. */
  async list(actor: Principal, query: ListOnCallQueryDto) {
    const companyId = actor.activeCompanyId;
    const calendar = await this.calendarOf(companyId);
    const today = rotaDay(new Date(), calendar);
    const from = query.from ?? today;
    const to =
      query.to ??
      day(new Date(asDate(from).getTime() + LIST_DAYS * 86_400_000));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new AppError('VALIDATION_FAILED', 'วันที่ไม่ถูกต้อง');
    }
    const rows = (await this.shifts.findMany({
      where: {
        companyId,
        deletedAt: null,
        startOn: { lte: asDate(to) },
        endOn: { gte: asDate(from) },
      },
      orderBy: [{ startOn: 'asc' }],
    })) as unknown as ShiftRow[];
    const now = await this.now(companyId);
    const names = await this.names([
      ...rows.flatMap((row) => [row.primaryUserId, row.backupUserId]),
      now.onCall?.userId ?? null,
    ]);
    return {
      from,
      to,
      now: {
        ...now,
        shift: now.shift ? this.view(now.shift, names) : null,
        onCall: now.onCall
          ? {
              ...now.onCall,
              name: names.get(now.onCall.userId) ?? now.onCall.userId,
            }
          : null,
      },
      items: rows.map((row) => this.view(row, names)),
    };
  }

  async create(actor: Principal, dto: SaveOnCallShiftDto) {
    const companyId = actor.activeCompanyId;
    const input = await this.checked(companyId, dto, null);
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceOnCallShift.create({
        data: {
          companyId,
          startOn: asDate(input.startOn),
          endOn: asDate(input.endOn),
          primaryUserId: input.primaryUserId,
          backupUserId: input.backupUserId,
          note: dto.note?.trim() || null,
          createdBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.on_call.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_on_call_shift',
          resourceId: created.id,
          after: { ...input },
        },
        { prisma },
      );
      return created;
    });
    const names = await this.names([row.primaryUserId, row.backupUserId]);
    return this.view(row, names);
  }

  async update(actor: Principal, id: string, dto: SaveOnCallShiftDto) {
    const companyId = actor.activeCompanyId;
    const before = await this.requireShift(companyId, id);
    const input = await this.checked(companyId, dto, id);
    const row = await this.transactions.execute(async (prisma) => {
      const saved = await prisma.serviceOnCallShift.update({
        where: { id },
        data: {
          startOn: asDate(input.startOn),
          endOn: asDate(input.endOn),
          primaryUserId: input.primaryUserId,
          backupUserId: input.backupUserId,
          note: dto.note?.trim() || null,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.on_call.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_on_call_shift',
          resourceId: id,
          before: {
            startOn: day(before.startOn),
            endOn: day(before.endOn),
            primaryUserId: before.primaryUserId,
            backupUserId: before.backupUserId,
          },
          after: { ...input },
        },
        { prisma },
      );
      return saved;
    });
    const names = await this.names([row.primaryUserId, row.backupUserId]);
    return this.view(row, names);
  }

  async remove(actor: Principal, id: string) {
    const companyId = actor.activeCompanyId;
    const before = await this.requireShift(companyId, id);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceOnCallShift.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'service.on_call.removed',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_on_call_shift',
          resourceId: id,
          before: {
            startOn: day(before.startOn),
            endOn: day(before.endOn),
            primaryUserId: before.primaryUserId,
            backupUserId: before.backupUserId,
          },
        },
        { prisma },
      );
    });
    return { id };
  }

  /** Whether it is out of hours now, the span answering, and whom it would reach. */
  async now(companyId: string, at = new Date()) {
    const calendar = await this.calendarOf(companyId);
    const date = rotaDay(at, calendar);
    const shift = await this.shiftOn(companyId, date);
    const onCall = shift ? await this.whom(companyId, shift, date) : null;
    return {
      outOfHours: outOfHours(at, calendar),
      date,
      shift,
      onCall,
    };
  }

  // --- routing ---------------------------------------------------------------

  /**
   * A service job not yet received, opened out of hours: made the receiver's
   * of whoever is on call. Once per case; nothing when in hours, when nobody
   * is on the rota that day, or when both are away (it stays with the type's
   * receiver).
   */
  async dispatch(requestId: string, at = new Date()) {
    if (await this.dispatches.count({ where: { requestId } })) return null;
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: CASE_SELECT,
    })) as CaseRow | null;
    if (request?.status !== 'submitted') return null;
    const companyId = request.companyId;
    const calendar = await this.calendarOf(companyId);
    if (!outOfHours(at, calendar)) return null;
    const date = rotaDay(at, calendar);
    const shift = await this.shiftOn(companyId, date);
    if (!shift) return null;
    const target = await this.whom(companyId, shift, date);
    if (!target) return null;

    const sent = await this.transactions.execute(async (prisma) => {
      const moved = await prisma.request.updateMany({
        where: { id: requestId, status: 'submitted' },
        data: { receiverUserId: target.userId },
      });
      if (!moved.count) return null;
      const row = await prisma.serviceOnCallDispatch.create({
        data: {
          companyId,
          requestId,
          shiftId: shift.id,
          userId: target.userId,
          level: target.level,
          previousReceiverUserId: request.receiverUserId,
          sentAt: at,
          // sent to the backup already: there is nobody further to hand to
          settledAt: target.level === 'backup' ? at : null,
        },
      });
      await this.timeline(prisma, requestId, 'service.oncall.dispatched', {
        to: target.userId,
        level: target.level,
        from: request.receiverUserId,
        shiftId: shift.id,
      });
      await this.audit.record(
        {
          eventType: 'service.on_call.dispatched',
          companyId,
          actorUsername: 'system',
          resourceType: 'request',
          resourceId: requestId,
          before: { receiverUserId: request.receiverUserId },
          after: { receiverUserId: target.userId, level: target.level },
        },
        { prisma },
      );
      return row;
    });
    if (!sent) return null;
    await this.tell(target.userId, request, this.reason(target.level, null));
    return sent;
  }

  /**
   * Every minute: a case the primary has not received within the company's
   * minutes goes to the backup. Received, closed or handed elsewhere since —
   * no longer watched.
   */
  async sweep(now = new Date()) {
    const open = (await this.dispatches.findMany({
      where: { settledAt: null },
      orderBy: [{ sentAt: 'asc' }],
      take: 200,
    })) as unknown as DispatchRow[];
    const minutes = new Map<string, number>();
    let handed = 0;
    for (const row of open) {
      if (!minutes.has(row.companyId)) {
        minutes.set(row.companyId, await this.escalateMinutes(row.companyId));
      }
      const request = (await this.requestRows.findFirst({
        where: { id: row.requestId },
        select: CASE_SELECT,
      })) as CaseRow | null;
      if (
        request?.status !== 'submitted' ||
        request.receiverUserId !== row.userId
      ) {
        await this.settle(row.id, now);
        continue;
      }
      if (!escalationDue(row.sentAt, now, minutes.get(row.companyId) ?? 0)) {
        continue;
      }
      if (await this.escalate(row, request, now, minutes.get(row.companyId)!)) {
        handed += 1;
      }
    }
    return { watched: open.length, handed };
  }

  /** The case's trip to the rota, for its page. */
  async ofRequest(actor: Principal, requestId: string) {
    const row = await this.dispatches.findFirst({
      where: { requestId, companyId: actor.activeCompanyId },
    });
    if (!row) return null;
    const names = await this.names([row.userId, row.escalatedFromUserId]);
    return {
      userId: row.userId,
      name: names.get(row.userId) ?? row.userId,
      level: row.level as OnCallLevel,
      sentAt: row.sentAt.toISOString(),
      escalatedAt: row.escalatedAt?.toISOString() ?? null,
      escalatedFromName: row.escalatedFromUserId
        ? (names.get(row.escalatedFromUserId) ?? row.escalatedFromUserId)
        : null,
      watching: row.settledAt === null,
    };
  }

  // --- helpers ---------------------------------------------------------------

  private async escalate(
    row: DispatchRow,
    request: CaseRow,
    now: Date,
    minutes: number,
  ) {
    const shift = (await this.shifts.findFirst({
      where: { id: row.shiftId, deletedAt: null },
    })) as unknown as ShiftRow | null;
    const backup =
      shift?.backupUserId && shift.backupUserId !== row.userId
        ? await this.whom(
            row.companyId,
            { ...shift, primaryUserId: shift.backupUserId, backupUserId: null },
            rotaDay(now, await this.calendarOf(row.companyId)),
          )
        : null;
    if (!backup) {
      // nobody further: the SLA warnings take it from here
      await this.settle(row.id, now);
      return false;
    }
    const moved = await this.transactions.execute(async (prisma) => {
      const changed = await prisma.request.updateMany({
        where: {
          id: row.requestId,
          status: 'submitted',
          receiverUserId: row.userId,
        },
        data: { receiverUserId: backup.userId },
      });
      await prisma.serviceOnCallDispatch.update({
        where: { id: row.id },
        data: changed.count
          ? {
              userId: backup.userId,
              level: 'backup',
              escalatedAt: now,
              escalatedFromUserId: row.userId,
              settledAt: now,
            }
          : { settledAt: now },
      });
      if (!changed.count) return false;
      await this.timeline(prisma, row.requestId, 'service.oncall.escalated', {
        to: backup.userId,
        from: row.userId,
        minutes,
      });
      await this.audit.record(
        {
          eventType: 'service.on_call.escalated',
          companyId: row.companyId,
          actorUsername: 'system',
          resourceType: 'request',
          resourceId: row.requestId,
          before: { receiverUserId: row.userId },
          after: { receiverUserId: backup.userId },
        },
        { prisma },
      );
      return true;
    });
    if (!moved) return false;
    const names = await this.names([row.userId]);
    await this.tell(
      backup.userId,
      request,
      this.reason('backup', {
        name: names.get(row.userId) ?? row.userId,
        minutes,
      }),
    );
    return true;
  }

  private reason(
    level: OnCallLevel,
    from: { name: string; minutes: number } | null,
  ) {
    if (from) {
      return `${from.name} (เวรหลัก) ยังไม่รับเรื่องภายใน ${from.minutes} นาที — ส่งต่อให้คุณในฐานะเวรสำรอง`;
    }
    return level === 'primary'
      ? 'แจ้งนอกเวลาทำการ — คุณเป็นเวรหลัก'
      : 'แจ้งนอกเวลาทำการ — เวรหลักลา คุณเป็นเวรสำรอง';
  }

  private async tell(userId: string, request: CaseRow, reason: string) {
    const form = (request.formData ?? {}) as { subject?: unknown };
    await this.notifications
      .onCallDispatched(userId, request.companyId, {
        requestId: request.id,
        requestNo: request.requestNo,
        subject: typeof form.subject === 'string' ? form.subject : '',
        reason,
      })
      .catch((error: Error) =>
        this.logger.warn(`on-call notice not sent: ${error.message}`),
      );
  }

  private async settle(id: string, at: Date) {
    await this.dispatches.update({ where: { id }, data: { settledAt: at } });
  }

  /** The timeline entry as the system, as the SLA engine writes its own. */
  private async timeline(
    prisma: Prisma.TransactionClient,
    requestId: string,
    type: string,
    data: Record<string, unknown>,
  ) {
    await prisma.requestEvent.create({
      data: {
        requestId,
        seq: await nextRequestEventSeq(prisma, requestId),
        type,
        actorLabel: 'system',
        data: data as Prisma.InputJsonValue,
      },
    });
  }

  /** The primary, or the backup when the primary is on leave that day. */
  private async whom(
    companyId: string,
    shift: { primaryUserId: string; backupUserId: string | null },
    date: string,
  ) {
    const people = [shift.primaryUserId, shift.backupUserId].filter(
      (id): id is string => Boolean(id),
    );
    const leave = await this.leaves.holding(
      companyId,
      people,
      date,
      date,
      () => false,
    );
    const away = new Set(
      [...leave].filter(([, spans]) => spans.length).map(([id]) => id),
    );
    return pickOnCall(shift, away);
  }

  private async shiftOn(companyId: string, date: string) {
    return (await this.shifts.findFirst({
      where: {
        companyId,
        deletedAt: null,
        startOn: { lte: asDate(date) },
        endOn: { gte: asDate(date) },
      },
      orderBy: [{ startOn: 'desc' }],
    })) as unknown as ShiftRow | null;
  }

  private async checked(
    companyId: string,
    dto: SaveOnCallShiftDto,
    id: string | null,
  ) {
    const input = {
      startOn: dto.start_on,
      endOn: dto.end_on,
      primaryUserId: dto.primary_user_id,
      backupUserId: dto.backup_user_id || null,
    };
    const others = (
      (await this.shifts.findMany({
        where: {
          companyId,
          deletedAt: null,
          ...(id ? { id: { not: id } } : {}),
          ...(/^\d{4}-\d{2}-\d{2}$/.test(input.startOn) &&
          /^\d{4}-\d{2}-\d{2}$/.test(input.endOn)
            ? {
                startOn: { lte: asDate(input.endOn) },
                endOn: { gte: asDate(input.startOn) },
              }
            : {}),
        },
        select: { id: true, startOn: true, endOn: true },
        take: 5,
      })) as unknown as { id: string; startOn: Date; endOn: Date }[]
    ).map((row) => ({
      id: row.id,
      startOn: day(row.startOn),
      endOn: day(row.endOn),
    }));
    const problems = shiftProblems(input, others);
    if (problems.length) {
      throw new AppError('VALIDATION_FAILED', problems[0]);
    }
    for (const [field, userId] of [
      ['primary_user_id', input.primaryUserId],
      ['backup_user_id', input.backupUserId],
    ] as const) {
      if (userId && !(await this.requestRows.findReceiver(userId, companyId))) {
        throw new AppError('NOT_FOUND', 'ไม่พบพนักงานที่ระบุในบริษัทนี้', [
          { field, reason: userId },
        ]);
      }
    }
    return input;
  }

  private async requireShift(companyId: string, id: string) {
    const row = (await this.shifts.findFirst({
      where: { id, companyId, deletedAt: null },
    })) as unknown as ShiftRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบเวรที่ระบุ');
    return row;
  }

  private async escalateMinutes(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { serviceOnCallEscalateMinutes: true },
    })) as { serviceOnCallEscalateMinutes: number } | null;
    return row?.serviceOnCallEscalateMinutes ?? 30;
  }

  /** The company's working calendar — the one the SLA clock counts on. */
  private async calendarOf(companyId: string): Promise<WorkingCalendar> {
    const stored = (await this.calendars.findFirst({
      where: { companyId },
    })) as {
      workdayStartMinute: number;
      workdayEndMinute: number;
      workingWeekdays: number[];
      holidays: unknown;
    } | null;
    if (!stored) return DEFAULT_CALENDAR;
    return {
      workdayStartMinute: stored.workdayStartMinute,
      workdayEndMinute: stored.workdayEndMinute,
      workingWeekdays: stored.workingWeekdays,
      holidays: Array.isArray(stored.holidays)
        ? (stored.holidays as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      timeZone: DEFAULT_CALENDAR.timeZone,
    };
  }

  private view(row: ShiftRow, names: Map<string, string>) {
    return {
      id: row.id,
      startOn: day(row.startOn),
      endOn: day(row.endOn),
      primaryUserId: row.primaryUserId,
      primaryName: names.get(row.primaryUserId) ?? row.primaryUserId,
      backupUserId: row.backupUserId,
      backupName: row.backupUserId
        ? (names.get(row.backupUserId) ?? row.backupUserId)
        : null,
      note: row.note,
    };
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
