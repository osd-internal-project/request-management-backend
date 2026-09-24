import { Principal } from '@request-management/share';
import { ErpSyncAdminService } from './erp-sync-admin.service';

type Row = Record<string, unknown>;

function principal(companyId = 'osd'): Principal {
  return {
    userId: 'admin-1',
    displayName: 'ผู้ดูแล',
    activeCompanyId: companyId,
    permissions: ['admin.integration.manage'],
  } as unknown as Principal;
}

const at = new Date('2026-09-24T05:00:00Z');

function harness() {
  const jobs: Row[] = [
    {
      id: 'job-cust',
      kind: 'customer_upsert',
      resourceId: 'cust-1',
      status: 'failed',
      attempts: 10,
      lastError: "Invalid 'FederalTaxID' length",
      runAfter: at,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: 'job-so',
      kind: 'sale_order_create',
      resourceId: 'so-1',
      status: 'pending',
      attempts: 2,
      lastError: 'sap down',
      runAfter: at,
      createdAt: at,
      updatedAt: at,
    },
    {
      // ของบริษัทอื่น — ต้องไม่โผล่ และกดส่งใหม่ไม่ได้
      id: 'job-other',
      kind: 'customer_upsert',
      resourceId: 'cust-other',
      status: 'failed',
      attempts: 10,
      lastError: 'x',
      runAfter: at,
      createdAt: at,
      updatedAt: at,
    },
  ];

  const jobsRepo = {
    findMany: jest.fn(() => Promise.resolve(jobs)),
    findFirst: jest.fn((args: { where: { id: string } }) =>
      Promise.resolve(jobs.find((job) => job.id === args.where.id) ?? null),
    ),
    update: jest.fn((args: { where: { id: string }; data: Row }) => {
      const job = jobs.find((row) => row.id === args.where.id);
      Object.assign(job ?? {}, args.data);
      return Promise.resolve(job);
    }),
  };
  // Company filter lives in the query — the fakes honour it.
  const customers = {
    findMany: jest.fn(
      (args: { where: { id: { in: string[] }; companyId: string } }) =>
        Promise.resolve(
          [
            {
              id: 'cust-1',
              companyId: 'osd',
              customerCode: 'CUS-OSD-000001',
              nameTh: 'บริษัท กขค จำกัด',
            },
            {
              id: 'cust-other',
              companyId: 'lex',
              customerCode: 'CUS-LEX-000001',
              nameTh: 'อื่น',
            },
          ].filter(
            (c) =>
              args.where.id.in.includes(c.id) &&
              c.companyId === args.where.companyId,
          ),
        ),
    ),
  };
  const saleOrders = {
    findMany: jest.fn((args: { where: { companyId: string } }) =>
      Promise.resolve(
        args.where.companyId === 'osd'
          ? [
              {
                id: 'so-1',
                saleOrderCode: 'SO-OSD-000001',
                customer: { nameTh: 'บริษัท กขค จำกัด' },
              },
            ]
          : [],
      ),
    ),
    update: jest.fn(() => Promise.resolve({})),
  };
  // The sweep a retry wakes: SAP accepts the customer this time.
  const customerSync = {
    processQueue: jest.fn(() => {
      const job = jobs.find((row) => row.id === 'job-cust');
      Object.assign(job ?? {}, { status: 'succeeded', attempts: 1 });
      return Promise.resolve();
    }),
  };
  const saleOrderSync = { processQueue: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) => work({})),
  };

  const service = new ErpSyncAdminService(
    jobsRepo as never,
    customers as never,
    saleOrders as never,
    customerSync as never,
    saleOrderSync as never,
    audit as never,
    transactions as never,
  );

  return { service, jobsRepo, saleOrders, customerSync, saleOrderSync, audit };
}

describe('CM-06/CD-88 หน้าผู้ดูแลคิวส่ง SAP', () => {
  it('แสดงเฉพาะงานของบริษัทที่ทำงานอยู่ พร้อมรหัส/ชื่อที่คนอ่านได้ และนับสรุป', async () => {
    const { service } = harness();

    const result = await service.list(principal(), 'all');

    expect(result.summary).toEqual({ failed: 1, pending: 1 });
    expect(result.items.map((item) => item.id)).toEqual(['job-cust', 'job-so']);
    expect(result.items[0].resource).toEqual({
      type: 'customer',
      id: 'cust-1',
      code: 'CUS-OSD-000001',
      name: 'บริษัท กขค จำกัด',
    });
    expect(result.items[1].resource).toMatchObject({
      type: 'sale_order',
      code: 'SO-OSD-000001',
    });
  });

  it('ค่าตั้งต้น = เฉพาะที่ส่งไม่สำเร็จ (สิ่งที่ต้องลงมือ) แต่สรุปยังนับทั้งสองสถานะ', async () => {
    const { service } = harness();

    const result = await service.list(principal());

    expect(result.items.map((item) => item.id)).toEqual(['job-cust']);
    expect(result.summary).toEqual({ failed: 1, pending: 1 });
  });

  it('ส่งใหม่ (ลูกค้า): เริ่มนับรอบใหม่ ถึงกำหนดทันที ลง audit แล้วปลุก sweeper ของลูกค้า', async () => {
    const h = harness();

    const item = await h.service.retry('job-cust', principal());

    expect(h.jobsRepo.update).toHaveBeenCalledWith(
      {
        where: { id: 'job-cust' },
        data: expect.objectContaining({
          status: 'pending',
          attempts: 0,
        }) as unknown,
      },
      { prisma: {} },
    );
    expect(h.saleOrders.update).not.toHaveBeenCalled();
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'integration.sap.job_retried',
        companyId: 'osd',
        resourceType: 'customer',
        resourceId: 'cust-1',
      }),
      { prisma: {} },
    );
    expect(h.customerSync.processQueue).toHaveBeenCalled();
    expect(h.saleOrderSync.processQueue).not.toHaveBeenCalled();
    // ตอบผลจริงหลังรอบส่ง — ผู้ดูแลรู้ทันทีว่าผ่าน
    expect(item).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('ส่งใหม่ (ใบสั่งขาย): ใบกลับเป็น pending และปลุก sweeper ของใบสั่งขาย', async () => {
    const h = harness();

    const item = await h.service.retry('job-so', principal());
    // sweep ไม่ได้เปลี่ยนงาน (SAP ยังไม่รับ) → ยังรอส่ง นับรอบใหม่
    expect(item).toMatchObject({ status: 'pending', attempts: 0 });

    expect(h.saleOrders.update).toHaveBeenCalledWith(
      { where: { id: 'so-1' }, data: { erpStatus: 'pending' } },
      { prisma: {} },
    );
    expect(h.saleOrderSync.processQueue).toHaveBeenCalled();
  });

  it('SCOPE-03: งานของบริษัทอื่น = 404 ไม่แตะอะไร', async () => {
    const h = harness();

    await expect(
      h.service.retry('job-other', principal()),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(h.jobsRepo.update).not.toHaveBeenCalled();
  });

  it('งานที่ส่งสำเร็จแล้วกดส่งใหม่ไม่ได้', async () => {
    const h = harness();
    h.jobsRepo.findFirst.mockResolvedValueOnce({
      id: 'job-done',
      kind: 'customer_upsert',
      resourceId: 'cust-1',
      status: 'succeeded',
      attempts: 1,
      lastError: null,
      runAfter: at,
      createdAt: at,
      updatedAt: at,
    });

    await expect(
      h.service.retry('job-done', principal()),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
