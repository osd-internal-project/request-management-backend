import type { Principal } from '@request-management/share';
import { MockMailClient } from './mock-mail.client';
import { SalesMailService } from './sales-mail.service';

const machine = {
  userId: 'svc-osd-workflow',
  activeCompanyId: 'co-1',
  isServiceAccount: true,
  permissions: ['integration.crm.lead.read.all', 'integration.crm.email.read'],
  ledUnitIds: [],
  scopedUnitIds: [],
} as unknown as Principal;

const site = { key: 'site', question: 'สถานที่ติดตั้ง', hints: ['ติดตั้งที่'] };

function harness(
  options: {
    text?: string;
    intakeData?: Record<string, unknown>;
    subProduct?: string | null;
    asksSent?: number;
    /** what itemsForLead answers once a product is known */
    bundle?: boolean;
    priced?: boolean;
    llmAnswer?: string;
  } = {},
) {
  const reply = {
    id: 'email-in',
    companyId: 'co-1',
    leadId: 'lead-1',
    opportunityId: null,
    quotationId: null,
    direction: 'in',
    purpose: 'reply',
    status: 'received',
    mailbox: 'sales@osd.co.th',
    fromAddress: 'somchai@example.com',
    toAddresses: ['sales@osd.co.th'],
    ccAddresses: [],
    subject: 'RE: ขอบคุณที่สนใจบริการของเรา',
    bodyText: options.text ?? 'สนใจครับ ขอใบเสนอราคา',
    attachments: [],
    graphMessageId: 'g-in',
    conversationId: 'conv-1',
    intent: 'interested',
    occurredAt: new Date('2026-11-13T03:00:00Z'),
  };
  const lead = {
    id: 'lead-1',
    companyId: 'co-1',
    name: 'บริษัท กขค จำกัด',
    email: 'somchai@example.com',
    ownerUserId: 'u-sales',
    subProduct: options.subProduct ?? null,
    intakeData: options.intakeData ?? {},
    convertedOpportunityId: null,
  };
  const sent: Record<string, unknown>[] = [];
  const emails = {
    findFirst: jest.fn(() => Promise.resolve(reply)),
    count: jest.fn(() => Promise.resolve(options.asksSent ?? 0)),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: 'email-out',
        ccAddresses: [],
        occurredAt: new Date(),
        intent: null,
        ...data,
      };
      sent.push(row);
      return Promise.resolve(row);
    }),
  };
  const leads = {
    findFirst: jest.fn(() => Promise.resolve(lead)),
    count: jest.fn(() => Promise.resolve(1)),
    mergeIntakeData: jest.fn((_id: string, set: Record<string, unknown>) => {
      lead.intakeData = { ...lead.intakeData, ...set };
      return Promise.resolve(lead);
    }),
  };
  const bundles = {
    namesOf: jest.fn(() => Promise.resolve(['IP-PHONE'])),
    itemsForLead: jest.fn(
      (
        _company: string,
        about: {
          intakeData: {
            requirements: { product: string | null; quantity: number | null };
          };
        },
      ) => {
        const told = about.intakeData.requirements;
        const product = told.product;
        if (!product) {
          return Promise.resolve({ source: 'none', product: null, items: [] });
        }
        if (options.bundle === false) {
          return Promise.resolve({ source: 'none', product, items: [] });
        }
        return Promise.resolve({
          source: 'bundle',
          product,
          requirements: [site],
          items: [{ product_code: 'PHONE-01', quantity: told.quantity ?? 1 }],
        });
      },
    ),
  };
  const quotations = {
    standardPricesFor: jest.fn(() =>
      Promise.resolve({
        products: new Map([['PHONE-01', { name: 'IP Phone' }]]),
        priceOf:
          options.priced === false
            ? new Map()
            : new Map([['PHONE-01', { unitPrice: 3500 }]]),
      }),
    ),
  };
  const llm = {
    mode: options.llmAnswer ? 'gateway' : 'mock',
    chat: jest.fn(() =>
      Promise.resolve({ text: options.llmAnswer ?? '', model: 'm', usage: {} }),
    ),
  };
  const notifications = { salesEmailReceived: jest.fn() };
  const audit = { record: jest.fn() };
  const mail = new MockMailClient('sales@osd.co.th');
  const service = new SalesMailService(
    {
      forCompany: jest.fn(() =>
        Promise.resolve({ client: mail, mode: 'mock', problem: null }),
      ),
    } as never,
    emails as never,
    leads as never,
    { findFirst: jest.fn(), count: jest.fn(() => Promise.resolve(0)) } as never,
    { create: jest.fn(() => Promise.resolve({})) } as never,
    { create: jest.fn(() => Promise.resolve({})) } as never,
    quotations as never,
    bundles as never,
    {} as never,
    {} as never,
    llm as never,
    notifications as never,
    { emit: jest.fn() } as never,
    audit as never,
  );
  return { service, lead, leads, emails, sent, notifications, audit, llm };
}

