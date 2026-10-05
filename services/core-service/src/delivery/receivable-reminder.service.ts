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
import { DEFAULT_CREDIT_DAYS } from '../pm/payment-rules';

const RULE = 'receivable.overdue';
const DEFAULT_INTERVAL_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;

interface Overdue {
  companyId: string;
  ownerUserId: string;
  amount: number;
  days: number;
}

/**
 * CD-256 — งวดค้างชำระ: every `days` days (the company's `receivable.overdue`
 * rule, CD-53, standard 7) each salesperson is told of their own contracts'
 * installments billed and past due but not paid, and finance
 * (`delivery.receivable.read`) of every contract's — one digest each:
 * how many, how much, the oldest. Read live (not from the mart), with the
 * same due day as CD-193: invoice + credit days.
 */
@Injectable()
export class ReceivableReminderService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReceivableReminderService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('delivery.receivableIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-256 overdue installments', () =>
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

  async sweep(now: Date = new Date()): Promise<{ sent: number }> {
    const rule = await this.rules.across(RULE);
    if (![rule.standard, ...rule.byCompany.values()].some((r) => r.enabled))
      return { sent: 0 };
    const today = thaiToday(now);
    const cutoff = new Date(`${today}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - DEFAULT_CREDIT_DAYS);
    const billings = await this.prisma.contractInstallmentBilling.findMany({
      where: { paidOn: null, invoicedOn: { not: null, lt: cutoff } },
      select: {
        companyId: true,
        contractId: true,
        seq: true,
        invoicedOn: true,
        invoicedAmount: true,
      },
    });
    if (!billings.length) return { sent: 0 };
    const contracts = await this.prisma.customerContract.findMany({
      where: { id: { in: [...new Set(billings.map((b) => b.contractId))] } },
      select: {
        id: true,
        ownerUserId: true,
        installments: { select: { seq: true, amount: true } },
      },
    });
    const overdue: Overdue[] = [];
    for (const b of billings) {
      const contract = contracts.find((c) => c.id === b.contractId);
      if (!contract) continue;
      const amount =
        b.invoicedAmount ??
        contract.installments.find((i) => i.seq === b.seq)?.amount ??
        new Prisma.Decimal(0);
      overdue.push({
        companyId: b.companyId,
        ownerUserId: contract.ownerUserId,
        amount: Number(amount),
        // today − (invoice + credit days)
        days: Math.round((cutoff.getTime() - b.invoicedOn!.getTime()) / DAY_MS),
      });
    }

    let sent = 0;
    for (const companyId of new Set(overdue.map((o) => o.companyId))) {
      const own = rule.of(companyId);
      if (!own.enabled) continue;
      const every = typeof own.params.days === 'number' ? own.params.days : 7;
      const rows = overdue.filter((o) => o.companyId === companyId);
      const finance = await this.financeTeam(companyId);
      const recipients = new Map<string, Overdue[]>();
      for (const userId of finance) recipients.set(userId, rows);
      for (const row of rows) {
        if (finance.has(row.ownerUserId)) continue;
        recipients.set(row.ownerUserId, [
          ...(recipients.get(row.ownerUserId) ?? []),
          row,
        ]);
      }
      for (const [userId, list] of recipients) {
        const last = await this.prisma.receivableReminder.findUnique({
          where: { companyId_userId: { companyId, userId } },
        });
        if (
          last &&
          now.getTime() - last.sentAt.getTime() < every * DAY_MS - 3_600_000
        )
          continue;
        const amount = list.reduce((s, r) => s + r.amount, 0);
        await this.prisma.receivableReminder.upsert({
          where: { companyId_userId: { companyId, userId } },
          create: {
            companyId,
            userId,
            sentAt: now,
            count: list.length,
            amount,
          },
          update: { sentAt: now, count: list.length, amount },
        });
        await this.notifications.receivablesOverdue(
          userId,
          companyId,
          list.length,
          amount,
          Math.max(...list.map((r) => r.days)),
          finance.has(userId),
        );
        sent += 1;
      }
    }
    return { sent };
  }

  private async financeTeam(companyId: string) {
    const rows = await this.prisma.userRole.findMany({
      where: {
        companyId,
        role: {
          active: true,
          permissions: {
            some: { permissionCode: 'delivery.receivable.read' },
          },
        },
      },
      select: { userId: true },
    });
    return new Set(rows.map((r) => r.userId));
  }
}
