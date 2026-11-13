import { AppError, type Principal } from '@request-management/share';
import { MockMailClient } from './mock-mail.client';
import type { InboundMail, MailClient } from './mail-client';
import { SalesMailService } from './sales-mail.service';

const machine = {
  userId: 'svc-osd-workflow',
  activeCompanyId: 'co-1',
  isServiceAccount: true,
  permissions: [
    'integration.crm.lead.read.all',
    'integration.crm.sales.read.all',
    'integration.crm.email.send',
  ],
  ledUnitIds: [],
  scopedUnitIds: [],
} as unknown as Principal;

const lead = {
  id: 'lead-1',
  companyId: 'co-1',
  name: 'บริษัท กขค จำกัด',
  email: 'somchai@example.com' as string | null,
  ownerUserId: 'u-sales',
  convertedOpportunityId: null as string | null,
};

function harness(
  options: {
    mail?: MailClient | null;
    llmMode?: 'mock' | 'gateway';
    llmAnswer?: string;
  } = {},
) {
  const mail =
    options.mail === undefined
      ? new MockMailClient('sales@osd.co.th')
      : options.mail;
  const rows: Record<string, unknown>[] = [];
  const emails = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: `email-${rows.length + 1}`,
        ccAddresses: [],
        attachments: [],
        occurredAt: new Date('2026-11-05T03:00:00Z'),
        createdAt: new Date('2026-11-05T03:00:00Z'),
        replyToEmailId: null,
        intent: null,
        intentReason: null,
        intentSource: null,
        error: null,
        ...data,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    findFirst: jest.fn(),
    findMany: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
  };
  const leads = {
    findFirst: jest.fn(() => Promise.resolve(lead)),
    count: jest.fn(() => Promise.resolve(1)),
  };
  const opportunities = {
    findFirst: jest.fn(),
    update: jest.fn(() => Promise.resolve({})),
    count: jest.fn(() => Promise.resolve(1)),
  };
  const leadActivities = { create: jest.fn(() => Promise.resolve({})) };
  const opportunityActivities = { create: jest.fn(() => Promise.resolve({})) };
  const quotations = { findOne: jest.fn(), send: jest.fn() };
  const print = { printView: jest.fn() };
  const leadFiles = {
    latestProposal: jest.fn(() =>
      Promise.resolve(
        null as null | {
          id: string;
          fileName: string;
          mimeType: string;
          sizeBytes: number;
          content: Buffer;
        },
      ),
    ),
  };
  const llm = {
    mode: options.llmMode ?? 'mock',
    chat: jest.fn(() =>
      Promise.resolve({ text: options.llmAnswer ?? '', model: 'm', usage: {} }),
    ),
  };
  const notifications = { salesEmailReceived: jest.fn() };
  const events = { emit: jest.fn() };
  const audit = { record: jest.fn() };

  const clients = {
    forCompany: jest.fn(() =>
      Promise.resolve({
        client: mail,
        mode: mail?.mode ?? 'off',
        source: 'env',
        problem: null,
      }),
    ),
  };
  const service = new SalesMailService(
    clients as never,
    emails as never,
    leads as never,
    opportunities as never,
    leadActivities as never,
    opportunityActivities as never,
    quotations as never,
    {} as never,
    leadFiles as never,
    print as never,
    llm as never,
    notifications as never,
    events as never,
    audit as never,
  );
  return {
    service,
    mail,
    rows,
    emails,
    leads,
    opportunities,
    leadActivities,
    opportunityActivities,
    quotations,
    leadFiles,
    print,
    llm,
    notifications,
    events,
    audit,
  };
}

const inbound = (extra: Partial<InboundMail> = {}): InboundMail => ({
  graphMessageId: 'g-in-1',
  internetMessageId: '<in-1@example.com>',
  conversationId: 'conv-1',
  receivedAt: new Date('2026-11-05T04:00:00Z'),
  from: 'somchai@example.com',
  to: ['sales@osd.co.th'],
  cc: [],
  subject: 'RE: ขอบคุณที่สนใจบริการของเรา',
  text: 'สนใจครับ รบกวนส่งใบเสนอราคา',
  attachments: [],
  ...extra,
});

const outboundOrigin = {
  id: 'email-out-1',
  companyId: 'co-1',
  leadId: 'lead-1',
  opportunityId: null,
  quotationId: null,
  direction: 'out',
  purpose: 'lead_intro',
  status: 'sent',
  mailbox: 'sales@osd.co.th',
  toAddresses: ['somchai@example.com'],
  subject: 'ขอบคุณที่สนใจบริการของเรา',
  conversationId: 'conv-1',
};

