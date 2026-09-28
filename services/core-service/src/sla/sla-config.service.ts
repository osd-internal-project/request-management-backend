import { Injectable } from '@nestjs/common';
import {
  AppError,
  auditActor,
  AuditWriter,
  PrismaService,
  PrismaTransactionService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma } from '@prisma/client';
import { ReplaceHolidayCalendarDto, ReplaceSlaConfigsDto } from './dto/sla.dto';
import { readSeverityTargets, severityTargetProblems } from './severity';

/**
 * SUP-01 / D-09 — SLA values and the working calendar, as configuration.
 *
 * Editing these must never change a clock already running: `SlaClock` stores
 * its own `dueAt`, computed when the request was submitted, so a company that
 * shortens its SLA tomorrow does not retroactively breach work submitted
 * today (§7 — running work keeps the rules it started under).
 */
@Injectable()
export class SlaConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  listConfigs(actor: Principal, companyId?: string) {
    return this.prisma.slaConfig.findMany({
      where: { companyId: resolveTargetCompany(actor, companyId) },
      orderBy: { requestTypeCode: 'asc' },
    });
  }

  /**
   * Replaces the whole table for one company, in a single transaction.
   *
   * Delete-then-insert rather than a diff: the admin screen owns the complete
   * list, and a half-applied replace would leave types with a stale clock and
   * no sign of which ones.
   */
  async replaceConfigs(dto: ReplaceSlaConfigsDto, actor: Principal) {
    const companyId = resolveTargetCompany(actor, dto.company_id);

    const duplicate = dto.configs
      .map((entry) => entry.request_type_code)
      .find((code, index, all) => all.indexOf(code) !== index);

    if (duplicate) {
      throw new AppError('VALIDATION_FAILED', 'มีประเภทคำขอซ้ำในรายการ', [
        { field: 'request_type_code', reason: duplicate },
      ]);
    }

    // CD-67 — a case type's targets are checked here, the one place they are
    // written; the clock reads them without re-validating.
    const badTargets = dto.configs.flatMap((entry) =>
      entry.severity_targets
        ? severityTargetProblems(entry.severity_targets).map((reason) => ({
            field: `severity_targets.${entry.request_type_code}`,
            reason,
          }))
        : [],
    );
    if (badTargets.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `เป้าเวลาตามความรุนแรงไม่ถูกต้อง: ${badTargets[0].reason}`,
        badTargets,
      );
    }

    return this.transactions.execute(async (prisma) => {
      const before = await prisma.slaConfig.findMany({ where: { companyId } });

      await prisma.slaConfig.deleteMany({ where: { companyId } });

      await prisma.slaConfig.createMany({
        data: dto.configs.map((entry) => ({
          companyId,
          requestTypeCode: entry.request_type_code,
          hours: entry.hours,
          coverage: entry.coverage ?? 'H24X7',
          warnBeforeHours: entry.warn_before_hours ?? 4,
          severityTargets: entry.severity_targets
            ? (readSeverityTargets(
                entry.severity_targets,
              ) as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
          updatedBy: actor.userId,
        })),
      });

      const after = await prisma.slaConfig.findMany({
        where: { companyId },
        orderBy: { requestTypeCode: 'asc' },
      });

      await this.audit.record(
        {
          eventType: 'sla.config.replaced',
          companyId,
          ...auditActor(actor),
          resourceType: 'sla_config',
          resourceId: companyId,
          before: before,
          after: after,
        },
        { prisma },
      );

      return after;
    });
  }

  listCalendars(actor: Principal) {
    // Every company the caller belongs to: the screen shows them side by side,
    // and one request per company would make it N round trips.
    return this.prisma.holidayCalendar.findMany({
      where: { companyId: { in: actor.companies.map((c) => c.id) } },
      orderBy: { companyId: 'asc' },
    });
  }

  /** Upsert — a company has at most one calendar this sprint (§09). */
  async replaceCalendar(
    companyId: string,
    dto: ReplaceHolidayCalendarDto,
    actor: Principal,
  ) {
    const target = resolveTargetCompany(actor, companyId);

    const start = dto.workday_start_minute;
    const end = dto.workday_end_minute;

    // Checked here rather than by a validator because it is a relationship
    // between two fields: a day that ends before it starts yields negative
    // working time, and every SLA computed from it would be nonsense.
    if (start !== undefined && end !== undefined && end <= start) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เวลาเลิกงานต้องหลังเวลาเริ่มงาน',
        [{ field: 'workday_end_minute', reason: `${end} <= ${start}` }],
      );
    }

    const data = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(start !== undefined ? { workdayStartMinute: start } : {}),
      ...(end !== undefined ? { workdayEndMinute: end } : {}),
      ...(dto.working_weekdays !== undefined
        ? { workingWeekdays: dto.working_weekdays }
        : {}),
      ...(dto.holidays !== undefined
        ? { holidays: dto.holidays as unknown as Prisma.InputJsonValue }
        : {}),
    };

    return this.transactions.execute(async (prisma) => {
      const before = await prisma.holidayCalendar.findUnique({
        where: { companyId: target },
      });

      const saved = await prisma.holidayCalendar.upsert({
        where: { companyId: target },
        create: { companyId: target, ...data },
        update: data,
      });

      await this.audit.record(
        {
          eventType: 'sla.calendar.replaced',
          companyId: target,
          ...auditActor(actor),
          resourceType: 'holiday_calendar',
          resourceId: saved.id,
          before: before as unknown as Prisma.InputJsonValue,
          after: saved,
        },
        { prisma },
      );

      return saved;
    });
  }
}
