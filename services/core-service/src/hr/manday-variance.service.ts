import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError, Permission, Principal } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HrBookingRepository,
  HrMandayAlertRepository,
  HrWorkRefsRepository,
} from './hr.repositories';
import { availabilityDays, daysBetween } from './leave-rules';
import { LeavesService } from './leaves.service';
import {
  budgetLaborMandays,
  codeKey,
  compareBreakdown,
  percentOf,
  plannedOnDay,
  round2,
  solutionLaborByCode,
  stepsDue,
  toMandays,
  varianceLabel,
} from './manday-rules';
import { TimesheetsService } from './timesheets.service';

const RULE = 'manday.variance';
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
const day = (value: Date) => value.toISOString().slice(0, 10);
/** Who sees every project's plan against actual. */
const OVERSEERS: Permission[] = [
  'pm.project.read',
  'pm.project.manage',
  'pricing.price.read',
  'pricing.price.manage',
  'hr.employee.read',
  'hr.employee.manage',
];
/** A closed project is summarised (and listed) for this long after. */
const CLOSED_WINDOW_DAYS = 180;
/** Only a project closed this recently gets its summary (not the backlog). */
const SUMMARY_DAYS = 14;

type ProjectRow = Awaited<
  ReturnType<HrWorkRefsRepository['mandayProjects']>
>[number];

interface Plan {
  mandays: number;
  /** Where the plan came from; null = no plan. */
  source: 'budget' | 'solution' | null;
  /** The locked budget's version (0 without one) — steps restart per version. */
  versionNo: number;
}

interface BookingRow {
  id: string;
  userId: string;
  projectId: string;
  startDate: Date;
  endDate: Date;
  hoursPerDay: Prisma.Decimal;
}

/**
 * CD-233 — manday แผนเทียบจริง (part of CD-17 HR).
 *
 * For each project: the plan (labour mandays in its latest locked budget,
 * else in the Solution version it was opened from), what approved
 * timesheets used, the split by HR level × work type (Solution codes against
 * the level each person holds and the work type they logged), and per person
 * what they were booked for (CD-232, less leave) against what they logged.
 *
 * Once a day the company's `manday.variance` rule (CD-53) sends the project
 * manager and the pricing team each step reached (standard 80/100/120 % of
 * plan) — once per step per budget version — and a summary when a project
 * closes, so the next estimate can be better.
 */
