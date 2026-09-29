import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditWriter } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import type { RuleAcrossCompanies } from '../notifications/notification-rules.service';
import { CustomerRepository } from './customer.repository';
import { CustomerFieldChangeRepository } from './customer-child.repositories';
import { CustomerTimelineService } from './customer-timeline.service';
import { CustomerKycRecordRepository } from './kyc.repositories';
import { bangkokDay } from './kyc-rules';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface DueRecord {
  id: string;
  companyId: string;
  customerId: string;
  expiresOn: Date;
  customer: {
    id: string;
    customerCode: string;
    nameTh: string;
    accountOwnerUserId: string | null;
  };
}

/**
 * CD-61 — KYC that runs out (user decision 29 ก.ย. 2569): the customer's
 * owner is told `warn_days` ahead (the company's `kyc.expiry` rule, CD-53;
 * standard 30), and on the day the verification expires — the customer is
 * unverified again, so product rules warn as before. Nothing is blocked (PO
 * 8 ก.ย. 2569: KYC warns, never blocks). A company that switched the rule off
 * still has its records expire; only the notices stop.
 *
 * Runs in core-service only (`crm.kycExpiryIntervalMs` is 0 in
 * external-service, which loads the same domain module). Each record is
 * warned once (`warnedAt`) and expired once (a guarded status update), so an
 * overlapping tick or a second instance does nothing twice.
 */
@Injectable()
export class KycExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KycExpiryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly records: CustomerKycRecordRepository,
    private readonly customers: CustomerRepository,
    private readonly fieldChanges: CustomerFieldChangeRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly notifications: NotificationsService,
    private readonly rules: NotificationRulesService,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.kycExpiryIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-61 KYC expiry', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(
    now: Date = new Date(),
  ): Promise<{ warned: number; expired: number }> {
    const today = new Date(`${bangkokDay(now)}T00:00:00Z`);
    const rule = await this.rules.across('kyc.expiry');
    const warnDaysOf = (companyId: string) => {
      const one = rule.of(companyId);
      return one.enabled ? (one.params.warn_days as number) : -1;
    };
    const widest = Math.max(
      -1,
      ...[rule.standard, ...rule.byCompany.values()]
        .filter((one) => one.enabled)
        .map((one) => one.params.warn_days as number),
    );
    const select = {
      id: true,
      companyId: true,
      customerId: true,
      expiresOn: true,
      customer: {
        select: {
          id: true,
          customerCode: true,
          nameTh: true,
          accountOwnerUserId: true,
        },
      },
    } as const;

    // Expired first: a record past its date is not "expiring".
    const expiring = (await this.records.findMany({
      where: { status: 'verified', expiresOn: { lt: today } },
      select,
    })) as unknown as DueRecord[];
    let expired = 0;
    for (const record of expiring) {
      if (await this.expire(record, now, rule)) expired += 1;
    }

    const warning =
      widest < 0
        ? []
        : ((await this.records.findMany({
            where: {
              status: 'verified',
              warnedAt: null,
              expiresOn: {
                gte: today,
                lte: new Date(today.getTime() + widest * DAY_MS),
              },
            },
            select,
          })) as unknown as DueRecord[]);
    let warned = 0;
    for (const record of warning) {
      const daysLeft = Math.round(
        (record.expiresOn.getTime() - today.getTime()) / DAY_MS,
      );
      if (daysLeft > warnDaysOf(record.companyId)) continue;
      const claimed = await this.records.updateMany({
        where: { id: record.id, warnedAt: null },
        data: { warnedAt: now },
      });
      if (claimed.count !== 1) continue;
      warned += 1;
      if (record.customer.accountOwnerUserId) {
        await this.notifications.kycExpiring(
          record.customer.accountOwnerUserId,
          record.companyId,
          record.customer,
          dayOf(record.expiresOn),
        );
      }
    }

    if (warned || expired) {
      this.logger.log(`CD-61: ${warned} KYC warned, ${expired} expired`);
    }
    return { warned, expired };
  }

  private async expire(
    record: DueRecord,
    now: Date,
    rule: RuleAcrossCompanies,
  ): Promise<boolean> {
    const claimed = await this.records.updateMany({
      where: { id: record.id, status: 'verified' },
      data: { status: 'expired' },
    });
    if (claimed.count !== 1) return false;

    const on = dayOf(record.expiresOn);
    await this.customers.update({
      where: { id: record.customerId },
      data: { kycVerified: false },
    });
    await this.fieldChanges.createMany([
      {
        customerId: record.customerId,
        field: 'kycVerified',
        before: true,
        after: false,
        changedBy: null,
      },
    ]);
    await this.audit.record({
      eventType: 'crm.customer.kyc_expired',
      companyId: record.companyId,
      actorId: null,
      actorUsername: 'kyc-expiry',
      resourceType: 'customer',
      resourceId: record.customerId,
      after: { recordId: record.id, expiresOn: on, at: now.toISOString() },
    });
    await this.timeline.publish({
      companyId: record.companyId,
      customerId: record.customerId,
      refType: 'customer',
      refId: record.customerId,
      eventType: 'customer.kyc_expired',
      summary: `KYC หมดอายุเมื่อ ${on} — กลับเป็นยังไม่ยืนยันตัวตน`,
      actorId: null,
      actorName: 'ระบบ (KYC)',
    });
    if (
      record.customer.accountOwnerUserId &&
      rule.of(record.companyId).enabled
    ) {
      await this.notifications.kycExpired(
        record.customer.accountOwnerUserId,
        record.companyId,
        record.customer,
        on,
      );
    }
    return true;
  }
}

function dayOf(value: Date): string {
  return value.toISOString().slice(0, 10);
}
