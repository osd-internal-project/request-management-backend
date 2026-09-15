import { Principal } from '@request-management/share';
import { OpportunitiesService } from './opportunities.service';
import { SaleOrdersService } from './sale-orders.service';
import { LeadsService } from './leads.service';
import {
  DEFAULT_LEAD_STATUSES,
  type LeadStatusRow,
} from './lead-status.service';

/**
 * PO 10 ก.ย. 2569 — "การเปิด opportunity ยังไม่ถือเป็น customer; customer จะเกิด
 * ได้ต้องเป็นการเปิด Sale order แล้วเท่านั้น". These tests pin that rule at the
 * three seams: opportunity create (prospect allowed, customer optional), lead
 * convert (no customer needed), and sale-order open (the only place a customer
 * row is created and linked back).
 */

function principal(
  permissions: string[] = ['crm.sales.read', 'crm.sales.manage'],
): Principal {
  return {
    userId: 'me',
    displayName: 'ทดสอบ ขาย',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
  } as unknown as Principal;
}

type Args = Record<string, unknown>;
type DataArgs = { data: Args; where?: Args };

/** First positional argument of a mock's first call. */
function firstArg<T = Args>(fn: { mock: { calls: unknown[][] } }): T {
  return fn.mock.calls[0][0] as T;
}

function recorder() {
  const events: { eventType: string; summary?: string }[] = [];
  return {
    events,
    fn: jest.fn((entry: { eventType: string; summary?: string }) => {
      events.push(entry);
      return Promise.resolve();
    }),
  };
}

describe('CRM โอกาสการขาย — เปิดได้โดยยังไม่เป็นลูกค้า (ผู้มุ่งหวัง)', () => {
  function harness(options: { kycRules?: { productCode: string }[] } = {}) {
    const audit = recorder();
    const timeline = recorder();
    const opportunities = {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'opportunity-1',
          opportunityCode: 'OPP-OSD-000001',
          stage: 'proposing',
          companyId: 'osd',
          customerId: null,
          customer: null,
          prospectName: 'บริษัท ผู้มุ่งหวัง จำกัด',
          products: [{ productCode: 'SIP-TRUNK', name: null }],
          saleOrders: [],
        }),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'opportunity-1',
          opportunityCode: 'OPP-OSD-000001',
          ...args.data,
        }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    };
    const customers = {
      findFirst: jest.fn(() =>
        Promise.resolve({ id: 'cust-1', nameTh: 'บริษัท กขค จำกัด' }),
      ),
    };
    const service = new OpportunitiesService(
      opportunities as never,
      { createMany: jest.fn() } as never,
      { findFirst: jest.fn(), findMany: jest.fn() } as never,
      customers as never,
      {
        findMany: jest.fn(() => Promise.resolve(options.kycRules ?? [])),
      } as never,
      { issue: jest.fn(() => Promise.resolve('OPP-OSD-000001')) } as never,
      { publish: timeline.fn } as never,
      { record: audit.fn } as never,
      {
        execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
          work({}),
        ),
      } as never,
    );
    return { service, opportunities, customers, audit, timeline };
  }

  it('ไม่มีทั้ง customer_id และ prospect_name = VALIDATION_FAILED', async () => {
    const { service, opportunities } = harness();

    await expect(
      service.create({ title: 'ดีลลอย' }, principal()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(opportunities.create).not.toHaveBeenCalled();
  });

  it('เปิดด้วยผู้มุ่งหวัง: customerId = null, เก็บ prospect*, ไม่แตะทะเบียนลูกค้า และไม่ลงไทม์ไลน์ (ยังไม่มีลูกค้า)', async () => {
    const { service, opportunities, customers, timeline, audit } = harness();

    await service.create(
      {
        title: 'ติดตั้ง SIP Trunk',
        prospect_name: ' บริษัท ผู้มุ่งหวัง จำกัด ',
        prospect_tax_id: '0-1055-12345-67-8',
        prospect_contact_name: 'คุณเอ',
      },
      principal(),
    );

    const data = firstArg<DataArgs>(opportunities.create).data;
    expect(data.customerId).toBeNull();
    expect(data.prospectName).toBe('บริษัท ผู้มุ่งหวัง จำกัด');
    expect(data.prospectTaxId).toBe('0105512345678');
    expect(customers.findFirst).not.toHaveBeenCalled();
    expect(timeline.events).toHaveLength(0);
    expect(audit.events.map((a) => a.eventType)).toContain(
      'crm.opportunity.created',
    );
  });

  it('เปิดให้ลูกค้าเดิม (repeat business): ผูก customerId และลงไทม์ไลน์ตามเดิม', async () => {
    const { service, opportunities, timeline } = harness();

    await service.create(
      { title: 'ต่ออายุ', customer_id: 'cust-1' },
      principal(),
    );

    expect(firstArg<DataArgs>(opportunities.create).data.customerId).toBe(
      'cust-1',
    );
    expect(
      firstArg<DataArgs>(opportunities.create).data.prospectName,
    ).toBeUndefined();
    expect(timeline.events.map((t) => t.eventType)).toEqual([
      'opportunity.created',
    ]);
  });

  it('CM-04: ผู้มุ่งหวัง (ยังไม่มีลูกค้า) + product เข้าเงื่อนไข = เตือน KYC ไม่ error', async () => {
    const { service } = harness({ kycRules: [{ productCode: 'SIP-TRUNK' }] });

    const detail = (await service.findOne('opportunity-1', principal())) as {
      customer: unknown;
      kycWarning: { required: boolean; products: string[] };
    };

    expect(detail.customer).toBeNull();
    expect(detail.kycWarning).toEqual({
      required: true,
      products: ['SIP-TRUNK'],
    });
  });

  it('ไม่มี win() แล้ว — ปิดชนะเกิดจากการเปิดใบสั่งขายเท่านั้น', () => {
    const { service } = harness();
    expect((service as unknown as { win?: unknown }).win).toBeUndefined();
  });
});

