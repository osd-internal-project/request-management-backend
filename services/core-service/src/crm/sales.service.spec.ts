import { Principal } from '@request-management/share';
import { OpportunitiesService } from './opportunities.service';
import { LeadsService } from './leads.service';
import {
  DEFAULT_LEAD_STATUSES,
  type LeadStatusRow,
} from './lead-status.service';

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

function opportunityHarness(
  options: {
    found?: Record<string, unknown> | null;
    reason?: { code: string; name: string } | null;
    kycRules?: { productCode: string }[];
  } = {},
) {
  const audits: { eventType: string }[] = [];
  const timelineEvents: { eventType: string; summary: string }[] = [];

  const openOpportunity = {
    id: 'opportunity-1',
    opportunityCode: 'OPP-OSD-000001',
    stage: 'negotiating',
    customerId: 'cust-1',
    companyId: 'osd',
    products: [{ productCode: 'SIP-TRUNK', name: null }],
    customer: { kycVerified: false },
  };

  const opportunities = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.found === undefined ? openOpportunity : options.found,
      ),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(() =>
      Promise.resolve({
        id: 'opportunity-1',
        opportunityCode: 'OPP-OSD-000001',
      }),
    ),
    update: jest.fn(() => Promise.resolve({})),
    sumAmount: jest.fn(() => Promise.resolve(0)),
  };
  const products = { createMany: jest.fn() };
  const lostReasons = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.reason === undefined
          ? { code: 'price', name: 'ราคาสู้ไม่ได้' }
          : options.reason,
      ),
    ),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve({ id: 'cust-1', nameTh: 'บริษัท กขค จำกัด' }),
    ),
  };
  const kycProducts = {
    findMany: jest.fn(() => Promise.resolve(options.kycRules ?? [])),
  };
  const codes = {
    issueUnused: jest.fn(() => Promise.resolve('OPP-OSD-000001')),
  };
  const timeline = {
    publish: jest.fn((event: { eventType: string; summary: string }) => {
      timelineEvents.push(event);
      return Promise.resolve();
    }),
  };
  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
      work({ opportunityProduct: { deleteMany: jest.fn() } }),
    ),
  };

  const service = new OpportunitiesService(
    opportunities as never,
    products as never,
    lostReasons as never,
    customers as never,
    kycProducts as never,
    codes as never,
    timeline as never,
    audit as never,
    transactions as never,
  );

  return { service, opportunities, audits, timelineEvents, lostReasons };
}

