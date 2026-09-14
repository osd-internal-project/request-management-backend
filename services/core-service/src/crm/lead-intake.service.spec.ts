import { Principal, visibleSalesWhere } from '@request-management/share';
import { LeadIntakeService } from './lead-intake.service';
import { LeadsService } from './leads.service';
import {
  DEFAULT_LEAD_STATUSES,
  type LeadStatusRow,
} from './lead-status.service';

/** บัญชีบริการของช่องทางรับ Lead — ไม่ใช่คน ไม่สังกัดหน่วยงาน. */
function robot(
  permissions: string[] = ['integration.crm.lead.create'],
): Principal {
  return {
    userId: 'svc-intake',
    displayName: 'Lead Intake',
    activeCompanyId: 'osd',
    orgUnitId: null,
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: true,
    permissions,
  } as unknown as Principal;
}

function sales(
  permissions: string[] = ['crm.sales.read', 'crm.sales.manage'],
): Principal {
  return {
    userId: 'sales-1',
    displayName: 'ทดสอบ ขาย',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
  } as unknown as Principal;
}

function harness(
  options: {
    lead?: Record<string, unknown> | null;
    member?: Record<string, unknown> | null;
  } = {},
) {
  const audits: { eventType: string; before?: unknown; after?: unknown }[] = [];
  const whereSeen: unknown[] = [];

  const lead =
    options.lead === undefined
      ? {
          id: 'lead-1',
          name: 'บจก. ตัวอย่าง เทคโนโลยี',
          status: 'new',
          ownerUserId: null,
          customerId: null,
          taxId: null,
          contactName: null,
          phone: null,
          email: null,
        }
      : options.lead;

  const leads = {
    findFirst: jest.fn((args: { where: unknown }) => {
      whereSeen.push(args.where);
      return Promise.resolve(lead);
    }),
    findMany: jest.fn((args: { where: unknown }) => {
      whereSeen.push(args.where);
      return Promise.resolve([]);
    }),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'lead-1',
        createdAt: new Date('2026-09-14T09:30:00.000Z'),
        ...args.data,
      }),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'lead-1', ...args.data }),
    ),
    /*
      นับตามเงื่อนไขจริง — harness ต้องแพ้แบบเดียวกับฐานข้อมูล ไม่งั้น test ของ
      การแย่งใบจะผ่านเพราะ mock ใจดี ไม่ใช่เพราะโค้ดถูก.
    */
    updateMany: jest.fn(
      (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) =>
        Promise.resolve({
          count:
            'ownerUserId' in args.where &&
            (lead as { ownerUserId: string | null } | null)?.ownerUserId !==
              null
              ? 0
              : 1,
        }),
    ),
  };

  const members = {
    findMany: jest.fn(() => Promise.resolve([])),
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.member === undefined
          ? { id: 'sales-2', orgUnitId: 'unit-sales-north' }
          : options.member,
      ),
    ),
  };

  const rows = DEFAULT_LEAD_STATUSES.map((row, index) => ({
    ...row,
    id: `status-${index}`,
    companyId: 'osd',
  })) as LeadStatusRow[];

  const statuses = {
    require: jest.fn((_companyId: string, code: string) => {
      const found = rows.find((row) => row.code === code);
      if (!found) throw new Error(`unknown status ${code}`);
      return Promise.resolve(found);
    }),
    defaultCode: jest.fn(() => Promise.resolve('new')),
    closingCode: jest.fn(() => Promise.resolve('converted')),
  };

  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };
  const workflowSync = { kickLead: jest.fn() };

  const service = new LeadsService(
    leads as never,
    { findFirst: jest.fn() } as never,
    { create: jest.fn() } as never,
    audit as never,
    { execute: jest.fn() } as never,
    { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() } as never,
    members as never,
    statuses as never,
    workflowSync as never,
  );

  return {
    service,
    intake: new LeadIntakeService(service),
    leads,
    members,
    audits,
    workflowSync,
    whereSeen,
  };
}

/** body ที่เว็บฟอร์มส่งมาจริง — ไม่มี source_code เพราะกุญแจรู้อยู่แล้ว. */
const inbound = {
  name: 'บจก. ตัวอย่าง เทคโนโลยี',
  contact_name: 'สมชาย ใจดี',
  email: 'somchai@example.co.th',
};

/** กุญแจของช่องทางหนึ่ง — ผูกบริษัท ผูกช่องทาง ถือสิทธิ์เดียว. */
function channelKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    prefix: 'rfk_abcdefgh',
    name: 'เว็บไซต์ osd.co.th',
    companyId: 'osd',
    sourceCode: 'website',
    scopes: ['integration.crm.lead.create'],
    ...overrides,
  } as never;
}

