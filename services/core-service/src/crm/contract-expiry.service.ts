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
import { CustomerContractRepository } from './contract.repositories';
import { bangkokDay } from './kyc-rules';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RULE = 'contract.expiry';

interface Ending {
  id: string;
  companyId: string;
  contractNo: string;
  title: string;
  endOn: Date;
  ownerUserId: string;
  remindedDays: number[];
  counterpartyName: string | null;
  customer: { nameTh: string } | null;
}

/**
 * The steps due now: every warning day reached and not yet sent, plus the
 * day it ends (step 0). One notice per pass however many were crossed.
 */
export function stepsReached(
  daysLeft: number,
  warnDays: readonly number[],
  sent: readonly number[],
): number[] {
  const steps = [...warnDays, 0].filter(
    (days) => daysLeft <= days && !sent.includes(days),
  );
  return [...new Set(steps)];
}

/**
 * CD-162 — แจ้งเตือนหมดอายุ for the contracts CD-70 does not renew through
 * Sales: NDAs, "other" contracts, and anything with a counterparty outside
 * the customer register. Their owner is told `warn_days` before the end (the
 * company's `contract.expiry` rule, standard 60/30/7) and on the day itself.
 * Customer sale/service contracts and MSAs keep CD-70's renewal deal.
 *
 * Sent steps are kept in `remindedDays` (the same column CD-70 uses — the
 * two sweeps never look at the same contract), so an extended end date,
 * which clears it, warns afresh. Runs in core-service only.
 */
@Injectable()
export class ContractExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractExpiryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly contracts: CustomerContractRepository,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.contractExpiryIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-162 contract expiry', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<{ warned: number }> {
    const rule = await this.rules.across(RULE);
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (one) => one.enabled,
    );
    if (!enabled.length) return { warned: 0 };
    const widest = Math.max(
      0,
      ...enabled.flatMap((one) => one.params.warn_days as number[]),
    );
    const today = new Date(`${bangkokDay(now)}T00:00:00Z`);

    const due = (await this.contracts.findMany({
      where: {
        status: 'active',
        endOn: { gte: today, lte: new Date(today.getTime() + widest * DAY_MS) },
        // not on CD-70's renewal path
        OR: [{ customerId: null }, { kind: { in: ['nda', 'other'] } }],
      },
      select: {
        id: true,
        companyId: true,
        contractNo: true,
        title: true,
        endOn: true,
        ownerUserId: true,
        remindedDays: true,
        counterpartyName: true,
        customer: { select: { nameTh: true } },
      },
      take: 500,
    })) as unknown as Ending[];

    let warned = 0;
    for (const contract of due) {
      const own = rule.of(contract.companyId);
      if (!own.enabled) continue;
      const daysLeft = Math.round(
        (contract.endOn.getTime() - today.getTime()) / DAY_MS,
      );
      const reached = stepsReached(
        daysLeft,
        own.params.warn_days as number[],
        contract.remindedDays,
      );
      if (!reached.length) continue;
      // Guarded on the list as read: an overlapping tick sends nothing twice.
      const claimed = await this.contracts.updateMany({
        where: {
          id: contract.id,
          remindedDays: { equals: contract.remindedDays },
        },
        data: { remindedDays: [...contract.remindedDays, ...reached] },
      });
      if (claimed.count !== 1) continue;
      await this.notifications.contractExpiry(
        contract.ownerUserId,
        contract.companyId,
        {
          id: contract.id,
          contractNo: contract.contractNo,
          title: contract.title,
          party: contract.customer?.nameTh ?? contract.counterpartyName ?? '',
          endOn: bangkokDay(contract.endOn),
        },
        daysLeft,
      );
      warned += 1;
    }
    if (warned) this.logger.log(`CD-162: ${warned} expiry notice(s)`);
    return { warned };
  }
}
