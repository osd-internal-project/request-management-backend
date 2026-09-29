import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OpportunityStage } from '@prisma/client';
import { backgroundTick } from '../common/background-tick';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { CustomerContractRepository } from './contract.repositories';
import { bangkokDay } from './kyc-rules';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityRepository } from './sales.repositories';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** CD-53 — how far ahead to open the deal and when to remind: a rule per company. */
const RULE = 'contract.renewal';

interface DueContract {
  id: string;
  companyId: string;
  customerId: string | null;
  contractNo: string;
  title: string;
  endOn: Date;
  value: { toString(): string } | null;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
  renewalOpportunityId: string | null;
  remindedDays: number[];
}

const SELECT = {
  id: true,
  companyId: true,
  customerId: true,
  contractNo: true,
  title: true,
  endOn: true,
  value: true,
  ownerUserId: true,
  ownerOrgUnitId: true,
  renewalOpportunityId: true,
  remindedDays: true,
} as const;

const OPEN_STAGES: OpportunityStage[] = [
  'qualifying',
  'proposing',
  'negotiating',
];

/**
 * CD-70 — renewals from contract end dates (user decision 29 ก.ย. 2569). The
 * days are the company's `contract.renewal` rule (CD-53; standard 90 / 60, 30);
 * a company that switched the rule off gets neither deals nor reminders:
 *
 * - `open_days` out: a renewal deal is opened under the contract's owner (same
 *   customer, the contract's value, expected to close on the end date), and
 *   the owner is told;
 * - each of `remind_days`: the owner is reminded — only while that deal is
 *   still open; won or lost, the reminders stop;
 * - after the end date: the contract is `renewed` if its renewal deal was
 *   won, otherwise `ended`.
 *
 * Every step is claimed with a guarded update before it acts, so a second
 * instance or an overlapping tick does nothing twice. Runs in core-service
 * only (`crm.contractRenewalIntervalMs` is 0 in external-service).
 */
