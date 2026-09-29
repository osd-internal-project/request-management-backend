import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { type Principal } from '@request-management/share';
import { CustomerMergeService } from './customer-merge.service';

/**
 * CD-122 — a merge re-points rows across a dozen tables in one transaction;
 * the unit spec cannot tell whether the engine accepts each `updateMany` and
 * whether the unique constraints (one SAP code per system, one account plan,
 * segment assignments) are respected. This runs a whole merge against a real
 * database, on customers it creates and deletes. Skipped without one:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test customer-merge.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)(
  'CD-122 customer merge (real Postgres)',
  () => {
    let prisma: PrismaClient;
    let service: CustomerMergeService;
    let companyId: string;
    let userId: string;
    const tag = randomUUID().slice(0, 8);
    const created: { customers: string[]; opportunities: string[] } = {
      customers: [],
      opportunities: [],
    };
    const kicked: string[] = [];

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      const company = await prisma.company.findFirstOrThrow({
        select: { id: true },
      });
      const user = await prisma.user.findFirstOrThrow({ select: { id: true } });
      companyId = company.id;
      userId = user.id;
      service = new CustomerMergeService(
        prisma as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
        {
          publish: (
            event: Record<string, unknown>,
            option?: { prisma?: PrismaClient },
          ) =>
            (option?.prisma ?? prisma).customerTimelineEvent.create({
              data: event as never,
            }),
        } as never,
        { kickCustomer: (id: string) => kicked.push(id) } as never,
        { record: () => Promise.resolve() } as never,
      );
    });

    afterAll(async () => {
      const ids = created.customers;
      await prisma.opportunity.deleteMany({
        where: { id: { in: created.opportunities } },
      });
      for (const model of [
        prisma.customerContact,
        prisma.customerExternalCode,
        prisma.customerAccountPlan,
        prisma.customerTimelineEvent,
      ] as unknown as {
        deleteMany(args: unknown): Promise<unknown>;
      }[]) {
        await model.deleteMany({ where: { customerId: { in: ids } } });
      }
      await prisma.customer.updateMany({
        where: { id: { in: ids } },
        data: { mergedIntoCustomerId: null, headOfficeId: null },
      });
      await prisma.customer.deleteMany({ where: { id: { in: ids } } });
      await prisma.$disconnect();
    });

    async function customer(
      suffix: string,
      extra: Record<string, unknown> = {},
    ) {
      const row = await prisma.customer.create({
        data: {
          companyId,
          customerCode: `CUS-T122-${tag}-${suffix}`,
          nameTh: `ทดสอบรวม ${suffix}`,
          normalizedName: `ทดสอบรวม ${suffix} ${tag}`,
          status: 'active',
          type: 'corporate',
          ...extra,
        },
      });
      created.customers.push(row.id);
      return row;
    }

    it('CD-122: re-points documents, keeps one-per-kind rows on the alias, and closes the alias', async () => {
      const keep = await customer('KEEP');
      const dupe = await customer('DUPE');
      const branch = await customer('BRANCH', { headOfficeId: dupe.id });

      await prisma.customerContact.createMany({
        data: [
          { customerId: dupe.id, name: 'ผู้ติดต่อของรายซ้ำ' },
          { customerId: keep.id, name: 'ผู้ติดต่อเดิม' },
        ],
      });
      await prisma.customerExternalCode.createMany({
        data: [
          { customerId: keep.id, system: 'sap', externalCode: `C-K-${tag}` },
          { customerId: dupe.id, system: 'sap', externalCode: `C-D-${tag}` },
          { customerId: dupe.id, system: 'acc7', externalCode: `A-D-${tag}` },
        ],
      });
      await prisma.customerAccountPlan.create({
        data: { companyId, customerId: dupe.id },
      });
      const deal = await prisma.opportunity.create({
        data: {
          companyId,
          customerId: dupe.id,
          opportunityCode: `OPP-T122-${tag}`,
          title: 'ดีลของรายซ้ำ',
          ownerUserId: userId,
        },
      });
      created.opportunities.push(deal.id);

      const actor = {
        userId,
        activeCompanyId: companyId,
        displayName: 'ผู้ดูแลระบบ',
      } as unknown as Principal;

      const preview = await service.preview(dupe.id, keep.id, actor);
      expect(preview.counts).toMatchObject({
        opportunity: 1,
        customerContact: 1,
        branches: 1,
      });
      expect(preview.kept).toEqual({
        externalCodes: ['sap'],
        accountPlan: false,
      });

      const result = await service.merge(
        dupe.id,
        keep.id,
        { into: keep.id, reason: 'ทดสอบ' },
        actor,
      );
      expect(result.counts).toMatchObject({ opportunity: 1, branches: 1 });

      // every document now under the survivor, and still opens
      await expect(
        prisma.opportunity.findUniqueOrThrow({ where: { id: deal.id } }),
      ).resolves.toMatchObject({ customerId: keep.id });
      expect(
        await prisma.customerContact.count({ where: { customerId: keep.id } }),
      ).toBe(2);
      await expect(
        prisma.customer.findUniqueOrThrow({ where: { id: branch.id } }),
      ).resolves.toMatchObject({ headOfficeId: keep.id });
      // one SAP code per customer: the duplicate keeps its own; acc7 moved
      const codes = await prisma.customerExternalCode.findMany({
        where: { customerId: { in: [keep.id, dupe.id] } },
        select: { customerId: true, system: true },
        orderBy: { system: 'asc' },
      });
      expect(codes).toEqual([
        { customerId: keep.id, system: 'acc7' },
        { customerId: keep.id, system: 'sap' },
        { customerId: dupe.id, system: 'sap' },
      ]);
      // the survivor had no plan: the duplicate's moved
      expect(
        await prisma.customerAccountPlan.count({
          where: { customerId: keep.id },
        }),
      ).toBe(1);

      await expect(
        prisma.customer.findUniqueOrThrow({ where: { id: dupe.id } }),
      ).resolves.toMatchObject({
        mergedIntoCustomerId: keep.id,
        status: 'inactive',
      });
      expect(kicked).toEqual([dupe.id]);
      expect(
        await prisma.customerTimelineEvent.count({
          where: {
            customerId: { in: [keep.id, dupe.id] },
            eventType: 'customer.merged',
          },
        }),
      ).toBe(2);

      // an alias cannot be merged again
      await expect(
        service.merge(
          dupe.id,
          keep.id,
          { into: keep.id, reason: 'ซ้ำ' },
          actor,
        ),
      ).rejects.toMatchObject({ code: 'CRM_CUSTOMER_STATE_INVALID' });
    });
  },
);