describe('SalesMailService — requirement ก่อนใบเสนอราคา (13 พ.ย. 2569)', () => {
  it('"สนใจ" alone on a Lead with no product → ask which product, and keep that on the Lead', async () => {
    const h = harness();
    const result = await h.service.assessReply('email-in', machine);
    expect(result.outcome).toBe('ask');
    expect(result.missing.map((item) => item.key)).toEqual([
      'product',
      'quantity',
    ]);
    expect(h.leads.mergeIntakeData).toHaveBeenCalledWith(
      'lead-1',
      {
        requirements: expect.objectContaining({
          outcome: 'ask',
          email_id: 'email-in',
        }) as unknown,
      },
      [],
      'svc-osd-workflow',
    );
    expect(h.notifications.salesEmailReceived).not.toHaveBeenCalled();
  });

  it('product + quantity + the product’s question all in the reply → ready', async () => {
    const h = harness({
      text: 'สนใจ IP-PHONE 50 เครื่อง\nติดตั้งที่ระยอง',
    });
    const result = await h.service.assessReply('email-in', machine);
    expect(result).toMatchObject({
      outcome: 'ready',
      product: 'IP-PHONE',
      quantity: 50,
      answers: { site: 'ติดตั้งที่ระยอง' },
      missing: [],
      source: 'rules',
    });
  });

  it('a second reply adds to the first: the quantity told earlier is not asked again', async () => {
    const h = harness({
      text: 'ติดตั้งที่ระยองครับ',
      asksSent: 1,
      intakeData: {
        requirements: { product: 'IP-PHONE', quantity: 50, answers: {} },
      },
    });
    const result = await h.service.assessReply('email-in', machine);
    expect(result).toMatchObject({ outcome: 'ready', quantity: 50 });
  });

  it('a product with no bundle or items → no_solution: the owner is told to go to Pricing / Pre-Sales', async () => {
    const h = harness({ text: 'สนใจ IP-PHONE 5 เครื่อง', bundle: false });
    const result = await h.service.assessReply('email-in', machine);
    expect(result.outcome).toBe('no_solution');
    expect(h.notifications.salesEmailReceived).toHaveBeenCalledWith(
      'u-sales',
      'co-1',
      expect.objectContaining({
        intentLabel: 'ไม่มีราคา/Solution ในระบบ',
        nextStep: expect.stringContaining('Pricing') as unknown,
        resourceType: 'lead',
      }),
    );
  });

  it('an item with no standard price → no_solution', async () => {
    const h = harness({ text: 'สนใจ IP-PHONE 5 เครื่อง', priced: false });
    expect((await h.service.assessReply('email-in', machine)).outcome).toBe(
      'no_solution',
    );
  });

  it('asked twice already and still incomplete → handover to the owner', async () => {
    const h = harness({ text: 'สนใจ IP-PHONE', asksSent: 2 });
    const result = await h.service.assessReply('email-in', machine);
    expect(result.outcome).toBe('handover');
    expect(h.notifications.salesEmailReceived).toHaveBeenCalled();
  });

  it('a real LLM reads the answers; the audit row names keys, never the answers', async () => {
    const h = harness({
      text: 'เอา IP Phone ห้าสิบเครื่อง ลงที่โรงงานระยอง',
      llmAnswer:
        '{"product":"IP-PHONE","quantity":50,"answers":{"site":"โรงงานระยอง"}}',
    });
    const result = await h.service.assessReply('email-in', machine);
    expect(result).toMatchObject({ outcome: 'ready', source: 'llm' });
    const audit = JSON.stringify(h.audit.record.mock.calls);
    expect(audit).toContain('crm.lead.requirements_assessed');
    expect(audit).not.toContain('โรงงานระยอง');
  });

  describe('sendRequirementRequest', () => {
    it('asks exactly what the assessment found missing, answering the customer’s message', async () => {
      const h = harness({ text: 'สนใจ IP-PHONE ครับ' });
      await h.service.assessReply('email-in', machine);
      const out = await h.service.sendRequirementRequest(
        'email-in',
        { signature: 'ฝ่ายขาย' },
        machine,
      );
      expect(out.asked.map((item) => item.key)).toEqual(['quantity', 'site']);
      expect(h.sent[0]).toMatchObject({
        purpose: 'requirement_request',
        status: 'sent',
        leadId: 'lead-1',
        toAddresses: ['somchai@example.com'],
        subject: 'RE: ขอบคุณที่สนใจบริการของเรา',
        replyToEmailId: 'email-in',
      });
      expect(h.sent[0].bodyText).toContain(
        '1. จำนวนที่ต้องการ\n2. สถานที่ติดตั้ง',
      );
    });

    it('nothing to ask (never assessed, or ready) → 409, no email', async () => {
      const h = harness();
      await expect(
        h.service.sendRequirementRequest('email-in', {}, machine),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(h.sent).toHaveLength(0);
    });
  });
});
