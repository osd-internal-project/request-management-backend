import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ContractRenewalService } from '../crm/contract-renewal.service';
import {
  CustomerContractRepository,
  InvoiceOverdueAlertRepository,
} from '../crm/contract.repositories';
import { CustomerExternalCodeRepository } from '../crm/customer-child.repositories';
import { InvoiceOverdueService } from '../crm/invoice-overdue.service';
import { KycExpiryService } from '../crm/kyc-expiry.service';
import { CustomerKycRecordRepository } from '../crm/kyc.repositories';
import { OpportunityStaleMonitorService } from '../crm/opportunity-stale-monitor.service';
import { OpportunityRepository } from '../crm/sales.repositories';
import { NotificationRulesService } from './notification-rules.service';

/**
 * CD-53 — the sweeps now build their queries from the company rules: a list
 * compared with `equals`, a relation filter on the customer, one OR-branch per
 * company. Prisma's types accept inputs its engine rejects, and the unit specs
 * mock Prisma, so this runs each sweep against a real database.
 *
 * Every sweep runs at a date in 1990, so nothing is due and nothing is
 * written; the one write (the reminder-step claim) is on a contract this suite
 * creates and deletes. Needs a migrated database with a customer; skipped
 * otherwise:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test notification-rules.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;
const LONG_AGO = new Date('1990-01-01T03:00:00Z');

(DB_URL ? describe : describe.skip)('CD-53 rule sweeps (real Postgres)', () => {
  let prisma: PrismaClient;
  let rules: NotificationRulesService;
  const quiet = { get: () => 0 } as never;
  const nobody = {} as never;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    rules = new NotificationRulesService(prisma as never);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('CD-53: every sweep query is accepted by the engine', async () => {
    const opportunities = new OpportunityRepository(prisma as never);
    const contracts = new ContractRenewalService(
      new CustomerContractRepository(prisma as never),
      opportunities,
      nobody,
      nobody,
      rules,
      quiet,
    );
    await expect(contracts.sweep(LONG_AGO)).resolves.toEqual({
      opened: 0,
      reminded: 0,
      closed: 0,
    });

    const kyc = new KycExpiryService(
      new CustomerKycRecordRepository(prisma as never),
      nobody,
      nobody,
      nobody,
      nobody,
      rules,
      nobody,
      quiet,
    );
    await expect(kyc.sweep(LONG_AGO)).resolves.toEqual({
      warned: 0,
      expired: 0,
    });

    const stale = new OpportunityStaleMonitorService(
      opportunities,
      nobody,
      nobody,
      rules,
      nobody,
      quiet,
    );
    await expect(stale.sweep(LONG_AGO)).resolves.toEqual({ alerted: 0 });

    const invoices = new InvoiceOverdueService(
      new CustomerExternalCodeRepository(prisma as never),
      new InvoiceOverdueAlertRepository(prisma as never),
      { mode: 'sapb1', listInvoices: () => Promise.resolve([]) } as never,
      rules,
      nobody,
      quiet,
    );
    await expect(invoices.sweep(LONG_AGO)).resolves.toMatchObject({
      alerted: 0,
      skipped: 0,
    });
  });

  it('CD-53: a reminder step is claimed once — the second claim on the same list finds nothing', async () => {
    const customer = await prisma.customer.findFirst({
      select: { id: true, companyId: true },
    });
    if (!customer) throw new Error('database has no customer');
    const repo = new CustomerContractRepository(prisma as never);
    const id = `cd53-${randomUUID()}`;
    await prisma.customerContract.create({
      data: {
        id,
        companyId: customer.companyId,
        customerId: customer.id,
        contractNo: id,
        title: 'CD-53 db spec',
        endOn: new Date('1990-02-01T00:00:00Z'),
        ownerUserId: 'cd53-nobody',
      },
    });
    try {
      const claim = () =>
        repo.updateMany({
          where: { id, remindedDays: { equals: [] } },
          data: { remindedDays: [60, 30] },
        });
      await expect(claim()).resolves.toEqual({ count: 1 });
      await expect(claim()).resolves.toEqual({ count: 0 });
      const row = await prisma.customerContract.findUniqueOrThrow({
        where: { id },
        select: { remindedDays: true },
      });
      expect(row.remindedDays).toEqual([60, 30]);
    } finally {
      await prisma.customerContract.delete({ where: { id } });
    }
  });
});
