import { PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { NotificationRulesService } from '../notifications/notification-rules.service';
import { RequestRepository } from '../requests/request.repository';
import { AccountReviewReminderService } from './account-review-reminder.service';
import {
  CustomerContractRepository,
  InvoiceOverdueAlertRepository,
} from './contract.repositories';
import { CustomerRepository } from './customer.repository';
import {
  CustomerAccountPlanRepository,
  CustomerTouchpointRepository,
} from './keeper.repositories';
import { KeeperService } from './keeper.service';
import {
  OpportunityRepository,
  QuotationRepository,
  SaleOrderRepository,
} from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';

/**
 * CD-86 — the portfolio builds its queries from relation filters (a plan
 * that `is: null`, a plan's customer, cases by ref) that Prisma's types
 * accept and only its engine can judge. Runs the portfolio, one account and
 * the reminder sweep against a real, migrated database — reads only (the
 * sweep runs in 1990, so nothing is due).
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test keeper.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)('CD-86 Keeper (real Postgres)', () => {
  let prisma: PrismaClient;
  let keeper: KeeperService;
  let actor: Principal;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    const p = prisma as never;
    keeper = new KeeperService(
      new CustomerRepository(p),
      new CustomerAccountPlanRepository(p),
      new CustomerTouchpointRepository(p),
      new OpportunityRepository(p),
      new QuotationRepository(p),
      new SaleOrderRepository(p),
      new CustomerContractRepository(p),
      new InvoiceOverdueAlertRepository(p),
      new RequestRepository(p),
      new CrmConfigRepository(p),
      new CompanyMemberRepository(p),
      { publish: () => Promise.resolve() } as never,
      { record: () => Promise.resolve() } as never,
    );
    const customer = await prisma.customer.findFirst({
      where: { mergedIntoCustomerId: null, status: 'active' },
      select: { companyId: true },
    });
    actor = {
      userId: 'cd86-db-spec',
      activeCompanyId: customer?.companyId ?? 'none',
      orgUnitId: null,
      ledUnitIds: [],
      scopedUnitIds: [],
      permissions: [
        'crm.customer.read',
        'crm.customer.read.all',
        'crm.sales.read',
        'crm.sales.read.all',
        'crm.customer.financial.read',
        'request.read',
        'request.read.all',
      ],
    } as unknown as Principal;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('CD-86: portfolio (every filter) and one account run on the engine', async () => {
    const page = await keeper.portfolio({}, actor);
    expect(page.summary.accounts).toBe(page.rows.length);
    await keeper.portfolio({ tier: 'none', view: 'mine' }, actor);
    await keeper.portfolio({ tier: 'a', health: 'red', search: 'x' }, actor);
    if (page.rows[0]) {
      const account = await keeper.account(page.rows[0].id, actor);
      expect(account.id).toBe(page.rows[0].id);
    }
  });

  it('CD-86: the review reminder sweep runs on the engine', async () => {
    const sweep = new AccountReviewReminderService(
      new CustomerAccountPlanRepository(prisma as never),
      new NotificationRulesService(prisma as never),
      {} as never,
      { get: () => 0 } as never,
    );
    await expect(
      sweep.sweep(new Date('1990-01-01T03:00:00Z')),
    ).resolves.toEqual({ reminded: 0 });
  });
});
