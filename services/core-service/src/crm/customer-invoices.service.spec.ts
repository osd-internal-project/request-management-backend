import type { Principal } from '@request-management/share';
import type { ErpInvoice } from '../erp/erp-client';
import { CustomerInvoicesService } from './customer-invoices.service';

// 2026-09-28 10:00 Bangkok
const NOW = new Date('2026-09-28T03:00:00Z');

function principal(): Principal {
  return {
    userId: 'u-ar',
    username: 'ar',
    displayName: 'ฝ่ายขาย',
    activeCompanyId: 'company-osd',
    permissions: ['crm.customer.read', 'crm.customer.financial.read'],
    ledUnitIds: [],
    scopedUnitIds: [],
    isServiceAccount: false,
  } as unknown as Principal;
}

const invoice = (overrides: Partial<ErpInvoice>): ErpInvoice => ({
  docNo: '1',
  reference: null,
  issuedOn: '2026-09-01',
  dueOn: '2026-10-01',
  currency: 'THB',
  total: 1000,
  paid: 0,
  outstanding: 1000,
  status: 'open',
  ...overrides,
});

function harness(
  options: {
    customer?: unknown;
    link?: unknown;
    mode?: 'mock' | 'sapb1';
    invoices?: ErpInvoice[] | Error;
  } = {},
) {
  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.customer === undefined
          ? { id: 'cus-1', company: { code: 'OSD' } }
          : options.customer,
      ),
    ),
  };
  const externalCodes = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.link === undefined ? { externalCode: 'C0001' } : options.link,
      ),
    ),
  };
  const erp = {
    mode: options.mode ?? 'sapb1',
    listInvoices: jest.fn(() =>
      options.invoices instanceof Error
        ? Promise.reject(options.invoices)
        : Promise.resolve(options.invoices ?? []),
    ),
  };
  const service = new CustomerInvoicesService(
    customers as never,
    externalCodes as never,
    erp as never,
  );
  return { service, customers, erp };
}

describe('CD-89 CustomerInvoicesService', () => {
  it('CD-89: live — each invoice with overdue flag, and the open/overdue totals', async () => {
    const { service, erp } = harness({
      invoices: [
        invoice({ docNo: 'A', dueOn: '2026-10-15', outstanding: 5000 }),
        // due yesterday (Bangkok) → overdue
        invoice({ docNo: 'B', dueOn: '2026-09-27', outstanding: 3000.5 }),
        // due today → not yet overdue
        invoice({ docNo: 'C', dueOn: '2026-09-28', outstanding: 1000 }),
        invoice({
          docNo: 'D',
          status: 'paid',
          dueOn: '2026-08-01',
          outstanding: 0,
        }),
        invoice({ docNo: 'E', status: 'cancelled', dueOn: '2026-07-01' }),
      ],
    });

    const result = await service.list('cus-1', principal(), NOW);

    expect(erp.listInvoices).toHaveBeenCalledWith(
      { companyCode: 'OSD' },
      'C0001',
      50,
    );
    expect(result.source).toBe('live');
    expect(result.as_of).toBe(NOW.toISOString());
    expect(result.invoices.map((row) => [row.doc_no, row.overdue])).toEqual([
      ['A', false],
      ['B', true],
      ['C', false],
      ['D', false],
      ['E', false],
    ]);
    expect(result.summary).toEqual({
      open_count: 3,
      outstanding: 9000.5,
      overdue_count: 1,
      overdue_amount: 3000.5,
    });
  });

  it('C360-02 degrade: SAP not answering is a state, not a 500', async () => {
    const { service } = harness({ invoices: new Error('ECONNREFUSED') });
    await expect(service.list('cus-1', principal(), NOW)).resolves.toEqual({
      source: 'unavailable',
      as_of: null,
      summary: null,
      invoices: [],
    });
  });

  it('C360-02: mock mode never shows invented numbers as if real', async () => {
    const { service, erp } = harness({ mode: 'mock' });
    const result = await service.list('cus-1', principal(), NOW);
    expect(result).toMatchObject({ source: 'mock', invoices: [] });
    expect(erp.listInvoices).not.toHaveBeenCalled();
  });

  it('CD-89: a customer not yet pushed to SAP says so', async () => {
    const { service, erp } = harness({ link: null });
    const result = await service.list('cus-1', principal(), NOW);
    expect(result.source).toBe('not_synced');
    expect(erp.listInvoices).not.toHaveBeenCalled();
  });

  it('SCOPE-03: a customer outside the caller’s reach is 404, and SAP is never asked', async () => {
    const { service, erp, customers } = harness({ customer: null });
    await expect(service.list('cus-x', principal(), NOW)).rejects.toThrow(
      'ไม่พบลูกค้าที่ระบุ',
    );
    expect(erp.listInvoices).not.toHaveBeenCalled();
    const where = (
      customers.findFirst.mock.calls[0] as unknown as [
        { where: { AND: Record<string, unknown>[] } },
      ]
    )[0].where;
    expect(where.AND[0]).toMatchObject({ companyId: 'company-osd' });
  });
});

describe('CD-89 MockSapClient.listInvoices', () => {
  it('open invoices add up to the mock receivables, so the tab and the card agree', async () => {
    const { MockSapClient } = jest.requireActual<
      typeof import('../erp/mock-sap.client')
    >('../erp/mock-sap.client');
    const client = new MockSapClient();
    for (const code of ['C0001', 'CUS-OSD-000123', 'X']) {
      const [invoices, receivables] = await Promise.all([
        client.listInvoices({ companyCode: 'OSD' }, code, 50),
        client.getReceivables({ companyCode: 'OSD' }, code),
      ]);
      const open = invoices.filter((row) => row.status === 'open');
      expect(open).toHaveLength(receivables.invoiceCount);
      expect(open.reduce((sum, row) => sum + row.outstanding, 0)).toBe(
        receivables.outstanding,
      );
    }
  });
});
