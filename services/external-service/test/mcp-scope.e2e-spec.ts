import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ALL_PERMISSIONS, type Principal } from '@request-management/share';

/**
 * CD-277 — the MCP tools against a real database: whatever the question, an
 * answer holds nothing from another company and nothing outside the asker's
 * rows.
 *
 * `src/mcp/mcp-permission-gates.spec.ts` proves every tool hands the person
 * to the screen's service; this proves those services, on real queries,
 * filter by that person. Rows are seeded with marker strings and every read
 * tool's whole answer is searched for them — so a leak through any field, in
 * any tool added later, fails here without a line of this file changing.
 *
 * Needs a throwaway, migrated database — `make smoke` provides one.
 */
const SCOPE_DB = process.env.EXTERNAL_SMOKE_DB_URL;

function assertThrowaway(url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    throw new Error(
      `EXTERNAL_SMOKE_DB_URL must point at a local throwaway DB, got ${host}`,
    );
  }
}

function principal(
  userId: string,
  company: { id: string; name: string; docPrefix: string },
  permissions: readonly string[],
): Principal {
  return {
    userId,
    keycloakId: userId,
    username: userId,
    displayName: userId,
    email: null,
    companies: [{ ...company, isPrimary: true }],
    activeCompanyId: company.id,
    orgUnitId: null,
    supervisorUserId: null,
    ledUnitIds: [],
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedActUnitIds: [],
    scopedUserIds: [],
    scopedActUserIds: [],
    scopedByPermission: {},
    roles: [],
    permissions,
    sensitiveFieldsVisible: [],
    sensitiveFieldsAll: [],
    isServiceAccount: false,
    pendingOrgAssignment: false,
  } as unknown as Principal;
}

interface Registry {
  list(): { name: string }[];
  call(
    name: string,
    args: Record<string, unknown>,
    context: { actor: Principal; authorization: string },
  ): Promise<unknown>;
}

