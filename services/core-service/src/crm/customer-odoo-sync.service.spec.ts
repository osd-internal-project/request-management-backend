import { CustomerOdooSyncService } from './customer-odoo-sync.service';
import type { OdooClient } from '../odoo/odoo-client';

function harness(options: { odooDown?: boolean } = {}) {
  const externalRows: Record<string, unknown>[] = [];
  const jobs: Record<string, unknown>[] = [];

  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'cust-1',
        companyId: 'osd',
        customerCode: 'CUS-OSD-000001',
        nameTh: 'บริษัท กขค จำกัด',
        taxId: '0107536001079',
        branchCode: '00000',
        branchName: null,
        status: 'active',
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
      externalRows.push({ id: 'ext-1', ...args.data });
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

  const odoo: OdooClient = {
    mode: 'mock',
    createPartner: jest.fn(() =>
      options.odooDown
        ? Promise.reject(new Error('odoo down'))
        : Promise.resolve({ partnerId: 'MOCK-77' }),
    ),
    updatePartner: jest.fn(() => Promise.resolve()),
    getReceivables: jest.fn(() =>
      Promise.resolve({ outstanding: 25000, invoiceCount: 2, asOf: 'now' }),
    ),
  };

  const audit = { record: jest.fn(() => Promise.resolve()) };
  const config = { get: jest.fn(() => 0) };

  const service = new CustomerOdooSyncService(
    customers as never,
    externalCodes as never,
    jobsRepo as never,
    odoo,
    audit as never,
    config as never,
  );

  return { service, externalRows, jobs, externalCodes, odoo, audit };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('CM-06 Odoo sync — สร้างแล้วได้เลขทันที ล่มแล้วเข้าคิว', () => {
  it('CM-06 a create pushes to Odoo and stores the partner id it answers', async () => {
    const { service, externalRows, audit } = harness();

    const partnerId = await service.syncCustomer('cust-1');

    expect(partnerId).toBe('MOCK-77');
    expect(externalRows[0]).toMatchObject({
      system: 'odoo',
      externalCode: 'MOCK-77',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'integration.odoo.customer_synced',
      }),
    );
  });

  it('CM-06 Odoo down → the work becomes ONE queue row, never a user-facing error', async () => {
    const { service, jobs } = harness({ odooDown: true });

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
    const { service, jobs, externalRows } = harness({ odooDown: true });
    service.kickCustomer('cust-1');
    await settle();

    // Odoo comes back up.
    const { service: recovered } = harness();
    // reuse first harness's queue through a fresh service is unwieldy —
    // instead flip the mock back to healthy on the same harness:
    void recovered;
    const odoo = (service as never as { odoo: OdooClient }).odoo;
    (odoo.createPartner as jest.Mock).mockResolvedValue({
      partnerId: 'MOCK-88',
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