describe('CRM โอกาสการขาย — ปิดชนะ/แพ้ และคำเตือน KYC ระดับ product', () => {
  it('ปิดแพ้ด้วยเหตุผลนอกรายการมาตรฐาน = ถูกปฏิเสธ (spec CRM)', async () => {
    const { service } = opportunityHarness({ reason: null });

    await expect(
      service.lose('opportunity-1', { reason_code: 'made-up' }, principal()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('ปิดแพ้สำเร็จ → audit crm.opportunity.lost + เหตุการณ์เข้าไทม์ไลน์ลูกค้า', async () => {
    const { service, audits, timelineEvents } = opportunityHarness();
    jest
      .spyOn(service, 'findOne')
      .mockResolvedValue({ id: 'opportunity-1' } as never);

    await service.lose(
      'opportunity-1',
      { reason_code: 'price', reason_text: 'ต่ำกว่าทุน' },
      principal(),
    );

    expect(audits.map((a) => a.eventType)).toContain('crm.opportunity.lost');
    expect(timelineEvents.map((t) => t.eventType)).toContain(
      'opportunity.lost',
    );
  });

  it('โอกาสการขายที่ปิดแล้วแก้ไข/ปิดซ้ำไม่ได้', async () => {
    const { service } = opportunityHarness({
      found: {
        id: 'opportunity-1',
        opportunityCode: 'OPP-1',
        stage: 'won',
        customerId: 'c',
      },
    });

    await expect(
      service.lose('opportunity-1', { reason_code: 'price' }, principal()),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('CM-04 ชุดงาน B — โอกาสการขายที่มี product เข้าเงื่อนไข + ลูกค้ายังไม่ KYC = คำเตือน ไม่ error', async () => {
    const { service } = opportunityHarness({
      kycRules: [{ productCode: 'SIP-TRUNK' }],
    });

    const opportunity = (await service.findOne(
      'opportunity-1',
      principal(),
    )) as {
      kycWarning: { required: boolean; products: string[] };
    };

    expect(opportunity.kycWarning).toEqual({
      required: true,
      products: ['SIP-TRUNK'],
    });
  });

  it('SCOPE-03 โอกาสการขายนอกขอบเขต = 404', async () => {
    const { service } = opportunityHarness({ found: null });

    await expect(
      service.findOne('opportunity-x', principal()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('CRM Lead — แปลงเป็นโอกาสการขายโดยข้อมูลไหลต่อ', () => {
  function leadHarness(options: { status?: string } = {}) {
    const audits: { eventType: string }[] = [];
    const lead = {
      id: 'lead-1',
      name: 'บริษัท มุ่งหวัง จำกัด',
      status: options.status ?? 'qualified',
      ownerUserId: 'me',
      activities: [
        {
          id: 'act-1',
          type: 'call',
          subject: 'โทรแนะนำตัว',
          createdBy: 'me',
          completedBy: null,
          completedAt: null,
        },
      ],
    };
    const leads = {
      findFirst: jest.fn(() => Promise.resolve(lead)),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      create: jest.fn(() => Promise.resolve({ id: 'lead-1' })),
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
    const audit = {
      record: jest.fn((entry: { eventType: string }) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    };
    const transactions = { execute: jest.fn() };
    const activities = {
      findFirst: jest.fn(() =>
        Promise.resolve({ id: 'act-1', completedAt: null }),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'act-2', ...args.data }),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'act-1', ...args.data }),
      ),
    };
    const members = {
      findMany: jest.fn(() =>
        Promise.resolve([{ id: 'me', displayName: 'ทดสอบ ขาย' }]),
      ),
    };

    // รายการสถานะเป็นข้อมูลของบริษัท — harness ใช้ชุดตั้งต้นชุดเดียวกับที่
    // migration seed ให้ ทำให้ test ยังพูดถึง 'qualified'/'converted' ได้ตามเดิม
    // ทั้งที่โค้ดไม่รู้จักรหัสพวกนั้นแล้ว.
    const rows = DEFAULT_LEAD_STATUSES.map((row, index) => ({
      ...row,
      id: `status-${index}`,
      companyId: 'osd',
    })) as LeadStatusRow[];
    const statuses = {
      listAll: jest.fn(() => Promise.resolve(rows)),
      require: jest.fn((_companyId: string, code: string) => {
        const found = rows.find((row) => row.code === code);
        if (!found) throw new Error(`unknown status ${code}`);
        return Promise.resolve(found);
      }),
      defaultCode: jest.fn(() => Promise.resolve('new')),
      closingCode: jest.fn((_companyId: string, kind: string) =>
        Promise.resolve(
          rows.find((row) => row.kind === kind)?.code ?? 'converted',
        ),
      ),
    };

    // Lead ใบใหม่เปิด instance ของ `lwf-0001` — ยิงแบบไม่รอผล ที่นี่แค่ดักว่าถูกเรียก.
    const workflowSync = { kickLead: jest.fn() };

    const service = new LeadsService(
      leads as never,
      customers as never,
      opportunities as never,
      audit as never,
      transactions as never,
      activities as never,
      members as never,
      statuses as never,
      workflowSync as never,
    );

    return { service, leads, opportunities, activities, audits, workflowSync };
  }

  it('หน้ารายละเอียด: findOne คืนชื่อผู้รับผิดชอบและชื่อผู้ลงกิจกรรม ไม่ใช่แค่ user id', async () => {
    const { service } = leadHarness();

    const lead = (await service.findOne('lead-1', principal())) as {
      owner: { displayName: string };
      activities: { createdByName: string }[];
    };

    expect(lead.owner.displayName).toBe('ทดสอบ ขาย');
    expect(lead.activities[0].createdByName).toBe('ทดสอบ ขาย');
  });

  it('เลื่อนขั้น pipeline (ติดต่อไม่ได้) → บันทึกสถานะ + audit crm.lead.status_changed', async () => {
    const { service, leads, audits } = leadHarness({ status: 'new' });

    await service.setStatus(
      'lead-1',
      { status: 'cannot_contact' },
      principal(),
    );

    expect(leads.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'cannot_contact' }),
      }),
    );
    expect(audits.map((a) => a.eventType)).toContain('crm.lead.status_changed');
  });

  it('ลงกิจกรรมโดยไม่มีกำหนด = บันทึกสิ่งที่ทำแล้ว (ปิดทันที); มีกำหนด = ยังเปิดอยู่', async () => {
    const { service, activities } = leadHarness();

    const logged = (await service.addActivity(
      'lead-1',
      { type: 'call', subject: 'โทรตามใบเสนอราคา' },
      principal(),
    )) as unknown as { completedAt: Date | null; completedBy: string | null };
    expect(logged.completedAt).toBeInstanceOf(Date);
    expect(logged.completedBy).toBe('me');

    const planned = (await service.addActivity(
      'lead-1',
      {
        type: 'meeting',
        subject: 'นัด demo',
        due_at: '2026-09-15T03:00:00.000Z',
      },
      principal(),
    )) as unknown as { completedAt: Date | null; dueAt: Date | null };
    expect(planned.completedAt).toBeNull();
    expect(planned.dueAt).toEqual(new Date('2026-09-15T03:00:00.000Z'));
    expect(activities.create).toHaveBeenCalledTimes(2);
  });

  it('ติ๊กกิจกรรมเสร็จ → completedAt/completedBy; Lead ที่ปิดแล้วลงกิจกรรมไม่ได้', async () => {
    const { service } = leadHarness();

    const done = (await service.updateActivity(
      'lead-1',
      'act-1',
      { completed: true },
      principal(),
    )) as unknown as { completedAt: Date | null; completedBy: string | null };
    expect(done.completedAt).toBeInstanceOf(Date);
    expect(done.completedBy).toBe('me');

    const closed = leadHarness({ status: 'disqualified' });
    await expect(
      closed.service.addActivity(
        'lead-1',
        { type: 'note', subject: 'x' },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('convert สร้างโอกาสการขายผ่าน OpportunitiesService แล้วปิด Lead เป็น converted พร้อมชี้โอกาสการขาย', async () => {
    const { service, leads, opportunities } = leadHarness();

    const opportunity = await service.convert(
      'lead-1',
      { customer_id: 'cust-1' },
      principal(),
    );

    expect(opportunity.opportunityCode).toBe('OPP-OSD-000009');
    expect(opportunities.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'cust-1' }),
      expect.anything(),
      { fromLeadId: 'lead-1' },
    );
    expect(leads.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'converted',
          convertedOpportunityId: 'opportunity-9',
        }),
      }),
    );
  });

  it('Lead ที่ปิดแล้ว convert ซ้ำไม่ได้', async () => {
    const { service } = leadHarness({ status: 'converted' });

    await expect(
      service.convert('lead-1', { customer_id: 'cust-1' }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
