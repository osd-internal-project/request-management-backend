import { ProductBundlesService } from '../crm/product-bundles.service';
import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { hintFor, SalesAutomationService } from './sales-automation.service';

const machine = {
  userId: 'svc-1',
  username: 'osd-workflow',
  isServiceAccount: true,
  activeCompanyId: 'co-1',
  permissions: [
    'integration.crm.lead.read.all',
    'integration.crm.sales.read.all',
  ],
  ledUnitIds: [],
  scopedUnitIds: [],
} as unknown as Principal;

const seller = {
  ...machine,
  userId: 'u-sales',
  username: 'sales',
  isServiceAccount: false,
  permissions: ['crm.lead.read', 'crm.sales.read'],
} as unknown as Principal;

const LEAD = {
  id: 'lead-1',
  companyId: 'co-1',
  email: 'somchai@example.com',
  ownerUserId: 'u-sales',
  convertedOpportunityId: null as string | null,
  subProduct: 'IP-PHONE',
  intakeData: {},
};

const TRIGGERS = [
  {
    id: 't-intro',
    name: 'Negotiate send mail proposal',
    eventKey: 'lead.status_changed',
    typeCodes: ['negotiation'],
  },
  {
    id: 't-quote',
    name: 'Interested → quote',
    eventKey: 'crm.email.received',
    typeCodes: ['interested'],
  },
];

function harness(
  options: {
    lead?: object | null;
    deal?: object | null;
    triggers?: object[];
    proposal?: object | null;
    mail?: { mode: string; problem: string | null };
    priced?: string[];
    issues?: object[];
    starts?: object[];
    bundles?: object[];
  } = {},
) {
  const lead = options.lead === undefined ? LEAD : options.lead;
  const issues = {
    create: jest.fn(() => Promise.resolve({})),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    findMany: jest.fn(() => Promise.resolve(options.issues ?? [])),
  };
  const leads = { findFirst: jest.fn(() => Promise.resolve(lead)) };
  const opportunities = {
    findFirst: jest.fn(() => Promise.resolve(options.deal ?? null)),
  };
  const quotationRows = { findFirst: jest.fn(() => Promise.resolve(null)) };
  const priced = new Set(options.priced ?? ['IP-PHONE']);
  const quotations = {
    standardPricesFor: jest.fn((_company: string, codes: string[]) =>
      Promise.resolve({
        products: new Map(
          codes.map((code) => [code, { name: code, unit: null }]),
        ),
        priceOf: new Map(
          codes.filter((code) => priced.has(code)).map((code) => [code, {}]),
        ),
      }),
    ),
  };
  const leadFiles = {
    proposalMeta: jest.fn(() =>
      Promise.resolve(
        options.proposal === undefined
          ? { fileName: 'proposal.pdf', uploadedAt: new Date() }
          : options.proposal,
      ),
    ),
  };
  const emails = {
    findMany: jest.fn(() => Promise.resolve([{ id: 'email-1' }])),
  };
  const clients = {
    forCompany: jest.fn(() =>
      Promise.resolve(options.mail ?? { mode: 'graph', problem: null }),
    ),
  };
  const triggers = {
    findMany: jest.fn(() => Promise.resolve(options.triggers ?? TRIGGERS)),
  };
  const starts = {
    findMany: jest.fn(() => Promise.resolve(options.starts ?? [])),
  };
  // the real lookup over a canned bundle list
  const bundles = new ProductBundlesService(
    {
      findMany: jest.fn(() => Promise.resolve(options.bundles ?? [])),
    } as never,
    {} as never,
    quotations as never,
    {} as never,
    {} as never,
  );
  const service = new SalesAutomationService(
    issues as never,
    leads as never,
    opportunities as never,
    quotationRows as never,
    quotations as never,
    bundles,
    leadFiles as never,
    emails as never,
    clients as never,
    triggers as never,
    starts as never,
  );
  return { service, issues, leads, opportunities, quotationRows };
}

const stepOf = (
  view: Awaited<ReturnType<SalesAutomationService['forLead']>>,
  key: string,
) => view.steps.find((step) => step.key === key)!;
const checkOf = (
  view: Awaited<ReturnType<SalesAutomationService['forLead']>>,
  stepKey: string,
  key: string,
) => stepOf(view, stepKey).checks.find((check) => check.key === key)!;

