import { CustomerErpSyncService } from './customer-erp-sync.service';
import type { ErpClient } from '../erp/erp-client';

function harness(
  options: { erpDown?: boolean; bpInSap?: string; approval?: string } = {},
) {
  const externalRows: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];

  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'cust-1',
        companyId: 'osd',
        company: { code: 'OSD' },
        customerCode: 'CUS-OSD-000001',
        nameTh: 'บริษัท กขค จำกัด',
        taxId: '0107536001079',
        branchCode: '00000',
        branchName: null,
        status: 'active',
        approvalStatus: options.approval ?? 'approved',
        locations: [
          {
            line1: 'เลขที่ 1',
            line2: null,
            district: null,
            province: 'กรุงเทพมหานคร',
            postalCode: '10110',
          },
        ],
        contacts: [{ email: 'a@b.co', phone: '02' }],
      }),
    ),
  };

  const externalCodes = {
    findFirst: jest.fn(() => Promise.resolve(externalRows[0] ?? null)),
    findMany: jest.fn(() => Promise.resolve([])),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      externalRows.push({
        id: 'ext-1',
        customer: { company: { code: 'OSD' } },
        ...args.data,
      });
      return Promise.resolve(externalRows[0]);
    }),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      Object.assign(externalRows[0] ?? {}, args.data);
      return Promise.resolve(externalRows[0]);
    }),
  };

  const jobsRepo = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        (jobs.find((job) => job.status === 'pending') as never) ?? null,
      ),
    ),
    findMany: jest.fn(() =>
      Promise.resolve(jobs.filter((job) => job.status === 'pending')),
    ),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      jobs.push({
        id: `job-${jobs.length + 1}`,
        status: 'pending',
        attempts: 0,
        ...args.data,
      });
      return Promise.resolve(jobs[jobs.length - 1]);
    }),
    update: jest.fn(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = jobs.find((row) => row.id === args.where.id);
        Object.assign(job ?? {}, args.data);
        return Promise.resolve(job);
      },
    ),
  };

  const erp: ErpClient = {
    mode: 'mock',
    findCustomer: jest.fn(() =>
      options.erpDown
        ? Promise.reject(new Error('sap down'))
        : Promise.resolve(
            options.bpInSap ? { externalCode: options.bpInSap } : null,
          ),
    ),
    createCustomer: jest.fn(() =>
      options.erpDown
        ? Promise.reject(new Error('sap down'))
        : Promise.resolve({ externalCode: 'MOCK-77' }),
    ),
    updateCustomer: jest.fn(() => Promise.resolve()),
    getReceivables: jest.fn(() =>
      Promise.resolve({ outstanding: 25000, invoiceCount: 2, asOf: 'now' }),
    ),
    findSalesOrder: jest.fn(() => Promise.resolve(null)),
    createSalesOrder: jest.fn(() => Promise.resolve({ externalCode: 'X' })),
    cancelSalesOrder: jest.fn(() => Promise.resolve()),
    listItems: jest.fn(() => Promise.resolve([])),
    listVendors: jest.fn(() => Promise.resolve([])),
    listVendorCosts: jest.fn(() => Promise.resolve([])),
    listInvoices: jest.fn(() => Promise.resolve([])),
    listProjectCosts: jest.fn(() => Promise.resolve([])),
    findInvoiceDraft: jest.fn(() => Promise.resolve(null)),
    createInvoiceDraft: jest.fn(() => Promise.resolve({ externalCode: '1' })),
    invoiceDraftState: jest.fn(() =>
      Promise.resolve({
        status: 'draft' as const,
        invoiceNo: null,
        total: null,
        paid: null,
      }),
    ),
    cancelInvoiceDraft: jest.fn(() => Promise.resolve()),
    listStock: jest.fn(() => Promise.resolve([])),
    findGoodsIssue: jest.fn(() => Promise.resolve(null)),
    createGoodsIssue: jest.fn(() => Promise.resolve({ externalCode: '1' })),
  };

  const audit = { record: jest.fn(() => Promise.resolve()) };
  const config = { get: jest.fn(() => 0) };

  const service = new CustomerErpSyncService(
    customers as never,
    externalCodes as never,
    jobsRepo as never,
    erp,
    audit as never,
    config as never,
  );

  return { service, externalRows, jobs, externalCodes, erp, audit };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CM-06 SAP sync — สร้างแล้วได้เลขทันที ล่มแล้วเข้าคิว', () => {
  it('CM-06 a create pushes to SAP and stores the BP number it answers', async () => {
    const { service, externalRows, audit } = harness();

    const externalCode = await service.syncCustomer('cust-1');

    expect(externalCode).toBe('MOCK-77');
    expect(externalRows[0]).toMatchObject({
      system: 'sap',
      externalCode: 'MOCK-77',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'integration.sap.customer_synced',
      }),
    );
  });

  it('CD-62 a customer awaiting approval is not sent — no SAP call, nothing queued', async () => {
    const { service, externalRows, jobs, erp } = harness({
      approval: 'pending',
    });

    await expect(service.syncCustomer('cust-1')).resolves.toBeNull();

    const calls = erp as unknown as Record<keyof ErpClient, jest.Mock>;
    expect(calls.createCustomer).not.toHaveBeenCalled();
    expect(externalRows).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it('CM-06 a BP already carrying our customerCode is adopted, not created twice', async () => {
    const { service, externalRows, erp } = harness({ bpInSap: 'BP-0001' });
    const calls = erp as unknown as Record<keyof ErpClient, jest.Mock>;

    const externalCode = await service.syncCustomer('cust-1');

    expect(externalCode).toBe('BP-0001');
    expect(calls.findCustomer).toHaveBeenCalledWith(
      { companyCode: 'OSD' },
      'CUS-OSD-000001',
    );
    expect(calls.createCustomer).not.toHaveBeenCalled();
    expect(calls.updateCustomer).toHaveBeenCalledWith(
      { companyCode: 'OSD' },
      'BP-0001',
      expect.objectContaining({ customerCode: 'CUS-OSD-000001' }),
    );
    expect(externalRows[0]).toMatchObject({
      system: 'sap',
      externalCode: 'BP-0001',
    });
  });

  it('CM-06 SAP down → the work becomes ONE queue row, never a user-facing error', async () => {
    const { service, jobs } = harness({ erpDown: true });

    service.kickCustomer('cust-1');
    await settle();
    service.kickCustomer('cust-1');
    await settle();

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      kind: 'customer_upsert',
      resourceId: 'cust-1',
      status: 'pending',
    });
  });

  it('CM-06 the sweeper retries a queued row and marks it succeeded', async () => {
    const { service, jobs, externalRows } = harness({ erpDown: true });
    service.kickCustomer('cust-1');
    await settle();

    // SAP comes back up.
    const erp = (service as never as { erp: ErpClient }).erp;
    (erp.findCustomer as jest.Mock).mockResolvedValue(null);
    (erp.createCustomer as jest.Mock).mockResolvedValue({
      externalCode: 'MOCK-88',
    });

    await service.processQueue();

    expect(jobs[0]).toMatchObject({ status: 'succeeded' });
    expect(externalRows[0]).toMatchObject({ externalCode: 'MOCK-88' });
  });

  it('C360-02 refreshReceivables caches the figures onto the external-code row', async () => {
    const { service, externalRows } = harness();
    await service.syncCustomer('cust-1');

    await service.refreshReceivables('cust-1');

    const payload = externalRows[0].payload as { receivables?: unknown };
    expect(payload.receivables).toMatchObject({
      outstanding: 25000,
      invoiceCount: 2,
    });
  });
});