@Injectable()
export class MandayVarianceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MandayVarianceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly refs: HrWorkRefsRepository,
    private readonly alerts: HrMandayAlertRepository,
    private readonly bookings: HrBookingRepository,
    private readonly timesheets: TimesheetsService,
    private readonly leaves: LeavesService,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('hr.mandayVarianceIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-233 manday variance', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Every project the caller may see, plan against actual. */
  async list(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const projects = await this.refs.mandayProjects({
      companyId,
      ...(oversees(actor) ? {} : { managerUserId: actor.userId }),
      OR: [
        { status: { in: ['active', 'on_hold'] } },
        { status: 'closed', updatedAt: { gte: closedSince(new Date()) } },
      ],
    });
    const plans = await this.plans(projects);
    const used = await this.refs.approvedHours(
      companyId,
      projects.map((p) => p.id),
    );
    return {
      items: projects.map((project) => {
        const plan = plans.get(project.id)!;
        const actual = toMandays(used.get(project.id) ?? 0);
        return {
          id: project.id,
          label: label(project),
          status: project.status,
          managerUserId: project.managerUserId,
          planned: plan.mandays,
          planSource: plan.source,
          budgetVersionNo: plan.versionNo,
          actual,
          percent: percentOf(actual, plan.mandays),
          variance: round2(actual - plan.mandays),
        };
      }),
    };
  }

  /** One project in detail: totals, level × work type, people, steps sent. */
  async project(actor: Principal, projectId: string) {
    const companyId = actor.activeCompanyId;
    const [project] = await this.refs.mandayProjects({
      id: projectId,
      companyId,
    });
    if (
      !project ||
      (!oversees(actor) && project.managerUserId !== actor.userId)
    ) {
      throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    }
    const [plan] = [...(await this.plans([project])).values()];
    const [actuals, codes, labor, alerts] = await Promise.all([
      this.timesheets.projectActuals(companyId, project.id),
      this.refs.hrCodes(companyId),
      project.solutionVersionId
        ? this.refs.solutionLabor([project.solutionVersionId])
        : Promise.resolve(new Map<string, unknown>()),
      this.alerts.findMany({
        where: { projectId: project.id },
        orderBy: { sentAt: 'asc' },
      }) as unknown as Promise<
        {
          budgetVersionNo: number;
          threshold: number;
          plannedMandays: Prisma.Decimal;
          actualMandays: Prisma.Decimal;
          sentAt: Date;
        }[]
      >,
    ]);
    const levelCode = new Map(codes.levels.map((l) => [l.id, l.code]));
    const workCode = new Map(codes.workTypes.map((w) => [w.id, w.code]));

    // Actual by level × work type, in mandays.
    const actualByCode = new Map<string, number>();
    for (const line of actuals.lines) {
      const key = codeKey(
        line.levelId ? levelCode.get(line.levelId) : null,
        workCode.get(line.workTypeId),
      );
      actualByCode.set(key, (actualByCode.get(key) ?? 0) + line.hours);
    }
    for (const [key, hours] of actualByCode)
      actualByCode.set(key, toMandays(hours));
    const breakdown = compareBreakdown(
      solutionLaborByCode(
        project.solutionVersionId ? labor.get(project.solutionVersionId) : null,
      ),
      actualByCode,
    );

    const people = await this.people(companyId, project.id, actuals.lines);
    const names = await this.refs.names(people.map((p) => p.userId));
    const actual = actuals.mandays;
    return {
      project: {
        id: project.id,
        label: label(project),
        status: project.status,
        managerUserId: project.managerUserId,
        startOn: project.startOn ? day(project.startOn) : null,
        endOn: day(project.endOn),
      },
      planned: plan.mandays,
      planSource: plan.source,
      budgetVersionNo: plan.versionNo,
      solutionMandays: round2(
        [
          ...solutionLaborByCode(
            project.solutionVersionId
              ? labor.get(project.solutionVersionId)
              : null,
          ).values(),
        ].reduce((sum, value) => sum + value, 0),
      ),
      actual,
      actualHours: actuals.hours,
      billableMandays: toMandays(
        actuals.lines
          .filter((line) => line.billable)
          .reduce((sum, line) => sum + line.hours, 0),
      ),
      percent: percentOf(actual, plan.mandays),
      variance: round2(actual - plan.mandays),
      breakdown: breakdown.map((row) => ({
        ...row,
        levelName:
          codes.levels.find((l) => l.code === row.levelCode)?.name ?? null,
        workTypeName:
          codes.workTypes.find((w) => w.code === row.workTypeCode)?.name ??
          null,
      })),
      people: people.map((person) => ({
        ...person,
        name: names.get(person.userId) ?? person.userId,
      })),
      alerts: alerts.map((alert) => ({
        budgetVersionNo: alert.budgetVersionNo,
        threshold: alert.threshold,
        planned: Number(alert.plannedMandays),
        actual: Number(alert.actualMandays),
        sentAt: alert.sentAt,
      })),
    };
  }

  /**
   * The daily pass: for every running (or lately closed) project of a
   * company whose rule is on, send the steps reached, and the summary of a
   * closed one.
   */
  async sweep(now: Date = new Date()): Promise<{ sent: number }> {
    const rule = await this.rules.across(RULE);
    if (![rule.standard, ...rule.byCompany.values()].some((r) => r.enabled))
      return { sent: 0 };
    const projects = await this.refs.mandayProjects({
      OR: [
        { status: { in: ['active', 'on_hold'] } },
        { status: 'closed', updatedAt: { gte: closedSince(now) } },
      ],
    });
    const byCompany = new Map<string, ProjectRow[]>();
    for (const project of projects) {
      const list = byCompany.get(project.companyId) ?? [];
      list.push(project);
      byCompany.set(project.companyId, list);
    }
    let sent = 0;
    for (const [companyId, list] of byCompany) {
      const own = rule.of(companyId);
      if (!own.enabled) continue;
      const steps = own.params.percents as number[];
      const [plans, used, pricing] = await Promise.all([
        this.plans(list),
        this.refs.approvedHours(
          companyId,
          list.map((p) => p.id),
        ),
        this.refs.holdersOf(companyId, 'pricing.price.manage'),
      ]);
      const sentRows = (await this.alerts.findMany({
        where: { projectId: { in: list.map((p) => p.id) } },
        select: { projectId: true, budgetVersionNo: true, threshold: true },
      })) as unknown as {
        projectId: string;
        budgetVersionNo: number;
        threshold: number;
      }[];
      for (const project of list) {
        const plan = plans.get(project.id)!;
        const actual = toMandays(used.get(project.id) ?? 0);
        const done = sentRows
          .filter(
            (row) =>
              row.projectId === project.id &&
              row.budgetVersionNo === plan.versionNo,
          )
          .map((row) => row.threshold);
        const recipients = [...new Set([project.managerUserId, ...pricing])];
        const closing =
          project.status === 'closed' &&
          project.updatedAt >=
            new Date(now.getTime() - SUMMARY_DAYS * 86_400_000) &&
          !sentRows.some(
            (row) => row.projectId === project.id && row.threshold === 0,
          );
        const due = closing
          ? [0]
          : stepsDue(percentOf(actual, plan.mandays), steps, done);
        // The highest step reached says it all; the rest are recorded as sent.
        const top = Math.max(...due);
        for (const threshold of due) {
          const claimed = await this.claim(
            companyId,
            project.id,
            plan.versionNo,
            threshold,
            plan.mandays,
            actual,
          );
          if (!claimed || threshold !== top) continue;
          for (const userId of recipients) {
            if (threshold === 0) {
              await this.notifications.mandayClosed(
                userId,
                companyId,
                { id: project.id, label: label(project) },
                actual,
                plan.mandays,
                varianceLabel(actual, plan.mandays),
              );
            } else {
              await this.notifications.mandayThreshold(
                userId,
                companyId,
                { id: project.id, label: label(project) },
                percentOf(actual, plan.mandays) ?? 0,
                actual,
                plan.mandays,
              );
            }
          }
          sent += 1;
        }
      }
    }
    return { sent };
  }

  // --- helpers ----------------------------------------------------------------

  /** The plan of each project: locked budget labour, else the Solution's. */
  private async plans(projects: ProjectRow[]) {
    const budgets = await this.refs.lockedBudgets(projects.map((p) => p.id));
    const labor = await this.refs.solutionLabor(
      projects
        .filter((p) => !budgets.has(p.id) && p.solutionVersionId)
        .map((p) => p.solutionVersionId!),
    );
    return new Map<string, Plan>(
      projects.map((project): [string, Plan] => {
        const budget = budgets.get(project.id);
        if (budget) {
          return [
            project.id,
            {
              mandays: budgetLaborMandays(budget.lines),
              source: 'budget',
              versionNo: budget.versionNo,
            },
          ];
        }
        const lines = project.solutionVersionId
          ? labor.get(project.solutionVersionId)
          : null;
        return [
          project.id,
          {
            mandays: round2(
              [...solutionLaborByCode(lines).values()].reduce(
                (sum, value) => sum + value,
                0,
              ),
            ),
            source: lines ? 'solution' : null,
            versionNo: 0,
          },
        ];
      }),
    );
  }

  /** Per person: booked (less leave) against logged, to date and in all. */
  private async people(
    companyId: string,
    projectId: string,
    lines: { userId: string; hours: number; date: string }[],
  ) {
    const rows = (await this.bookings.findMany({
      where: { companyId, projectId, cancelledAt: null },
    })) as unknown as BookingRow[];
    const today = thaiToday();
    const userIds = [
      ...new Set([...rows.map((r) => r.userId), ...lines.map((l) => l.userId)]),
    ];
    const planned = new Map<string, { total: number; toDate: number }>();
    if (rows.length) {
      const from = day(
        new Date(Math.min(...rows.map((r) => r.startDate.getTime()))),
      );
      const to = day(
        new Date(Math.max(...rows.map((r) => r.endDate.getTime()))),
      );
      const [calendar, leaves] = await Promise.all([
        this.leaves.workDays(companyId),
        this.leaves.holding(companyId, userIds, from, to, () => false),
      ]);
      const days = daysBetween(from, to);
      for (const userId of new Set(rows.map((r) => r.userId))) {
        const grid = availabilityDays(
          days,
          calendar,
          leaves.get(userId) ?? [],
          rows
            .filter((r) => r.userId === userId)
            .map((r) => ({
              id: r.id,
              projectId: r.projectId,
              startDate: day(r.startDate),
              endDate: day(r.endDate),
              hoursPerDay: Number(r.hoursPerDay),
            })),
        );
        let total = 0;
        let toDate = 0;
        for (const one of grid) {
          const hours = plannedOnDay(one);
          total += hours;
          if (one.day <= today) toDate += hours;
        }
        planned.set(userId, { total, toDate });
      }
    }
    return userIds
      .map((userId) => {
        const plan = planned.get(userId) ?? { total: 0, toDate: 0 };
        const actualHours = lines
          .filter((line) => line.userId === userId)
          .reduce((sum, line) => sum + line.hours, 0);
        return {
          userId,
          plannedMandays: toMandays(plan.total),
          plannedToDateMandays: toMandays(plan.toDate),
          actualMandays: toMandays(actualHours),
          percentToDate: percentOf(actualHours, plan.toDate),
        };
      })
      .sort((a, b) => b.actualMandays - a.actualMandays);
  }

  /** Record a step as sent; false when another pass already did. */
  private async claim(
    companyId: string,
    projectId: string,
    budgetVersionNo: number,
    threshold: number,
    planned: number,
    actual: number,
  ) {
    try {
      await this.alerts.create({
        data: {
          companyId,
          projectId,
          budgetVersionNo,
          threshold,
          plannedMandays: planned,
          actualMandays: actual,
        },
      });
      return true;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return false;
      throw error;
    }
  }
}

function oversees(actor: Principal) {
  return OVERSEERS.some((permission) => actor.permissions.includes(permission));
}

function closedSince(now: Date) {
  return new Date(now.getTime() - CLOSED_WINDOW_DAYS * 86_400_000);
}

function label(project: { projectNo: string; name: string }) {
  return `${project.projectNo} · ${project.name}`;
}