describe('SalesAutomationService — why a sales workflow stopped (11 พ.ย. 2569)', () => {
  describe('record / resolve (external-service)', () => {
    it('keeps a refusal of send_lead_email on the Lead, with its code and details', async () => {
      const h = harness();
      await h.service.record(
        { leadId: 'lead-1' },
        'send_lead_email',
        new AppError('CRM_EMAIL_UNAVAILABLE', 'ไม่มี proposal', [
          { field: 'proposal', reason: 'missing' },
        ]),
        machine,
      );
      expect(h.issues.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          companyId: 'co-1',
          leadId: 'lead-1',
          step: 'intro',
          action: 'send_lead_email',
          code: 'CRM_EMAIL_UNAVAILABLE',
          details: [{ field: 'proposal', reason: 'missing' }],
        }) as unknown,
      });
    });

    it('a quotation names its deal and the Lead behind it', async () => {
      const h = harness();
      h.quotationRows.findFirst.mockResolvedValueOnce({
        opportunityId: 'opp-1',
      } as never);
      h.opportunities.findFirst.mockResolvedValueOnce({ id: 'opp-1' });
      await h.service.record(
        { quotationId: 'qt-1' },
        'accept_quotation',
        new AppError('CRM_QUOTATION_STATE_INVALID', 'ยังไม่ได้ส่ง'),
        machine,
      );
      expect(h.issues.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          leadId: 'lead-1',
          opportunityId: 'opp-1',
          step: 'close',
        }) as unknown,
      });
    });

    it('a 404, a crash or another company’s id leaves nothing to show', async () => {
      const h = harness({ lead: null });
      await h.service.record(
        { leadId: 'lead-x' },
        'send_lead_email',
        new AppError('NOT_FOUND', 'ไม่พบ'),
        machine,
      );
      await h.service.record(
        { leadId: 'lead-x' },
        'send_lead_email',
        new Error('boom'),
        machine,
      );
      await h.service.record(
        { leadId: 'lead-x' },
        'send_lead_email',
        new AppError('CONFLICT', 'x'),
        machine,
      );
      expect(h.issues.create).not.toHaveBeenCalled();
      // looked up inside the key's company only
      expect(h.leads.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'lead-x', companyId: 'co-1' },
        }),
      );
    });

    it('a later success clears that action’s refusals on the Lead and its deal', async () => {
      const h = harness({
        lead: { id: 'lead-1', convertedOpportunityId: 'opp-1' },
      });
      await h.service.resolve({ leadId: 'lead-1' }, 'convert_lead', machine);
      expect(h.issues.updateMany).toHaveBeenCalledWith({
        where: {
          companyId: 'co-1',
          action: 'convert_lead',
          resolvedAt: null,
          OR: [{ leadId: 'lead-1' }, { opportunityId: 'opp-1' }],
        },
        data: { resolvedAt: expect.any(Date) as unknown },
      });
    });
  });

  describe('forLead (the Lead page)', () => {
    it('all set: every step ok, in use', async () => {
      const view = await harness().service.forLead('lead-1', seller);
      expect(view.in_use).toBe(true);
      expect(stepOf(view, 'base').ok).toBe(true);
      expect(stepOf(view, 'intro').ok).toBe(true);
      expect(stepOf(view, 'quote').ok).toBe(true);
      // no close trigger yet: that step says so
      expect(checkOf(view, 'close', 'trigger')).toMatchObject({ ok: false });
    });

    it('says what is missing: no proposal, no owner, an unpriced product, mailbox off', async () => {
      const view = await harness({
        lead: { ...LEAD, ownerUserId: null, subProduct: 'ROUTER-X' },
        proposal: null,
        mail: { mode: 'off', problem: null },
        priced: [],
      }).service.forLead('lead-1', seller);
      expect(view.ok).toBe(false);
      expect(checkOf(view, 'base', 'mailbox')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('อีเมลงานขาย') as unknown,
      });
      expect(checkOf(view, 'intro', 'proposal').ok).toBe(false);
      expect(checkOf(view, 'quote', 'owner').ok).toBe(false);
      expect(checkOf(view, 'quote', 'products')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('ROUTER-X') as unknown,
      });
    });

    it("a product with a bundle is checked on the bundle's mandatory items", async () => {
      const view = await harness({
        lead: {
          ...LEAD,
          subProduct: 'IP-PHONE',
          intakeData: { selected_product: 'd-debt' },
        },
        priced: ['DD-LICENSE'],
        bundles: [
          {
            id: 'bundle-1',
            name: 'D-DEBT',
            note: '',
            active: true,
            updatedAt: new Date(),
            items: [
              {
                lineNo: 1,
                productCode: 'DD-LICENSE',
                quantity: 1,
                termMonths: 12,
                optional: false,
              },
              {
                lineNo: 2,
                productCode: 'DD-TRAINING',
                quantity: 1,
                termMonths: null,
                optional: true,
              },
            ],
          },
        ],
      }).service.forLead('lead-1', seller);
      // the optional item has no price, and is not asked about
      expect(checkOf(view, 'quote', 'products')).toMatchObject({
        ok: true,
        detail: 'ชุดรายการของ D-DEBT: DD-LICENSE',
      });
    });

    it('a Lead with no product says so before any price is looked up', async () => {
      const view = await harness({
        lead: { ...LEAD, subProduct: null },
      }).service.forLead('lead-1', seller);
      expect(checkOf(view, 'quote', 'products')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('ชุดรายการ') as unknown,
      });
    });

    it('shows the open refusal with a hint, and a start that never reached OSD Workflow', async () => {
      const view = await harness({
        issues: [
          {
            id: 'i-2',
            step: 'quote',
            action: 'convert_lead',
            code: 'CONFLICT',
            message: 'Lead ไม่มีเจ้าของ',
            details: [{ field: 'owner_user_id', reason: 'unowned' }],
            occurredAt: new Date('2026-11-11T03:00:00Z'),
          },
          {
            id: 'i-1',
            step: 'quote',
            action: 'convert_lead',
            code: 'CONFLICT',
            message: 'older',
            details: [],
            occurredAt: new Date('2026-11-10T03:00:00Z'),
          },
        ],
        starts: [
          {
            triggerId: 't-intro',
            resourceId: 'lead-1',
            status: 'dead',
            lastError: '401 bad channel key',
            startedAt: null,
            createdAt: new Date('2026-11-11T02:00:00Z'),
          },
        ],
      }).service.forLead('lead-1', seller);
      // the newest refusal of each action only
      expect(view.issues).toEqual([
        expect.objectContaining({
          id: 'i-2',
          hint: 'กำหนดผู้รับผิดชอบ Lead',
        }),
      ]);
      expect(view.ok).toBe(false);
      expect(checkOf(view, 'intro', 'start')).toMatchObject({
        ok: false,
        detail: expect.stringContaining('401 bad channel key') as unknown,
      });
    });

    it('no sales trigger in the company: not in use (the card hides)', async () => {
      const view = await harness({ triggers: [] }).service.forLead(
        'lead-1',
        seller,
      );
      expect(view.in_use).toBe(false);
    });

    it('a Lead out of reach is 404', async () => {
      await expect(
        harness({ lead: null }).service.forLead('lead-x', seller),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('forOpportunity: the deal page reads the same steps through the Lead behind it', async () => {
    const h = harness({
      deal: {
        id: 'opp-1',
        companyId: 'co-1',
        ownerUserId: 'u-sales',
        currency: 'THB',
        prospectEmail: 'somchai@example.com',
      },
      lead: { ...LEAD, convertedOpportunityId: 'opp-1' },
    });
    h.quotationRows.findFirst.mockResolvedValueOnce({
      quotationNo: 'QT-OSDD-000003',
      status: 'sent',
    } as never);
    const view = await h.service.forOpportunity('opp-1', seller);
    expect(checkOf(view, 'close', 'quotation_sent')).toMatchObject({
      ok: true,
      detail: 'QT-OSDD-000003',
    });
    expect(stepOf(view, 'intro')).toBeDefined();
  });

  it.each([
    [
      { code: 'CRM_EMAIL_UNAVAILABLE', details: [{ field: 'proposal' }] },
      'Proposal',
    ],
    [
      { code: 'CRM_EMAIL_UNAVAILABLE', details: [{ field: 'email' }] },
      'อีเมลผู้ติดต่อ',
    ],
    [{ code: 'CRM_EMAIL_UNAVAILABLE', details: [] }, 'อีเมลงานขาย'],
    [
      {
        code: 'CRM_QUOTATION_UNPRICED',
        details: [{ field: 'items', reason: 'no_products' }],
      },
      'ชุดรายการ',
    ],
    [
      {
        code: 'CRM_QUOTATION_UNPRICED',
        details: [
          { field: 'items[0].product_code', reason: 'no_standard_price' },
        ],
      },
      'ราคามาตรฐาน',
    ],
  ])('hintFor(%p) mentions %s', (issue, text) => {
    expect(hintFor(issue)).toContain(text);
  });
});
