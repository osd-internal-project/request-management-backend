import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { backgroundTick } from '../common/background-tick';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomerAccountPlanRepository } from './keeper.repositories';
import { bangkokDay } from './kyc-rules';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface DuePlan {
  id: string;
  companyId: string;
  nextReviewOn: Date;
  customer: {
    id: string;
    customerCode: string;
    nameTh: string;
    accountOwnerUserId: string | null;
  };
}

/**
 * CD-86 — Review & Reconnect: the account owner is told `warn_days` before a
 * customer's next review (the company's `customer.review` rule, CD-53;
 * standard 7). Once per review date: `reviewRemindedOn` holds the date
 * reminded, so a review done (which moves the date) or a date edited is a
 * fresh reminder, and a repeat tick is nothing. Runs in core-service only
 * (`crm.accountReviewIntervalMs` is 0 in external-service).
 */
@Injectable()
export class AccountReviewReminderService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AccountReviewReminderService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly plans: CustomerAccountPlanRepository,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.accountReviewIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-86 account reviews', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<{ reminded: number }> {
    const rule = await this.rules.across('customer.review');
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (one) => one.enabled,
    );
    if (!enabled.length) return { reminded: 0 };
    const widest = Math.max(
      ...enabled.map((one) => one.params.warn_days as number),
    );
    const today = new Date(`${bangkokDay(now)}T00:00:00Z`);

    const due = (await this.plans.findMany({
      where: {
        nextReviewOn: { lte: new Date(today.getTime() + widest * DAY_MS) },
        customer: {
          status: { in: ['active', 'suspended'] },
          mergedIntoCustomerId: null,
          accountOwnerUserId: { not: null },
        },
      },
      select: {
        id: true,
        companyId: true,
        nextReviewOn: true,
        reviewRemindedOn: true,
        customer: {
          select: {
            id: true,
            customerCode: true,
            nameTh: true,
            accountOwnerUserId: true,
          },
        },
      },
      take: 500,
    })) as unknown as (DuePlan & { reviewRemindedOn: Date | null })[];

    let reminded = 0;
    for (const plan of due) {
      const own = rule.of(plan.companyId);
      if (!own.enabled) continue;
      if (plan.reviewRemindedOn?.getTime() === plan.nextReviewOn.getTime())
        continue;
      const daysLeft = Math.round(
        (plan.nextReviewOn.getTime() - today.getTime()) / DAY_MS,
      );
      if (daysLeft > (own.params.warn_days as number)) continue;
      // Guarded on the value read: an overlapping tick reminds nobody twice.
      const claimed = await this.plans.updateMany({
        where: { id: plan.id, reviewRemindedOn: plan.reviewRemindedOn },
        data: { reviewRemindedOn: plan.nextReviewOn },
      });
      if (claimed.count !== 1) continue;
      await this.notifications.accountReviewDue(
        plan.customer.accountOwnerUserId as string,
        plan.companyId,
        plan.customer,
        plan.nextReviewOn.toISOString().slice(0, 10),
      );
      reminded += 1;
    }
    if (reminded) this.logger.log(`CD-86: ${reminded} review reminder(s)`);
    return { reminded };
  }
}