describe('CRM Lead — convert โดยไม่ต้องมีลูกค้าในทะเบียน', () => {
  function harness(lead: Record<string, unknown>) {
    const audit = recorder();
    const leads = {
      findFirst: jest.fn(() => Promise.resolve(lead)),
      update: jest.fn(() => Promise.resolve({})),
    };
    const customers = {
      findFirst: jest.fn(() => Promise.resolve({ id: 'cust-1' })),
    };
    const opportunities = {
      create: jest.fn(() =>
        Promise.resolve({
          id: 'opportunity-9',
          opportunityCode: 'OPP-OSD-000009',
        }),
      ),
    };
    // ชุดสถานะตั้งต้นเดียวกับที่ migration seed — convert ยังเดินจาก 'qualified'
    // ไป 'converted' ตามเดิม โดยรหัสมาจากข้อมูล ไม่ใช่จากโค้ด.
    const rows = DEFAULT_LEAD_STATUSES.map((row, index) => ({
      ...row,
      id: `status-${index}`,
      companyId: 'osd',
    })) as LeadStatusRow[];
    const statuses = {
      listAll: jest.fn(() => Promise.resolve(rows)),
      require: jest.fn((_companyId: string, code: string) =>
        Promise.resolve(rows.find((row) => row.code === code)),
      ),
      defaultCode: jest.fn(() => Promise.resolve('new')),
      closingCode: jest.fn((_companyId: string, kind: string) =>
        Promise.resolve(
          rows.find((row) => row.kind === kind)?.code ?? 'converted',
        ),
      ),
    };

    const service = new LeadsService(
      leads as never,
      customers as never,
      opportunities as never,
      { record: audit.fn } as never,
      { execute: jest.fn() } as never,
      {} as never,
      {} as never,
      statuses as never,
      { kickLead: jest.fn() } as never,
    );
    return { service, leads, customers, opportunities };
  }

  const baseLead = {
    id: 'lead-1',
    name: 'บริษัท มุ่งหวัง จำกัด',
    status: 'qualified',
    customerId: null,
    taxId: '0105512345678',
    contactName: 'คุณบี',
    phone: '0812345678',
    email: 'b@example.com',
  };

  it('ไม่ส่ง customer_id → โอกาสการขายของผู้มุ่งหวัง ข้อมูลระบุตัวไหลจาก Lead', async () => {
    const { service, opportunities, customers, leads } = harness(baseLead);

    await service.convert('lead-1', {}, principal());

    expect(customers.findFirst).not.toHaveBeenCalled();
    expect(opportunities.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prospect_name: 'บริษัท มุ่งหวัง จำกัด',
        prospect_tax_id: '0105512345678',
        prospect_contact_name: 'คุณบี',
        prospect_phone: '0812345678',
        prospect_email: 'b@example.com',
        title: 'บริษัท มุ่งหวัง จำกัด',
      }),
      expect.anything(),
      { fromLeadId: 'lead-1' },
    );
    expect(firstArg(opportunities.create).customer_id).toBeUndefined();
    expect(firstArg<DataArgs>(leads.update).data.customerId).toBeNull();
  });

  it('Lead ที่ match ลูกค้าเดิมไว้แล้ว → ใช้ลูกค้ารายนั้นโดยไม่ต้องเลือกซ้ำ', async () => {
    const { service, opportunities } = harness({
      ...baseLead,
      customerId: 'cust-1',
    });

    await service.convert('lead-1', {}, principal());

    expect(firstArg(opportunities.create)).toEqual(
      expect.objectContaining({ customer_id: 'cust-1' }),
    );
  });
});