describe('SalesMailService (5 พ.ย. 2569)', () => {
  describe('sendLeadIntro', () => {
    it('MAIL_MODE=off answers CRM_EMAIL_UNAVAILABLE and records nothing', async () => {
      const h = harness({ mail: null });
      await expect(
        h.service.sendLeadIntro('lead-1', { body: 'x' }, machine),
      ).rejects.toMatchObject({ code: 'CRM_EMAIL_UNAVAILABLE' });
      expect(h.emails.create).not.toHaveBeenCalled();
    });

    it('a Lead with no address cannot be written to', async () => {
      const h = harness();
      h.leads.findFirst.mockResolvedValueOnce({ ...lead, email: null });
      await expect(
        h.service.sendLeadIntro('lead-1', { body: 'x' }, machine),
      ).rejects.toMatchObject({ code: 'CRM_EMAIL_UNAVAILABLE' });
    });

    it('another company’s / an unseen Lead is 404', async () => {
      const h = harness();
      h.leads.findFirst.mockResolvedValueOnce(null as never);
      await expect(
        h.service.sendLeadIntro('lead-x', { body: 'x' }, machine),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('sends to the Lead’s own address, records the thread and logs an activity', async () => {
      const h = harness();
      const view = await h.service.sendLeadIntro(
        'lead-1',
        {
          body: 'เรียน คุณสมชาย\n\nขอบคุณครับ',
          attachments: [
            {
              name: 'proposal.pdf',
              contentType: 'application/pdf',
              contentBase64: 'QUJD',
            },
          ],
        },
        machine,
      );
      const sent = (h.mail as MockMailClient).sent[0];
      expect(sent.to).toEqual(['somchai@example.com']);
      expect(sent.subject).toBe('ขอบคุณที่สนใจบริการของเรา — บริษัท กขค จำกัด');
      expect(sent.html).toContain('<p>เรียน คุณสมชาย</p>');
      expect(view).toMatchObject({
        direction: 'out',
        purpose: 'lead_intro',
        status: 'sent',
        lead_id: 'lead-1',
        to: ['somchai@example.com'],
        attachments: [
          { name: 'proposal.pdf', contentType: 'application/pdf', size: 3 },
        ],
      });
      expect(h.rows[0].conversationId).toBe(sent.conversationId);
      expect(h.leadActivities.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          leadId: 'lead-1',
          type: 'email',
        }) as unknown,
      });
      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'crm.email.sent' }),
      );
    });

    it('attach_proposal attaches the newest proposal on the Lead (6 พ.ย. 2569)', async () => {
      const h = harness();
      h.leadFiles.latestProposal.mockResolvedValueOnce({
        id: 'f-1',
        fileName: 'Proposal กขค.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 3,
        content: Buffer.from('ABC'),
      });
      const view = await h.service.sendLeadIntro(
        'lead-1',
        { body: 'ขอบคุณครับ', attachProposal: true },
        machine,
      );
      expect(h.leadFiles.latestProposal).toHaveBeenCalledWith('lead-1');
      const sent = (h.mail as MockMailClient).sent[0];
      expect(sent.attachments).toEqual([
        {
          name: 'Proposal กขค.pdf',
          contentType: 'application/pdf',
          contentBase64: 'QUJD',
        },
      ]);
      expect(view.attachments).toEqual([
        { name: 'Proposal กขค.pdf', contentType: 'application/pdf', size: 3 },
      ]);
    });

    it('attach_proposal with no proposal on the Lead sends nothing and says why', async () => {
      const h = harness();
      await expect(
        h.service.sendLeadIntro(
          'lead-1',
          { body: 'ขอบคุณครับ', attachProposal: true },
          machine,
        ),
      ).rejects.toMatchObject({
        code: 'CRM_EMAIL_UNAVAILABLE',
        details: [{ field: 'proposal', reason: 'missing' }],
      });
      expect((h.mail as MockMailClient).sent).toHaveLength(0);
      expect(h.emails.create).not.toHaveBeenCalled();
    });

    it('a refused send is kept as a failed row and answered CRM_EMAIL_SEND_FAILED', async () => {
      const broken: MailClient = {
        mode: 'graph',
        mailbox: 'sales@osd.co.th',
        send: () => Promise.reject(new Error('Graph 403')),
        listInbox: () => Promise.resolve([]),
        read: () => Promise.reject(new Error('no')),
      };
      const h = harness({ mail: broken });
      await expect(
        h.service.sendLeadIntro('lead-1', { body: 'x' }, machine),
      ).rejects.toBeInstanceOf(AppError);
      expect(h.rows[0]).toMatchObject({ status: 'failed', error: 'Graph 403' });
      expect(h.leadActivities.create).not.toHaveBeenCalled();
    });

    it('refuses more than 20 MB of attachments before sending', async () => {
      const h = harness();
      await expect(
        h.service.sendLeadIntro(
          'lead-1',
          {
            body: 'x',
            attachments: [
              {
                name: 'big.pdf',
                contentType: 'application/pdf',
                contentBase64: 'A'.repeat(28_000_000),
              },
            ],
          },
          machine,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      expect((h.mail as MockMailClient).sent).toHaveLength(0);
    });
  });

  describe('ingest', () => {
    it('a message outside the system’s threads is not stored (the rest of the mailbox stays unread)', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce(null);
      expect(await h.service.ingest(inbound(), 'sales@osd.co.th')).toBeNull();
      expect(h.emails.create).not.toHaveBeenCalled();
    });

    it('our own message in the thread is not a reply', async () => {
      const h = harness();
      expect(
        await h.service.ingest(
          inbound({ from: 'SALES@osd.co.th' }),
          'sales@osd.co.th',
        ),
      ).toBeNull();
    });

    it('a message already stored is not stored twice', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      h.emails.count.mockResolvedValueOnce(1);
      expect(await h.service.ingest(inbound(), 'sales@osd.co.th')).toBeNull();
      expect(h.emails.create).not.toHaveBeenCalled();
    });

    it('classifies, logs, notifies the owner and emits crm.email.received', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      const row = await h.service.ingest(inbound(), 'sales@osd.co.th');

      expect(row).toMatchObject({
        direction: 'in',
        purpose: 'reply',
        leadId: 'lead-1',
        intent: 'interested',
        intentSource: 'rules',
        replyToEmailId: 'email-out-1',
      });
      expect(h.leadActivities.create).toHaveBeenCalled();
      expect(h.notifications.salesEmailReceived).toHaveBeenCalledWith(
        'u-sales',
        'co-1',
        expect.objectContaining({ intentLabel: 'สนใจ', resourceType: 'lead' }),
      );
      expect(h.events.emit).toHaveBeenCalledWith({
        name: 'crm.email.received',
        payload: {
          company_id: 'co-1',
          email_id: row!.id,
          lead_id: 'lead-1',
          opportunity_id: null,
          quotation_id: null,
          intent: 'interested',
        },
      });
    });

    it('a Lead converted after the thread began: the reply carries its deal', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      h.leads.findFirst.mockResolvedValueOnce({
        ...lead,
        convertedOpportunityId: 'opp-9',
      });
      h.opportunities.findFirst.mockResolvedValueOnce({
        ownerUserId: 'u-sales',
        title: 'ดีล กขค',
      });
      const row = await h.service.ingest(inbound(), 'sales@osd.co.th');
      expect(row).toMatchObject({ leadId: 'lead-1', opportunityId: 'opp-9' });
      expect(h.events.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            opportunity_id: 'opp-9',
          }) as unknown,
        }),
      );
    });

    it('after a quotation went out, "ยืนยัน" confirms it and the event names that quotation', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce({
        ...outboundOrigin,
        opportunityId: 'opp-1',
      });
      h.emails.findMany.mockResolvedValueOnce([
        { quotationId: null, purpose: 'lead_intro', status: 'sent' },
        { quotationId: 'qt-1', purpose: 'quotation', status: 'sent' },
      ] as never);
      h.opportunities.findFirst.mockResolvedValueOnce({
        ownerUserId: 'u-sales',
        title: 'ดีล กขค',
      });
      const row = await h.service.ingest(
        inbound({ text: 'ยืนยันตามใบเสนอราคาครับ' }),
        'sales@osd.co.th',
      );
      expect(row).toMatchObject({ intent: 'confirmed', quotationId: 'qt-1' });
      // converted: the activity goes on the deal
      expect(h.opportunityActivities.create).toHaveBeenCalled();
      expect(h.leadActivities.create).not.toHaveBeenCalled();
    });

    it('a bare answer to our requirement email goes on as interested, not unclear (13 พ.ย. 2569)', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      h.emails.findMany.mockResolvedValueOnce([
        { purpose: 'lead_intro', status: 'sent', direction: 'out' },
        { purpose: 'reply', status: 'received', direction: 'in' },
        { purpose: 'requirement_request', status: 'sent', direction: 'out' },
      ] as never);
      const row = await h.service.ingest(
        inbound({ text: '50 เครื่อง ที่ระยอง' }),
        'sales@osd.co.th',
      );
      expect(row).toMatchObject({
        intent: 'interested',
        intentReason: 'ตอบคำถาม requirement ที่ระบบถามไป',
      });

      // the same words in a thread where nothing was asked stay unclear
      const plain = harness();
      plain.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      expect(
        await plain.service.ingest(
          inbound({ text: '50 เครื่อง ที่ระยอง' }),
          'sales@osd.co.th',
        ),
      ).toMatchObject({ intent: 'unclear' });
    });

    it('"ขอส่วนลด" moves the deal to negotiating and tells the owner what to do (6 พ.ย. 2569)', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce({
        ...outboundOrigin,
        opportunityId: 'opp-1',
      });
      h.emails.findMany.mockResolvedValueOnce([
        { quotationId: 'qt-1', purpose: 'quotation', status: 'sent' },
      ] as never);
      h.opportunities.findFirst
        .mockResolvedValueOnce({
          id: 'opp-1',
          companyId: 'co-1',
          stage: 'proposing',
          amount: 1000,
        })
        .mockResolvedValueOnce({ ownerUserId: 'u-sales', title: 'ดีล กขค' });
      const row = await h.service.ingest(
        inbound({ text: 'ขอส่วนลดหน่อยครับ' }),
        'sales@osd.co.th',
      );
      expect(row).toMatchObject({ intent: 'negotiation' });
      expect(h.opportunities.update).toHaveBeenCalledWith({
        where: { id: 'opp-1' },
        data: { stage: 'negotiating', updatedBy: null },
      });
      expect(h.notifications.salesEmailReceived).toHaveBeenCalledWith(
        'u-sales',
        'co-1',
        expect.objectContaining({
          intentLabel: 'ขอต่อรอง/ส่วนลด',
          nextStep: expect.stringContaining('คำขอส่วนลด') as unknown,
        }),
      );
    });

    it('a deal already won or lost is never moved by an email', async () => {
      const h = harness();
      h.emails.findFirst.mockResolvedValueOnce({
        ...outboundOrigin,
        opportunityId: 'opp-1',
      });
      h.opportunities.findFirst.mockResolvedValueOnce({
        id: 'opp-1',
        companyId: 'co-1',
        stage: 'won',
        amount: 1000,
      });
      await h.service.ingest(
        inbound({ text: 'ขอส่วนลดเพิ่มครับ' }),
        'sales@osd.co.th',
      );
      expect(h.opportunities.update).not.toHaveBeenCalled();
    });

    it('uses the LLM when it is real, and the rules when it answers nonsense', async () => {
      const real = harness({
        llmMode: 'gateway',
        llmAnswer: '{"intent":"needs_info","reason":"ถามเรื่อง SLA"}',
      });
      real.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      expect(
        await real.service.ingest(inbound(), 'sales@osd.co.th'),
      ).toMatchObject({
        intent: 'needs_info',
        intentSource: 'llm',
        intentReason: 'ถามเรื่อง SLA',
      });
      expect(real.llm.chat).toHaveBeenCalledWith(
        { companyId: 'co-1', task: 'crm.email.intent', userId: null },
        expect.any(Array),
        expect.objectContaining({ temperature: 0 }),
      );

      const noisy = harness({ llmMode: 'gateway', llmAnswer: 'I think yes' });
      noisy.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
      expect(
        await noisy.service.ingest(inbound(), 'sales@osd.co.th'),
      ).toMatchObject({
        intent: 'interested',
        intentSource: 'rules',
      });
    });
  });

  describe('sendQuotation', () => {
    const quotation = {
      id: 'qt-1',
      quotationNo: 'QT-OSD-000123',
      version: 1,
      status: 'approved',
      opportunityId: 'opp-1',
      title: 'Cloud Backup',
      companyId: 'co-1',
    };
    const view = {
      quotation: {
        quotationNo: 'QT-OSD-000123',
        version: 1,
        title: 'Cloud Backup',
        currency: 'THB',
        validUntil: new Date('2026-12-05'),
        paymentTerms: null,
        note: null,
        subtotal: 1000,
        discountTotal: 0,
        netTotal: 1000,
        vatPct: 7,
        vatAmount: 70,
        grandTotal: 1070,
        createdAt: new Date('2026-11-05'),
        lines: [
          {
            lineNo: 1,
            productCode: 'CLOUD-BK-100',
            description: 'Cloud Backup 100 GB',
            quantity: 1,
            unit: 'ชุด',
            unitPrice: 1000,
            discountPct: 0,
            lineTotal: 1000,
            priceModel: 'unit',
            termMonths: null,
          },
        ],
      },
      billTo: {
        name: 'บริษัท กขค จำกัด',
        customerCode: null,
        taxId: null,
        branch: null,
        address: null,
        contactName: 'คุณสมชาย',
      },
      seller: { name: 'พนักงานขาย', email: 'sale@osd.co.th' },
      letterhead: {
        nameTh: 'บริษัท โอเอสดี จำกัด',
        nameEn: null,
        taxId: null,
        branch: null,
        address: null,
        phone: null,
        email: null,
        website: null,
        logo: null,
        terms: null,
      },
      monthlyRecurring: null,
      isFinal: true,
    };

    it('only an approved quotation goes out', async () => {
      const h = harness();
      h.quotations.findOne.mockResolvedValueOnce({
        ...quotation,
        status: 'draft',
      });
      await expect(
        h.service.sendQuotation('qt-1', {}, machine),
      ).rejects.toMatchObject({ code: 'CRM_QUOTATION_STATE_INVALID' });
    });

    it('answers the customer’s last message with the PDF, then marks it sent', async () => {
      const mail = new MockMailClient('sales@osd.co.th');
      const h = harness({ mail });
      h.quotations.findOne.mockResolvedValueOnce(quotation);
      h.opportunities.findFirst.mockResolvedValueOnce({
        id: 'opp-1',
        companyId: 'co-1',
        prospectEmail: null,
      });
      h.leads.findFirst.mockResolvedValueOnce({
        id: 'lead-1',
        email: 'somchai@example.com',
      } as never);
      h.emails.findFirst.mockResolvedValueOnce({
        id: 'email-in-1',
        graphMessageId: 'g-in-1',
        subject: 'RE: ขอบคุณที่สนใจบริการของเรา',
        direction: 'in',
      });
      h.print.printView.mockResolvedValueOnce(view);
      h.quotations.send.mockResolvedValueOnce({
        ...quotation,
        status: 'sent',
        netTotal: 1000,
      });
      h.opportunities.findFirst.mockResolvedValueOnce({
        id: 'opp-1',
        companyId: 'co-1',
        stage: 'qualifying',
        amount: null,
      });

      const result = await h.service.sendQuotation('qt-1', {}, machine);

      // a price is on the table: proposing, worth the quotation (6 พ.ย. 2569)
      expect(h.opportunities.update).toHaveBeenCalledWith({
        where: { id: 'opp-1' },
        data: expect.objectContaining({
          stage: 'proposing',
          amount: 1000,
        }) as unknown,
      });

      const sent = mail.sent[0];
      expect(sent.replyToGraphId).toBe('g-in-1');
      expect(sent.subject).toBe('RE: ขอบคุณที่สนใจบริการของเรา');
      expect(sent.to).toEqual(['somchai@example.com']);
      expect(sent.attachments?.[0]).toMatchObject({
        name: 'ใบเสนอราคา-QT-OSD-000123.pdf',
        contentType: 'application/pdf',
      });
      expect(
        Buffer.from(sent.attachments![0].contentBase64, 'base64')
          .subarray(0, 5)
          .toString(),
      ).toBe('%PDF-');
      expect(h.quotations.send).toHaveBeenCalledWith('qt-1', machine);
      expect(result.email).toMatchObject({
        purpose: 'quotation',
        quotation_id: 'qt-1',
        reply_to_email_id: 'email-in-1',
      });
    });

    it('a deal with no address stops before the PDF is drawn', async () => {
      const h = harness();
      h.quotations.findOne.mockResolvedValueOnce(quotation);
      h.opportunities.findFirst.mockResolvedValueOnce({
        id: 'opp-1',
        companyId: 'co-1',
        prospectEmail: null,
      });
      h.leads.findFirst.mockResolvedValueOnce(null as never);
      await expect(
        h.service.sendQuotation('qt-1', {}, machine),
      ).rejects.toMatchObject({ code: 'CRM_EMAIL_UNAVAILABLE' });
      expect(h.print.printView).not.toHaveBeenCalled();
      expect(h.quotations.send).not.toHaveBeenCalled();
    });
  });

  it('simulateReply works only in MAIL_MODE=mock', async () => {
    const graphLike: MailClient = {
      mode: 'graph',
      mailbox: 'sales@osd.co.th',
      send: jest.fn(),
      listInbox: jest.fn(),
      read: jest.fn(),
    };
    const h = harness({ mail: graphLike });
    h.emails.findFirst.mockResolvedValueOnce(outboundOrigin);
    await expect(
      h.service.simulateReply('email-1', { text: 'สนใจ' }, machine),
    ).rejects.toMatchObject({ code: 'CRM_EMAIL_UNAVAILABLE' });
  });
});
