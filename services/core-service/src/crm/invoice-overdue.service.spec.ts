import { NotificationRulesService } from '../notifications/notification-rules.service';
import { InvoiceOverdueService } from './invoice-overdue.service';
import type { ErpInvoice } from '../erp/erp-client';

const NOW = new Date('2026-09-29T03:00:00Z'); // 29 Sep 2026, Bangkok

const invoice = (overrides: Partial<ErpInvoice> = {}): ErpInvoice => ({
  docNo: '10234',
  reference: null,
  issuedOn: '2026-08-01',
  dueOn: '2026-08-30', // 30 days before NOW
  currency: 'THB',
  total: 12500,
  paid: 0,
  outstanding: 12500,
  status: 'open',
  ...overrides,
});

const linked = (companyId = 'osd') => ({
  customerId: 'cus-1',
  externalCode: 'C00042',
  customer: {
    id: 'cus-1',
    companyId,
    customerCode: 'CUS-OSD-000042',
    nameTh: 'บริษัท ตัวอย่าง จำกัด',
    accountOwnerUserId: 'owner-1',
    company: { code: 'OSD' },
  },
});

function harness(options: {
  mode?: 'mock' | 'sapb1';
  invoices?: ErpInvoice[] | Error;
  done?: number[];
  claimed?: number;
  rules?: { companyId: string; enabled: boolean; params: unknown }[];
}) {
  const externalCodes = {
    findMany: jest.fn(() => Promise.resolve([linked()])),
  };
  const alerts = {
    findMany: jest.fn(() =>
      Promise.resolve((options.done ?? []).map((step) => ({ step }))),
    ),
    createMany: jest.fn((args: { data: unknown[] }) =>
      Promise.resolve({ count: options.claimed ?? args.data.length }),
    ),
  };
  const erp = {
    mode: options.mode ?? 'sapb1',
    listInvoices: jest.fn(() =>
      options.invoices instanceof Error
        ? Promise.reject(options.invoices)
        : Promise.resolve(options.invoices ?? [invoice()]),
    ),
  };
  const notices: { userId: string; days: number; docNo: string }[] = [];
  const notifications = {
    invoiceOverdue: jest.fn(
      (
        userId: string,
        _company: string,
        _customer: unknown,
        inv: { docNo: string },
        days: number,
      ) => {
        notices.push({ userId, days, docNo: inv.docNo });
        return Promise.resolve();
      },
    ),
  };
  const rules = new NotificationRulesService({
    notificationRule: {
      findMany: jest.fn(() => Promise.resolve(options.rules ?? [])),
    },
  } as never);
  const service = new InvoiceOverdueService(
    externalCodes as never,
    alerts as never,
    erp as never,
    rules,
    notifications as never,
    { get: jest.fn(() => 0) } as never,
  );
  return { service, externalCodes, alerts, erp, notices };
}

describe('CD-53 overdue invoices', () => {
  it('CD-53: an open invoice past a step tells the owner once, for the furthest step crossed', async () => {
    const h = harness({});
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ alerted: 1 });
    expect(h.notices).toEqual([
      { userId: 'owner-1', days: 30, docNo: '10234' },
    ]);
    // both standard steps (1 and 30) are recorded, only one notice
    const rows = (
      h.alerts.createMany.mock.calls[0] as unknown as [
        { data: { step: number }[]; skipDuplicates: boolean },
      ]
    )[0];
    expect(rows.data.map((row) => row.step)).toEqual([30, 1]);
    expect(rows.skipDuplicates).toBe(true);
  });

  it('a step already sent is not sent again; the next one is', async () => {
    const again = harness({ done: [30, 1] });
    await expect(again.service.sweep(NOW)).resolves.toMatchObject({
      alerted: 0,
    });
    expect(again.alerts.createMany).not.toHaveBeenCalled();

    const later = harness({
      done: [1],
      invoices: [invoice({ dueOn: '2026-09-28' })], // 1 day over
    });
    await expect(later.service.sweep(NOW)).resolves.toMatchObject({
      alerted: 0,
    });
  });

  it('paid, cancelled, not yet due or with no balance → nothing', async () => {
    const h = harness({
      invoices: [
        invoice({ status: 'paid' }),
        invoice({ status: 'cancelled' }),
        invoice({ dueOn: '2026-09-29' }),
        invoice({ dueOn: null }),
        invoice({ outstanding: 0 }),
      ],
    });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ alerted: 0 });
    expect(h.notices).toEqual([]);
  });

  it('an overlapping pass that claimed first wins — no second notice', async () => {
    const h = harness({ claimed: 1 });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ alerted: 0 });
  });

  it('CD-53: mock mode never reminds about invented invoices', async () => {
    const h = harness({ mode: 'mock' });
    await expect(h.service.sweep(NOW)).resolves.toEqual({
      customers: 0,
      alerted: 0,
      skipped: 0,
    });
    expect(h.erp.listInvoices).not.toHaveBeenCalled();
  });

  it('SAP not answering for a customer skips it, the pass goes on', async () => {
    const h = harness({ invoices: new Error('timeout') });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({
      alerted: 0,
      skipped: 1,
    });
  });

  it('CD-53: the steps and on/off are the company rule', async () => {
    const own = harness({
      rules: [
        { companyId: 'osd', enabled: true, params: { overdue_days: [45] } },
      ],
    });
    await expect(own.service.sweep(NOW)).resolves.toMatchObject({ alerted: 0 });

    const off = harness({
      rules: [
        { companyId: 'osd', enabled: false, params: { overdue_days: [1] } },
      ],
    });
    await off.service.sweep(NOW);
    const where = (
      off.externalCodes.findMany.mock.calls[0] as unknown as [
        { where: { customer: { companyId: unknown } } },
      ]
    )[0].where;
    expect(where.customer.companyId).toEqual({ notIn: ['osd'] });
  });
});