describe('รับ Lead จากระบบภายนอก — POST integrations/crm/leads', () => {
  it('ใบที่ระบบภายนอกยิงเข้ามาไม่มีเจ้าของ — เข้ากองกลางรอคนรับ', async () => {
    const { intake, leads } = harness();

    const result = await intake.receive(inbound, robot(), channelKey());

    expect(leads.create.mock.calls[0][0].data).toMatchObject({
      companyId: 'osd',
      ownerUserId: null,
      ownerOrgUnitId: null,
      sourceCode: 'website',
      createdBy: 'svc-intake',
    });
    expect(result.owner_user_id).toBeNull();
    expect(result).toEqual({
      id: 'lead-1',
      name: 'บจก. ตัวอย่าง เทคโนโลยี',
      status: 'new',
      source_code: 'website',
      owner_user_id: null,
      created_at: '2026-09-14T09:30:00.000Z',
    });
  });

  it('เดินเส้นทางเดียวกับ Lead ที่คนกรอก — ขั้นตั้งต้นจากหน้าตั้งค่า, audit, start workflow', async () => {
    const { intake, audits, workflowSync, leads } = harness();

    await intake.receive(inbound, robot(), channelKey());

    expect(leads.create.mock.calls[0][0].data).toMatchObject({ status: 'new' });
    expect(audits.map((entry) => entry.eventType)).toContain(
      'crm.lead.created',
    );
    expect(audits[0].after).toMatchObject({
      sourceCode: 'website',
      ownerUserId: null,
    });
    expect(workflowSync.kickLead).toHaveBeenCalledWith('lead-1');
  });

  it('ช่องทางมาจากกุญแจ ไม่ใช่จาก body — ผู้เรียกประกาศตัวเองเป็นช่องทางอื่นไม่ได้', async () => {
    const { intake, leads } = harness();

    await intake.receive(
      { ...inbound, source_code: 'line-oa' },
      robot(),
      channelKey({ sourceCode: 'website' }),
    );

    expect(leads.create.mock.calls[0][0].data).toMatchObject({
      sourceCode: 'website',
    });
  });

  it('กุญแจที่ยังไม่ผูกช่องทาง — ใช้ source_code จาก body ได้ (key แบบเดิม)', async () => {
    const { intake, leads } = harness();

    await intake.receive(
      { ...inbound, source_code: 'event-2026-q4' },
      robot(),
      channelKey({ sourceCode: null }),
    );

    expect(leads.create.mock.calls[0][0].data).toMatchObject({
      sourceCode: 'event-2026-q4',
    });
  });

  it('ไม่มีช่องทางทั้งจากกุญแจและ body = ปฏิเสธ ไม่ใช่บันทึกว่า unknown', async () => {
    const { intake, leads } = harness();

    await expect(
      intake.receive(inbound, robot(), channelKey({ sourceCode: null })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(leads.create).not.toHaveBeenCalled();
  });

  it('SCOPE-03: บัญชีบริการต้องบอกบริษัท และใบถูกผูกกับบริษัทนั้น', async () => {
    const { intake, leads } = harness();

    await intake.receive(
      inbound,
      { ...robot(), activeCompanyId: 'osd-demo' },
      channelKey({ companyId: 'osd-demo' }),
    );

    expect(leads.create.mock.calls[0][0].data).toMatchObject({
      companyId: 'osd-demo',
    });
  });
});

describe('กองกลาง — ใครเห็น และรับไปดูแลอย่างไร', () => {
  it('SCOPE-02: คนที่ไม่ได้ถือ crm.sales.read.all ยังเห็นใบที่ไม่มีเจ้าของ', () => {
    const where = visibleSalesWhere({
      userId: 'sales-1',
      activeCompanyId: 'osd',
      ledUnitIds: [],
      scopedUnitIds: [],
      readsAllSales: false,
    }) as { companyId: string; OR: Record<string, unknown>[] };

    expect(where.companyId).toBe('osd');
    expect(where.OR).toContainEqual({ ownerUserId: null });
  });

  it('view=unassigned กรองเหลือเฉพาะใบที่ยังไม่มีคนรับ', async () => {
    const { service, leads } = harness();

    await service.list(sales(), { page: 1, page_size: 20, view: 'unassigned' });

    const where = leads.findMany.mock.calls[0][0].where as {
      AND: Record<string, unknown>[];
    };
    expect(where.AND[1]).toMatchObject({ ownerUserId: null });
  });

  it('กดรับเอง: ไม่ส่ง owner_user_id = ใบตกเป็นของคนที่กด พร้อมหน่วยงานของเขา', async () => {
    const { service, leads, members, audits } = harness();
    members.findFirst.mockResolvedValueOnce({
      id: 'sales-1',
      orgUnitId: 'unit-sales',
    });

    await service.assign('lead-1', {}, sales());

    expect(leads.updateMany.mock.calls[0][0].data).toMatchObject({
      ownerUserId: 'sales-1',
      ownerOrgUnitId: 'unit-sales',
    });
    // กดรับ = เงื่อนไข "ยังไม่มีเจ้าของ" ต้องอยู่ใน statement
    expect(leads.updateMany.mock.calls[0][0].where).toEqual({
      id: 'lead-1',
      ownerUserId: null,
    });
    const assigned = audits.find(
      (entry) => entry.eventType === 'crm.lead.assigned',
    );
    expect(assigned).toMatchObject({
      before: { ownerUserId: null },
      after: { ownerUserId: 'sales-1' },
    });
  });

  it('แจกให้คนอื่น: ownerOrgUnitId ตามหน่วยงานของปลายทาง ไม่ใช่ของคนแจก', async () => {
    const { service, leads } = harness();

    await service.assign('lead-1', { owner_user_id: 'sales-2' }, sales());

    expect(leads.updateMany.mock.calls[0][0].data).toMatchObject({
      ownerUserId: 'sales-2',
      ownerOrgUnitId: 'unit-sales-north',
    });
    // โอนให้คนที่ระบุ = ไม่มีเงื่อนไขแย่งใบ คนแจกเป็นคนตัดสิน
    expect(leads.updateMany.mock.calls[0][0].where).toEqual({ id: 'lead-1' });
  });

  it('ใบที่มีเจ้าของแล้ว กดรับเฉย ๆ ไม่ได้ — ต้องระบุว่าโอนให้ใคร', async () => {
    const { service } = harness({
      lead: {
        id: 'lead-1',
        name: 'บจก. ตัวอย่าง เทคโนโลยี',
        status: 'new',
        ownerUserId: 'sales-9',
        customerId: null,
        taxId: null,
        contactName: null,
        phone: null,
        email: null,
      },
    });

    await expect(service.assign('lead-1', {}, sales())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('แย่งใบกัน: คนที่สองแพ้ที่ฐานข้อมูล ไม่ใช่เขียนทับคนแรก', async () => {
    const { service, leads, audits } = harness();
    // ทั้งคู่อ่านมาแล้วว่าใบนี้ยังว่าง — คนแรกเขียนสำเร็จไปก่อนหน้านี้เสี้ยววินาที
    leads.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.assign('lead-1', {}, sales())).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(audits).toHaveLength(0);
  });

  it('มอบหมายให้คนนอกบริษัทไม่ได้ (SCOPE-03)', async () => {
    const { service } = harness({ member: null });

    await expect(
      service.assign('lead-1', { owner_user_id: 'outsider' }, sales()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('SCOPE-03: Lead นอกขอบเขตของคนเรียก = 404 ไม่ใช่ 403', async () => {
    const { service } = harness({ lead: null });

    await expect(
      service.assign('lead-1', { owner_user_id: 'sales-2' }, sales()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('มอบหมายซ้ำให้คนเดิม = ไม่เขียนอะไรและไม่มี audit เพิ่ม', async () => {
    const { service, leads, audits } = harness({
      lead: {
        id: 'lead-1',
        name: 'บจก. ตัวอย่าง เทคโนโลยี',
        status: 'new',
        ownerUserId: 'sales-2',
        customerId: null,
        taxId: null,
        contactName: null,
        phone: null,
        email: null,
      },
    });

    await service.assign('lead-1', { owner_user_id: 'sales-2' }, sales());

    expect(leads.updateMany).not.toHaveBeenCalled();
    expect(audits).toHaveLength(0);
  });

  it('Lead ที่ปิดแล้วมอบหมายต่อไม่ได้', async () => {
    const { service } = harness({
      lead: {
        id: 'lead-1',
        name: 'บจก. ตัวอย่าง เทคโนโลยี',
        status: 'converted',
        ownerUserId: 'sales-9',
        customerId: null,
        taxId: null,
        contactName: null,
        phone: null,
        email: null,
      },
    });

    await expect(
      service.assign('lead-1', { owner_user_id: 'sales-2' }, sales()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