describe('CRM ใบสั่งขาย — จุดเดียวที่ลูกค้าในทะเบียนเกิด', () => {
  function harness(
    options: {
      opportunity?: Record<string, unknown> | null;
      existingByTaxId?: Record<string, unknown> | null;
    } = {},
  ) {
    const audit = recorder();
    const timeline = recorder();

    const prospectOpportunity = {
      id: 'opportunity-1',
      opportunityCode: 'OPP-OSD-000001',
      title: 'ติดตั้ง SIP Trunk',
      stage: 'negotiating',
      amount: 120000,
      currency: 'THB',
      customerId: null,
      prospectName: 'บริษัท ผู้มุ่งหวัง จำกัด',
      prospectTaxId: '0105512345678',
      prospectContactName: 'คุณเอ',
      prospectPhone: '0899999999',
      prospectEmail: 'a@example.com',
      ownerUserId: 'me',
      ownerOrgUnitId: 'unit-sales',
      fromLead: {
        id: 'lead-1',
        customerId: null,
        nameEn: 'Prospect Co., Ltd.',
        contactPosition: 'IT Manager',
        addressLine: '99 ถนนสุขุมวิท',
        district: 'คลองเตย',
        province: 'กรุงเทพมหานคร',
        postalCode: '10110',
        country: 'TH',
      },
    };

    const saleOrders = {
      create: jest.fn(() =>
        Promise.resolve({ id: 'so-1', saleOrderCode: 'SO-OSD-000001' }),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'so-1',
          saleOrderCode: 'SO-OSD-000001',
          status: 'open',
          customerId: 'cust-new',
        }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      update: jest.fn(() => Promise.resolve({})),
    };
    const opportunities = {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.opportunity === undefined
            ? prospectOpportunity
            : options.opportunity,
        ),
      ),
      update: jest.fn(() => Promise.resolve({})),
    };
    const leads = { update: jest.fn(() => Promise.resolve({})) };
    const quotations = {
      findFirst: jest.fn(() => Promise.resolve(null)),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    };
    const customers = {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        if (args.where.taxId)
          return Promise.resolve(options.existingByTaxId ?? null);
        return Promise.resolve({
          id: args.where.id,
          customerCode: 'CUS-OSD-000001',
          nameTh: 'บริษัท กขค จำกัด',
        });
      }),
    };
    const customersService = {
      create: jest.fn(() =>
        Promise.resolve({
          id: 'cust-new',
          customerCode: 'CUS-OSD-000002',
          nameTh: 'บริษัท ผู้มุ่งหวัง จำกัด',
        }),
      ),
    };

    const service = new SaleOrdersService(
      saleOrders as never,
      opportunities as never,
      leads as never,
      customers as never,
      customersService as never,
      { issue: jest.fn(() => Promise.resolve('SO-OSD-000001')) } as never,
      { publish: timeline.fn } as never,
      { record: audit.fn } as never,
      {
        execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
          work({}),
        ),
      } as never,
      quotations as never,
    );

    return {
      service,
      saleOrders,
      opportunities,
      leads,
      quotations,
      customers,
      customersService,
      audit,
      timeline,
    };
  }

  it('ผู้มุ่งหวัง → สร้างลูกค้าจากข้อมูลบนโอกาสการขาย+Lead แล้วผูกกลับทั้งโอกาสการขายและ Lead, ปิดชนะ, ลงไทม์ไลน์', async () => {
    const h = harness();

    const result = (await h.service.open(
      'opportunity-1',
      { note: 'ลูกค้ายืนยันทางอีเมล' },
      principal(),
    )) as { customerCreated: boolean };

    // ลูกค้าเกิดที่นี่ — ผ่าน CustomersService.create ทางเดียวกับหน้าจอ
    expect(h.customersService.create).toHaveBeenCalledTimes(1);
    const dto = firstArg<Args & { contacts: Args[]; locations: Args[] }>(
      h.customersService.create,
    );
    expect(dto).toEqual(
      expect.objectContaining({
        type: 'corporate',
        name_th: 'บริษัท ผู้มุ่งหวัง จำกัด',
        name_en: 'Prospect Co., Ltd.',
        tax_id: '0105512345678',
        account_owner_user_id: 'me',
        status: 'active',
      }),
    );
    expect(dto.contacts[0]).toEqual(
      expect.objectContaining({
        name: 'คุณเอ',
        position: 'IT Manager',
        phone: '0899999999',
        is_primary: true,
      }),
    );
    expect(dto.locations[0]).toEqual(
      expect.objectContaining({
        line1: '99 ถนนสุขุมวิท',
        postal_code: '10110',
        is_billing: true,
      }),
    );
    expect(result.customerCreated).toBe(true);

    // ใบสั่งขายผูกลูกค้าใหม่ + มูลค่าตกทอดจากโอกาสการขาย
    expect(firstArg<DataArgs>(h.saleOrders.create).data).toEqual(
      expect.objectContaining({
        saleOrderCode: 'SO-OSD-000001',
        opportunityId: 'opportunity-1',
        customerId: 'cust-new',
        amount: 120000,
      }),
    );

    // ผูกกลับ + ปิดชนะ
    expect(firstArg<DataArgs>(h.opportunities.update).data).toEqual(
      expect.objectContaining({ customerId: 'cust-new', stage: 'won' }),
    );
    expect(firstArg(h.leads.update)).toEqual(
      expect.objectContaining({
        where: { id: 'lead-1' },
        data: expect.objectContaining({ customerId: 'cust-new' }) as unknown,
      }),
    );
    // ใบเสนอราคาที่ออกตอนเป็นผู้มุ่งหวังถูกผูกลูกค้าตาม
    expect(firstArg(h.quotations.updateMany)).toEqual({
      where: { opportunityId: 'opportunity-1', customerId: null },
      data: { customerId: 'cust-new' },
    });

    expect(h.audit.events.map((a) => a.eventType)).toEqual([
      'crm.sale_order.opened',
      'crm.opportunity.won',
    ]);
    expect(h.timeline.events.map((t) => t.eventType)).toEqual([
      'opportunity.won',
      'sale_order.opened',
    ]);
  });

  it('โอกาสการขายของลูกค้าเดิม → ไม่สร้างลูกค้าซ้ำ ใช้รายเดิม', async () => {
    const h = harness({
      opportunity: {
        id: 'opportunity-2',
        opportunityCode: 'OPP-OSD-000002',
        title: 'ต่ออายุ',
        stage: 'proposing',
        amount: null,
        currency: 'THB',
        customerId: 'cust-1',
        prospectName: null,
        prospectTaxId: null,
        prospectContactName: null,
        prospectPhone: null,
        prospectEmail: null,
        ownerUserId: 'me',
        ownerOrgUnitId: null,
        fromLead: null,
      },
    });

    const result = (await h.service.open(
      'opportunity-2',
      { amount: 5000 },
      principal(),
    )) as { customerCreated: boolean };

    expect(h.customersService.create).not.toHaveBeenCalled();
    expect(result.customerCreated).toBe(false);
    expect(firstArg<DataArgs>(h.saleOrders.create).data).toEqual(
      expect.objectContaining({ customerId: 'cust-1', amount: 5000 }),
    );
    expect(h.leads.update).not.toHaveBeenCalled();
  });

  it('เลขภาษี+สาขาของผู้มุ่งหวังตรงกับลูกค้าเดิม → ผูกรายเดิม ไม่สร้างใหม่ (ไม่ชน CM-03)', async () => {
    const h = harness({
      existingByTaxId: {
        id: 'cust-existing',
        customerCode: 'CUS-OSD-000009',
        nameTh: 'บริษัท ผู้มุ่งหวัง จำกัด',
      },
    });

    await h.service.open('opportunity-1', {}, principal());

    expect(h.customersService.create).not.toHaveBeenCalled();
    expect(h.customers.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          taxId: '0105512345678',
          branchCode: '00000',
        }) as unknown,
      }),
    );
    expect(firstArg<DataArgs>(h.opportunities.update).data.customerId).toBe(
      'cust-existing',
    );
  });

  it('ผู้ใช้เลือกลูกค้าเดิมเอง (customer_id) → ข้ามการสร้าง', async () => {
    const h = harness();

    await h.service.open(
      'opportunity-1',
      { customer_id: 'cust-picked' },
      principal(),
    );

    expect(h.customersService.create).not.toHaveBeenCalled();
    expect(firstArg<DataArgs>(h.saleOrders.create).data.customerId).toBe(
      'cust-picked',
    );
  });

  it('ค่าที่ผู้ใช้แก้ในกล่อง (ชื่อ/ประเภท/เลขภาษี) ทับค่าตั้งต้นจากผู้มุ่งหวัง', async () => {
    const h = harness();

    await h.service.open(
      'opportunity-1',
      {
        customer: {
          type: 'individual',
          name_th: 'นายเอ ผู้มุ่งหวัง',
          tax_id: '1234567890123',
          confirm_duplicate: true,
          override_reason: 'คนละราย ยืนยันแล้ว',
        },
      },
      principal(),
    );

    expect(firstArg(h.customersService.create)).toEqual(
      expect.objectContaining({
        type: 'individual',
        name_th: 'นายเอ ผู้มุ่งหวัง',
        tax_id: '1234567890123',
        confirm_duplicate: true,
        override_reason: 'คนละราย ยืนยันแล้ว',
      }),
    );
  });

  it('โอกาสการขายที่ปิดแล้ว (won/lost) เปิดใบสั่งขายไม่ได้', async () => {
    const h = harness({
      opportunity: {
        id: 'opportunity-3',
        opportunityCode: 'OPP-3',
        stage: 'lost',
        customerId: null,
        prospectName: 'x',
        fromLead: null,
      },
    });

    await expect(
      h.service.open('opportunity-3', {}, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.customersService.create).not.toHaveBeenCalled();
    expect(h.saleOrders.create).not.toHaveBeenCalled();
  });

  it('SCOPE-03: โอกาสการขายนอกขอบเขต = 404', async () => {
    const h = harness({ opportunity: null });

    await expect(
      h.service.open('opportunity-x', {}, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ยกเลิกใบสั่งขาย: สถานะ+เหตุผล ไม่ลบ, ยกเลิกซ้ำไม่ได้', async () => {
    const h = harness();

    await h.service.cancel(
      'so-1',
      { reason: 'ลูกค้าขอเลื่อนโครงการ' },
      principal(),
    );

    expect(firstArg<DataArgs>(h.saleOrders.update).data).toEqual(
      expect.objectContaining({
        status: 'cancelled',
        cancelReason: 'ลูกค้าขอเลื่อนโครงการ',
      }),
    );
    expect(h.timeline.events.map((t) => t.eventType)).toContain(
      'sale_order.cancelled',
    );

    h.saleOrders.findFirst.mockResolvedValueOnce({
      id: 'so-1',
      saleOrderCode: 'SO-OSD-000001',
      status: 'cancelled',
      customerId: 'cust-new',
    });
    await expect(
      h.service.cancel('so-1', { reason: 'อีกครั้ง' }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