(SCOPE_DB ? describe : describe.skip)(
  'CD-277 MCP answers stay in scope',
  () => {
    let app: INestApplication;
    let tools: Registry;

    const run = randomUUID().slice(0, 8);
    const SALES = `SCOPEMARK-SALES-${run}`;
    const KB = `SCOPEMARK-KB-${run}`;
    const ids = {
      companyA: randomUUID(),
      companyB: randomUUID(),
      alice: randomUUID(),
      bob: randomUUID(),
      carol: randomUUID(),
      customer: randomUUID(),
      lead: randomUUID(),
      opportunity: randomUUID(),
    };
    const companyA = {
      id: ids.companyA,
      name: `A ${run}`,
      docPrefix: `A${run}`,
    };
    const companyB = {
      id: ids.companyB,
      name: `B ${run}`,
      docPrefix: `B${run}`,
    };

    /** Everything, in company A — owns the seeded rows. */
    let alice: Principal;
    /** Company A, every permission except reading all sales and customers. */
    let bob: Principal;
    /** Company B, every permission. */
    let carol: Principal;

    beforeAll(async () => {
      assertThrowaway(SCOPE_DB as string);
      process.env.DATABASE_URL = SCOPE_DB;

      // Imported only after the environment is pinned: config is read at import.
      const { ExternalServiceModule } = jest.requireActual<
        typeof import('../src/external-service.module')
      >('../src/external-service.module');
      const { McpToolRegistry } = jest.requireActual<
        typeof import('../src/mcp/mcp-tools')
      >('../src/mcp/mcp-tools');
      const { PrismaService } = jest.requireActual<
        typeof import('@request-management/share')
      >('@request-management/share');

      const prisma = new PrismaService();
      await prisma.company.createMany({
        data: [
          { ...companyA, code: `A${run}` },
          { ...companyB, code: `B${run}` },
        ],
      });
      await prisma.user.createMany({
        data: [ids.alice, ids.bob, ids.carol].map((id) => ({
          id,
          keycloakId: id,
          username: `scope-${id}`,
          displayName: `scope ${id.slice(0, 4)}`,
        })),
      });
      await prisma.userCompany.createMany({
        data: [
          { userId: ids.alice, companyId: ids.companyA },
          { userId: ids.bob, companyId: ids.companyA },
          { userId: ids.carol, companyId: ids.companyB },
        ],
      });
      await prisma.customer.create({
        data: {
          id: ids.customer,
          companyId: ids.companyA,
          customerCode: `CUS-${run}`,
          type: 'corporate',
          nameTh: `${SALES} ลูกค้า`,
          normalizedName: `${SALES} customer`.toLowerCase(),
          accountOwnerUserId: ids.alice,
        },
      });
      await prisma.lead.create({
        data: {
          id: ids.lead,
          companyId: ids.companyA,
          name: `${SALES} lead`,
          ownerUserId: ids.alice,
        },
      });
      await prisma.opportunity.create({
        data: {
          id: ids.opportunity,
          companyId: ids.companyA,
          opportunityCode: `OPP-${run}`,
          title: `${SALES} deal`,
          ownerUserId: ids.alice,
          stage: 'proposing',
          customerId: ids.customer,
          expectedCloseAt: new Date(Date.now() + 5 * 86_400_000),
          staleAlertedAt: new Date(),
          nextFollowUpAt: new Date(Date.now() - 86_400_000),
        },
      });
      await prisma.kbArticle.create({
        data: {
          companyId: ids.companyA,
          articleNo: `KB-${run}`,
          title: `${KB} vpn`,
          summary: 'scope test',
          body: 'scope test',
          status: 'published',
          authorId: ids.alice,
          publishedAt: new Date(),
        },
      });
      await prisma.$disconnect();

      alice = principal(ids.alice, companyA, ALL_PERMISSIONS);
      bob = principal(
        ids.bob,
        companyA,
        ALL_PERMISSIONS.filter(
          (p) => p !== 'crm.sales.read.all' && p !== 'crm.customer.read.all',
        ),
      );
      carol = principal(ids.carol, companyB, ALL_PERMISSIONS);

      const moduleRef = await Test.createTestingModule({
        imports: [ExternalServiceModule],
      }).compile();
      app = moduleRef.createNestApplication();
      await app.init();
      tools = app.get(McpToolRegistry);
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    /** Every tool that only reads — the ones a question in a chat reaches. */
    const reads = () =>
      tools
        .list()
        .map((tool) => tool.name)
        .filter((name) => name.includes('_get_'));

    /** Arguments that point each tool at company A's rows. */
    function argsFor(name: string): Record<string, unknown> {
      const id = name.startsWith('crm_get_customers')
        ? ids.customer
        : name.startsWith('crm_get_leads')
          ? ids.lead
          : ids.opportunity;
      return {
        id,
        ref: `OPP-${run}`,
        code: 'NONE',
        q: run,
        search: run,
        days: 30,
        customer_id: ids.customer,
      };
    }

    /** The tool's answer as text, or its refusal — a crash is never an answer. */
    async function answer(name: string, actor: Principal): Promise<string> {
      try {
        const value = await tools.call(name, argsFor(name), {
          actor,
          authorization: '',
        });
        return JSON.stringify(value ?? null);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code !== 'string') throw error;
        return `refused:${code}`;
      }
    }

    it('the seed is reachable — alice sees her own deal and article', async () => {
      expect(await answer('assistant_get_deals_closing', alice)).toContain(
        SALES,
      );
      expect(await answer('assistant_get_deals_silent', alice)).toContain(
        SALES,
      );
      expect(await answer('crm_get_opportunities_id', alice)).toContain(SALES);
      expect(await answer('assistant_get_kb_articles', alice)).toContain(KB);
    });

    it('another company sees nothing of company A, through any read tool', async () => {
      const leaks: string[] = [];
      for (const name of reads()) {
        const text = await answer(name, carol);
        if (text.includes(SALES) || text.includes(KB)) leaks.push(name);
      }
      expect(leaks).toEqual([]);
    });

    it('a record of another company answers 404, not 403', async () => {
      for (const name of [
        'crm_get_customers_id',
        'crm_get_leads_id',
        'crm_get_opportunities_id',
      ]) {
        expect(await answer(name, carol)).toBe('refused:NOT_FOUND');
      }
    });

    it('a colleague without the read-all grants sees none of alice’s sales rows', async () => {
      const leaks: string[] = [];
      for (const name of reads()) {
        const text = await answer(name, bob);
        if (text.includes(SALES)) leaks.push(name);
      }
      expect(leaks).toEqual([]);
    });

    it('a published article is the company’s — the colleague finds it', async () => {
      expect(await answer('assistant_get_kb_articles', bob)).toContain(KB);
    });
  },
);
