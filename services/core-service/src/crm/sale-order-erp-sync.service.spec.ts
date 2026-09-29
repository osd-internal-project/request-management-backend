import { SaleOrderErpSyncService } from './sale-order-erp-sync.service';
import type { ErpClient } from '../erp/erp-client';

type Row = Record<string, unknown>;

function harness(
  options: {
    bp?: string | null;
    erpDown?: boolean;
    alreadyInSap?: string;
    order?: Row;
    stalePending?: Row[];
  } = {},
) {
  const order: Row = {
    id: 'so-1',
    companyId: 'osd',
    saleOrderCode: 'SO-OSD-000001',
    status: 'open',
    currency: 'THB',
    orderedAt: new Date('2026-09-24T03:00:00Z'),
    cancelReason: null,
    customerId: 'cust-1',
    erpOrderNo: null,
    erpStatus: 'pending',
    customer: { customerCode: 'CUS-OSD-000001', approvalStatus: 'approved' },
    company: { code: 'OSD' },
    lines: [
      {
        lineNo: 1,
        productCode: 'SIP-TRUNK',
        description: 'SIP Trunk 30 ช่อง',
        quantity: 2,
        unit: 'ชุด',
        unitPrice: 50000,
        discountPct: 5,
        lineTotal: 95000,
      },
      {
        lineNo: 2,
        productCode: null,
        description: 'ค่าติดตั้ง',
        quantity: 1,
        unit: null,
        unitPrice: 5000.5,
        discountPct: 0,
        lineTotal: 5000.5,
      },
    ],
    ...options.order,
  };
  const jobs: Row[] = [];

  const saleOrders = {
    findFirst: jest.fn(() => Promise.resolve({ ...order })),
    findMany: jest.fn(() => Promise.resolve(options.stalePending ?? [])),
    update: jest.fn((args: { data: Row }) => {
      Object.assign(order, args.data);
      return Promise.resolve(order);
    }),
  };
  const externalCodes = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.bp === null ? null : { externalCode: options.bp ?? 'BP-1' },
      ),
    ),
  };
  const jobsRepo = {
    findFirst: jest.fn((args: { where: Row }) =>
      Promise.resolve(
        jobs.find(
          (job) =>
            job.status === 'pending' &&
            job.kind === args.where.kind &&
            job.resourceId === args.where.resourceId,
        ) ?? null,
      ),
    ),
    findMany: jest.fn(() =>
      Promise.resolve(jobs.filter((job) => job.status === 'pending')),
    ),
    create: jest.fn((args: { data: Row }) => {
      jobs.push({
        id: `job-${jobs.length + 1}`,
        status: 'pending',
        attempts: 0,
        ...args.data,
      });
      return Promise.resolve(jobs[jobs.length - 1]);
    }),
    update: jest.fn((args: { where: { id: string }; data: Row }) => {
      const job = jobs.find((row) => row.id === args.where.id);
      Object.assign(job ?? {}, args.data);
      return Promise.resolve(job);
    }),
  };
  const erp: ErpClient = {
    mode: 'mock',
    findCustomer: jest.fn(() => Promise.resolve(null)),
    createCustomer: jest.fn(() => Promise.resolve({ externalCode: 'BP-1' })),
    updateCustomer: jest.fn(() => Promise.resolve()),
    getReceivables: jest.fn(() =>
      Promise.resolve({ outstanding: 0, invoiceCount: 0, asOf: 'now' }),
    ),
    findSalesOrder: jest.fn(() =>
      Promise.resolve(
        options.alreadyInSap ? { externalCode: options.alreadyInSap } : null,
      ),
    ),
    createSalesOrder: jest.fn(() =>
      options.erpDown
        ? Promise.reject(new Error('sap down'))
        : Promise.resolve({ externalCode: 'MOCK-SO-1' }),
    ),
    cancelSalesOrder: jest.fn(() => Promise.resolve()),
    listItems: jest.fn(() => Promise.resolve([])),
    listInvoices: jest.fn(() => Promise.resolve([])),
  };
  const calls = erp as unknown as Record<keyof ErpClient, jest.Mock>;
  const customerSync = { queueCustomer: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const config = { get: jest.fn(() => 0) };

  const service = new SaleOrderErpSyncService(
    saleOrders as never,
    externalCodes as never,
    jobsRepo as never,
    erp,
    customerSync as never,
    audit as never,
    config as never,
  );

  return { service, order, jobs, calls, customerSync, audit, saleOrders };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CD-88 ใบสั่งขายเข้า SAP — เก็บที่ CTD ก่อน แล้วค่อยส่ง', () => {
  it('ส่งรายการสินค้า + เลข BP ของลูกค้า แล้วเก็บเลขใบสั่งขายที่ SAP ตอบ', async () => {
    const { service, order, calls, audit } = harness();

    const erpOrderNo = await service.pushOrder('so-1');

    expect(erpOrderNo).toBe('MOCK-SO-1');
    expect(calls.createSalesOrder).toHaveBeenCalledWith(
      { companyCode: 'OSD' },
      expect.objectContaining({
        saleOrderCode: 'SO-OSD-000001',
        customerExternalCode: 'BP-1',
        netTotal: 100000.5,
        lines: [
          expect.objectContaining({
            lineNo: 1,
            productCode: 'SIP-TRUNK',
            quantity: 2,
            lineTotal: 95000,
          }),
          expect.objectContaining({ lineNo: 2, productCode: null }),
        ],
      }),
    );
    expect(order).toMatchObject({
      erpStatus: 'synced',
      erpOrderNo: 'MOCK-SO-1',
      erpLastError: null,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'integration.sap.sale_order_synced',
      }),
    );
  });

  it('ใบที่มีอยู่ใน SAP แล้ว (retry หลัง timeout) → ใช้ใบเดิม ไม่สร้างซ้ำ', async () => {
    const { service, order, calls } = harness({ alreadyInSap: 'SAP-SO-9' });

    await service.pushOrder('so-1');

    expect(calls.createSalesOrder).not.toHaveBeenCalled();
    expect(order).toMatchObject({
      erpStatus: 'synced',
      erpOrderNo: 'SAP-SO-9',
    });
  });

  it('ลูกค้ายังไม่มีเลข BP → ขอคิวส่งลูกค้า แล้วใบนี้รอในคิว (ไม่เรียก SAP)', async () => {
    const { service, order, jobs, calls, customerSync } = harness({
      bp: null,
    });

    service.kickCreate('so-1');
    await settle();

    expect(customerSync.queueCustomer).toHaveBeenCalledWith(
      'cust-1',
      expect.stringContaining('SO-OSD-000001'),
    );
    expect(calls.createSalesOrder).not.toHaveBeenCalled();
    expect(jobs).toEqual([
      expect.objectContaining({
        kind: 'sale_order_create',
        resourceId: 'so-1',
        status: 'pending',
      }),
    ]);
    expect(order).toMatchObject({
      erpStatus: 'pending',
      erpLastError: expect.stringContaining('BP') as unknown,
    });
  });

  it('SAP ล่ม → เข้าคิวแถวเดียว; SAP กลับมา → sweeper ส่งสำเร็จ', async () => {
    const h = harness({ erpDown: true });

    h.service.kickCreate('so-1');
    await settle();
    h.service.kickCreate('so-1');
    await settle();
    expect(h.jobs).toHaveLength(1);

    h.calls.createSalesOrder.mockResolvedValue({ externalCode: 'MOCK-SO-2' });
    await h.service.processQueue();

    expect(h.jobs[0]).toMatchObject({ status: 'succeeded' });
    expect(h.order).toMatchObject({
      erpStatus: 'synced',
      erpOrderNo: 'MOCK-SO-2',
    });
  });

  it('ลองครบรอบแล้วยังไม่ได้ → failed พร้อมข้อผิดพลาดล่าสุดบนใบ', async () => {
    const h = harness({ erpDown: true });
    h.service.kickCreate('so-1');
    await settle();
    h.jobs[0].attempts = 9;

    await h.service.processQueue();

    expect(h.jobs[0]).toMatchObject({ status: 'failed' });
    expect(h.order).toMatchObject({
      erpStatus: 'failed',
      erpLastError: 'sap down',
    });
  });

  it('ไม่มีรายการสินค้า → not_ready ไม่ใช่ error ที่ต้อง retry', async () => {
    const { service, order, calls } = harness({ order: { lines: [] } });

    await expect(service.pushOrder('so-1')).resolves.toBeNull();

    expect(calls.createSalesOrder).not.toHaveBeenCalled();
    expect(order).toMatchObject({ erpStatus: 'not_ready' });
  });

  it('CD-62: ลูกค้าใหม่ยังไม่อนุมัติ → not_ready พร้อมเหตุผล ไม่เรียก SAP ไม่เข้าคิว', async () => {
    const { service, order, calls } = harness({
      order: {
        customer: { customerCode: 'CUS-OSD-000001', approvalStatus: 'pending' },
      },
    });

    await expect(service.pushOrder('so-1')).resolves.toBeNull();

    expect(calls.createSalesOrder).not.toHaveBeenCalled();
    expect(order).toMatchObject({
      erpStatus: 'not_ready',
      erpLastError: 'รออนุมัติเปิดลูกค้า CUS-OSD-000001 ก่อนส่งเข้า SAP',
    });
  });

  it('ถูกยกเลิกก่อนถึง SAP → งานสร้างในคิวข้ามไป (skipped)', async () => {
    const { service, order, calls } = harness({
      order: { status: 'cancelled' },
    });

    await service.pushOrder('so-1');

    expect(calls.createSalesOrder).not.toHaveBeenCalled();
    expect(order).toMatchObject({ erpStatus: 'skipped' });
  });

  it('ยกเลิกใบที่อยู่ใน SAP แล้ว → ยกเลิกใน SAP พร้อมเหตุผล', async () => {
    const { service, order, calls } = harness({
      order: {
        status: 'cancelled',
        cancelReason: 'ลูกค้ายกเลิก',
        erpOrderNo: 'MOCK-SO-1',
      },
    });

    await service.cancelOrder('so-1');

    expect(calls.cancelSalesOrder).toHaveBeenCalledWith(
      { companyCode: 'OSD' },
      { externalCode: 'MOCK-SO-1', saleOrderCode: 'SO-OSD-000001' },
      'ลูกค้ายกเลิก',
    );
    expect(order).toMatchObject({ erpStatus: 'synced', erpLastError: null });
  });

  it('reconcile: ใบที่ค้าง pending เกิน 5 นาทีโดยไม่มีงานในคิว → ได้งานคืน (สร้าง/ยกเลิกตามสถานะ)', async () => {
    const h = harness({
      stalePending: [
        { id: 'so-lost', status: 'open', erpOrderNo: null },
        { id: 'so-cancel', status: 'cancelled', erpOrderNo: 'MOCK-SO-7' },
      ],
    });

    await h.service.reconcile();
    await h.service.reconcile();

    const where = (h.saleOrders.findMany.mock.calls[0] as unknown[])[0] as {
      where: { erpStatus: string; updatedAt: { lt: Date } };
    };
    expect(where.where.erpStatus).toBe('pending');
    expect(
      Date.now() - where.where.updatedAt.lt.getTime(),
    ).toBeGreaterThanOrEqual(5 * 60_000);
    // ซ้ำสองรอบก็ยังงานละแถว — enqueue กันซ้ำ
    expect(h.jobs.map((job) => [job.kind, job.resourceId])).toEqual([
      ['sale_order_create', 'so-lost'],
      ['sale_order_cancel', 'so-cancel'],
    ]);
  });
});
