import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { backgroundTick } from '../common/background-tick';
import { ERP_CLIENT, ERP_SYSTEM } from '../erp/erp-client';
import type { ErpClient, ErpInvoice } from '../erp/erp-client';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InvoiceOverdueAlertRepository } from './contract.repositories';
import { CustomerExternalCodeRepository } from './customer-child.repositories';
import { INVOICE_LIMIT } from './customer-invoices.service';
import { bangkokDay } from './kyc-rules';

const DEFAULT_INTERVAL_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RULE = 'invoice.overdue';

interface LinkedCustomer {
  customerId: string;
  externalCode: string;
  customer: {
    id: string;
    companyId: string;
    customerCode: string;
    nameTh: string;
    accountOwnerUserId: string | null;
    company: { code: string };
  };
}

/**
 * CD-53 — "งวดเลยกำหนดชำระ": an open SAP invoice past its due date by one of
 * the company's `invoice.overdue` steps (standard 1 and 30 days) is told to
 * the customer's owner, once per invoice per step. Crossing several steps in
 * one pass (a rule just switched on, SAP down for a week) sends one notice,
 * for the furthest step — the others are recorded as covered.
 *
 * Invoices are read from SAP (CD-89, read-only) once per Bangkok day, for
 * customers that have a BP number and an owner. Never in mock mode: the mock
 * invents invoices, and a reminder about an invented debt is worse than none
 * (the same rule as the 360° finance card). SAP not answering for one
 * customer skips that customer until the next day's pass.
 *
 * Only the newest {@link INVOICE_LIMIT} invoices per customer are read — the
 * same list the 360° tab shows.
 *
 * Runs in core-service only (`crm.invoiceOverdueIntervalMs` is 0 in
 * external-service).
 */
@Injectable()
export class InvoiceOverdueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvoiceOverdueService.name);
  private timer: NodeJS.Timeout | null = null;
  /** The Bangkok day the last complete pass ran — one pass a day is enough. */
  private lastPassDay: string | null = null;

  constructor(
    private readonly externalCodes: CustomerExternalCodeRepository,
    private readonly alerts: InvoiceOverdueAlertRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly rules: NotificationRulesService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('crm.invoiceOverdueIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-53 overdue invoices', async () => {
        const day = bangkokDay(new Date());
        if (this.lastPassDay === day) return;
        await this.sweep();
        this.lastPassDay = day;
      }),
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
  ): Promise<{ customers: number; alerted: number; skipped: number }> {
    if (this.erp.mode === 'mock')
      return { customers: 0, alerted: 0, skipped: 0 };

    const rule = await this.rules.across(RULE);
    const enabledCompanies = [...rule.byCompany]
      .filter(([, own]) => own.enabled)
      .map(([companyId]) => companyId);
    const disabledCompanies = [...rule.byCompany]
      .filter(([, own]) => !own.enabled)
      .map(([companyId]) => companyId);
    const companyWhere: Prisma.CustomerWhereInput = rule.standard.enabled
      ? { companyId: { notIn: disabledCompanies } }
      : { companyId: { in: enabledCompanies } };

    const linked = (await this.externalCodes.findMany({
      where: {
        system: ERP_SYSTEM,
        customer: {
          ...companyWhere,
          accountOwnerUserId: { not: null },
          mergedIntoCustomerId: null,
        },
      },
      select: {
        customerId: true,
        externalCode: true,
        customer: {
          select: {
            id: true,
            companyId: true,
            customerCode: true,
            nameTh: true,
            accountOwnerUserId: true,
            company: { select: { code: true } },
          },
        },
      },
    })) as unknown as LinkedCustomer[];

    const today = bangkokDay(now);
    let alerted = 0;
    let skipped = 0;
    for (const link of linked) {
      let invoices: ErpInvoice[];
      try {
        invoices = await this.erp.listInvoices(
          { companyCode: link.customer.company.code },
          link.externalCode,
          INVOICE_LIMIT,
        );
      } catch (error) {
        skipped += 1;
        this.logger.warn(
          `overdue invoices for ${link.customerId} unavailable: ${(error as Error).message}`,
        );
        continue;
      }
      const steps = rule.of(link.customer.companyId).params
        .overdue_days as number[];
      for (const invoice of invoices) {
        if (await this.alertOne(link, invoice, steps, today)) alerted += 1;
      }
    }

    if (alerted || skipped) {
      this.logger.log(
        `CD-53: ${alerted} overdue invoice notice(s) over ${linked.length} customer(s), ${skipped} unreachable`,
      );
    }
    return { customers: linked.length, alerted, skipped };
  }

  /** True when a notice went out for this invoice. */
  private async alertOne(
    link: LinkedCustomer,
    invoice: ErpInvoice,
    steps: number[],
    today: string,
  ): Promise<boolean> {
    if (invoice.status !== 'open' || !invoice.dueOn || invoice.outstanding <= 0)
      return false;
    const daysOverdue = Math.round(
      (Date.parse(`${today}T00:00:00Z`) -
        Date.parse(`${invoice.dueOn}T00:00:00Z`)) /
        DAY_MS,
    );
    const reached = steps.filter((step) => daysOverdue >= step);
    if (!reached.length) return false;

    const done = (await this.alerts.findMany({
      where: { customerId: link.customerId, docNo: invoice.docNo },
      select: { step: true },
    })) as { step: number }[];
    const fresh = reached.filter(
      (step) => !done.some((row) => row.step === step),
    );
    if (!fresh.length) return false;

    // Claimed per step by the unique key: an overlapping pass claims nothing.
    const claimed = await this.alerts.createMany({
      data: fresh.map((step) => ({
        companyId: link.customer.companyId,
        customerId: link.customerId,
        docNo: invoice.docNo,
        step,
        dueOn: new Date(`${invoice.dueOn}T00:00:00Z`),
      })),
      skipDuplicates: true,
    });
    if (claimed.count !== fresh.length) return false;

    await this.notifications.invoiceOverdue(
      link.customer.accountOwnerUserId as string,
      link.customer.companyId,
      link.customer,
      {
        docNo: invoice.docNo,
        dueOn: invoice.dueOn,
        outstanding: invoice.outstanding,
        currency: invoice.currency,
      },
      daysOverdue,
    );
    return true;
  }
}
