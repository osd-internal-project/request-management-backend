import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { thaiToday } from '../crm/vendor-costs';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { retentionDue } from './billing-rules';

const RULE = 'retention.release';
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
const day = (value: Date) => value.toISOString().slice(0, 10);

/**
 * CD-253 — คืนเงินประกันผลงาน: `days` before the warranty of a contract with
 * a retention installment ends (the company's `retention.release` rule,
 * CD-53, standard 30), its project's manager and the delivery team are told
 * to prepare the release — once for each warranty end date.
 */
@Injectable()
export class RetentionReminderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetentionReminderService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('delivery.retentionIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-253 retention reminder', () =>
        this.sweep(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<{ reminded: number }> {
    const rule = await this.rules.across(RULE);
    if (![rule.standard, ...rule.byCompany.values()].some((r) => r.enabled))
      return { reminded: 0 };
    const today = thaiToday(now);
    const retentions = await this.prisma.contractInstallment.findMany({
      where: {
        kind: 'retention',
        contract: {
          project: { status: { in: ['active', 'on_hold', 'closed'] } },
        },
      },
      select: {
        companyId: true,
        contractId: true,
        seq: true,
        label: true,
        contract: {
          select: {
            contractNo: true,
            project: {
              select: {
                id: true,
                projectNo: true,
                name: true,
                managerUserId: true,
              },
            },
          },
        },
      },
    });
    let reminded = 0;
    for (const inst of retentions) {
      const project = inst.contract.project;
      if (!project) continue;
      const own = rule.of(inst.companyId);
      if (!own.enabled) continue;
      const billed = await this.prisma.installmentInvoice.count({
        where: { contractId: inst.contractId, seq: inst.seq, status: 'sent' },
      });
      if (billed) continue;
      const warranty = await this.prisma.serviceEntitlement.aggregate({
        where: {
          kind: 'warranty',
          cancelledAt: null,
          OR: [{ contractId: inst.contractId }, { projectId: project.id }],
        },
        _max: { endOn: true },
      });
      const ends = warranty._max.endOn ? day(warranty._max.endOn) : null;
      const days = typeof own.params.days === 'number' ? own.params.days : 30;
      if (!ends || !retentionDue(ends, today, days)) continue;
      try {
        await this.prisma.retentionReminder.create({
          data: {
            companyId: inst.companyId,
            contractId: inst.contractId,
            seq: inst.seq,
            dueOn: new Date(`${ends}T00:00:00Z`),
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          continue;
        throw error;
      }
      const team = await this.prisma.userRole.findMany({
        where: {
          companyId: inst.companyId,
          role: {
            active: true,
            permissions: { some: { permissionCode: 'delivery.manage' } },
          },
        },
        select: { userId: true },
      });
      for (const userId of new Set([
        project.managerUserId,
        ...team.map((t) => t.userId),
      ])) {
        await this.notifications.retentionDue(
          userId,
          inst.companyId,
          { id: project.id, label: `${project.projectNo} · ${project.name}` },
          `${inst.seq}. ${inst.label}`,
          ends,
        );
      }
      reminded += 1;
    }
    return { reminded };
  }
}