@Injectable()
export class ContractRenewalService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractRenewalService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly contracts: CustomerContractRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly deals: OpportunitiesService,
    private readonly notifications: NotificationsService,
    private readonly rules: NotificationRulesService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.contractRenewalIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-70 contract renewal', () => this.sweep()),
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
  ): Promise<{ opened: number; reminded: number; closed: number }> {
    const today = new Date(`${bangkokDay(now)}T00:00:00Z`);
    const within = (days: number) => new Date(today.getTime() + days * DAY_MS);

    // 1. past the end date → renewed or ended
    let closed = 0;
    const past = (await this.contracts.findMany({
      where: { status: 'active', endOn: { lt: today } },
      select: SELECT,
    })) as unknown as DueContract[];
    for (const contract of past) {
      const won = contract.renewalOpportunityId
        ? await this.opportunities.findFirst({
            where: { id: contract.renewalOpportunityId, stage: 'won' },
            select: { id: true },
          })
        : null;
      const moved = await this.contracts.updateMany({
        where: { id: contract.id, status: 'active' },
        data: { status: won ? 'renewed' : 'ended' },
      });
      closed += moved.count;
    }

    const rule = await this.rules.across(RULE);
    const enabled = [rule.standard, ...rule.byCompany.values()].filter(
      (one) => one.enabled,
    );
    const openDaysOf = (companyId: string) => {
      const one = rule.of(companyId);
      return one.enabled ? (one.params.open_days as number) : -1;
    };
    const remindDaysOf = (companyId: string) => {
      const one = rule.of(companyId);
      return one.enabled ? (one.params.remind_days as number[]) : [];
    };
    // One read covering the widest window; each company's own is applied below.
    const widest = (key: 'open_days' | 'remind_days') =>
      Math.max(-1, ...enabled.flatMap((one) => one.params[key]));

    // 2. within the company's window and no renewal deal yet → open one
    let opened = 0;
    const toOpen = (
      widest('open_days') < 0
        ? []
        : ((await this.contracts.findMany({
            where: {
              status: 'active',
              renewalOpportunityId: null,
              renewalCreatedAt: null,
              // CD-161 — a renewal deal needs a customer, and only a sale or
              // service agreement is renewed through Sales (not an NDA, not
              // a vendor's contract).
              customerId: { not: null },
              kind: { in: ['standard', 'msa'] },
              endOn: { gte: today, lte: within(widest('open_days')) },
            },
            select: SELECT,
          })) as unknown as DueContract[])
    ).filter(
      (contract) =>
        daysBetween(today, contract.endOn) <= openDaysOf(contract.companyId),
    );
    for (const contract of toOpen) {
      const claimed = await this.contracts.updateMany({
        where: { id: contract.id, renewalCreatedAt: null },
        data: { renewalCreatedAt: now },
      });
      if (claimed.count !== 1) continue;
      try {
        const deal = await this.deals.createRenewal({
          companyId: contract.companyId,
          // filtered to customer contracts above
          customerId: contract.customerId as string,
          title: `ต่ออายุ: ${contract.title}`,
          amount:
            contract.value === null ? null : Number(contract.value.toString()),
          expectedCloseAt: contract.endOn,
          ownerUserId: contract.ownerUserId,
          ownerOrgUnitId: contract.ownerOrgUnitId,
          contractNo: contract.contractNo,
        });
        // Opened late (a contract entered inside the window): the reminders
        // already due are covered by this notice, not sent on top of it.
        const daysLeft = daysBetween(today, contract.endOn);
        await this.contracts.update({
          where: { id: contract.id },
          data: {
            renewalOpportunityId: deal.id,
            remindedDays: remindDaysOf(contract.companyId).filter(
              (days) => daysLeft <= days,
            ),
          },
        });
        await this.notifications.contractRenewalOpened(
          contract.ownerUserId,
          contract.companyId,
          contract,
          deal,
          daysLeft,
        );
        opened += 1;
      } catch (error) {
        // Release the claim so the next tick tries again.
        await this.contracts.update({
          where: { id: contract.id },
          data: { renewalCreatedAt: null },
        });
        this.logger.error(
          `renewal for contract ${contract.contractNo} failed`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    // 3. a reminder step reached while the renewal deal is open — one notice
    // per pass, however many steps it crossed (only the latest matters)
    let reminded = 0;
    const toRemind =
      widest('remind_days') < 0
        ? []
        : ((await this.contracts.findMany({
            where: {
              status: 'active',
              renewalOpportunityId: { not: null },
              endOn: { gte: today, lte: within(widest('remind_days')) },
            },
            select: SELECT,
          })) as unknown as DueContract[]);
    for (const contract of toRemind) {
      const daysLeft = daysBetween(today, contract.endOn);
      const reached = remindDaysOf(contract.companyId).filter(
        (days) => daysLeft <= days && !contract.remindedDays.includes(days),
      );
      if (!reached.length) continue;
      // Guarded on the list as read: an overlapping tick claims nothing twice.
      const claimed = await this.contracts.updateMany({
        where: {
          id: contract.id,
          remindedDays: { equals: contract.remindedDays },
        },
        data: { remindedDays: [...contract.remindedDays, ...reached] },
      });
      if (claimed.count !== 1) continue;
      // A decided deal needs no reminder; the stamp still stops re-checks.
      const deal = (await this.opportunities.findFirst({
        where: {
          id: contract.renewalOpportunityId as string,
          stage: { in: OPEN_STAGES },
        },
        select: { id: true, opportunityCode: true },
      })) as { id: string; opportunityCode: string } | null;
      if (!deal) continue;
      await this.notifications.contractRenewalDue(
        contract.ownerUserId,
        contract.companyId,
        contract,
        deal,
        daysLeft,
      );
      reminded += 1;
    }

    if (opened || reminded || closed) {
      this.logger.log(
        `CD-70: ${opened} renewal deal(s) opened, ${reminded} reminder(s), ${closed} contract(s) closed`,
      );
    }
    return { opened, reminded, closed };
  }
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}
