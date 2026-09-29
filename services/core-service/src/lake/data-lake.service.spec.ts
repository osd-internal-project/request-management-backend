import type { Principal } from '@request-management/share';
import { DataLakeService, PAGE_SIZE } from './data-lake.service';
import { assertSources, LAKE_SOURCES, LAKE_TABLES } from './lake-sources';
import { EPOCH, type LakeRow } from './lake.repository';

const admin = {
  userId: 'admin-1',
  activeCompanyId: 'osd',
} as unknown as Principal;

describe('CD-90 what flows into the lake', () => {
  it('Platform Request, CRM, Sales and their reference data are all sources; SAP invoices too', () => {
    const modules = new Set(LAKE_SOURCES.map((source) => source.module));
    expect([...modules].sort()).toEqual([
      'crm',
      'reference',
      'request',
      'sales',
    ]);
    for (const name of [
      'requests',
      'customers',
      'opportunities',
      'sale_orders',
      'quotations',
    ]) {
      expect(LAKE_TABLES).toContain(name);
    }
    expect(LAKE_TABLES).toContain('sap_invoices');
    expect(() => assertSources(LAKE_SOURCES)).not.toThrow();
  });

  it('SCOPE-04 / PDPA: form contents, cost and margin, tax ids and contact details never leave', () => {
    const excluded = (name: string) =>
      LAKE_SOURCES.find((source) => source.name === name)?.exclude ?? [];
    expect(excluded('requests')).toEqual(
      expect.arrayContaining(['formData', 'receiverFormData', 'stepFormData']),
    );
    expect(excluded('quotations')).toEqual(
      expect.arrayContaining([
        'costTotal',
        'marginAmount',
        'marginPct',
        'partyTaxId',
      ]),
    );
    expect(excluded('quotation_lines')).toEqual(
      expect.arrayContaining(['unitCost', 'lineCost']),
    );
    expect(excluded('customers')).toContain('taxId');
    expect(excluded('leads')).toEqual(
      expect.arrayContaining(['phone', 'email', 'contactName', 'taxId']),
    );
    expect(excluded('opportunities')).toEqual(
      expect.arrayContaining([
        'prospectTaxId',
        'prospectPhone',
        'prospectEmail',
      ]),
    );
    expect(excluded('users')).toEqual(
      expect.arrayContaining(['email', 'phone']),
    );
    // nothing but personal data — not a source at all
    expect(LAKE_TABLES).not.toContain('customer_contacts');
  });

  it('a bad definition fails at boot, not as data', () => {
    expect(() =>
      assertSources([
        {
          name: 'ok',
          module: 'crm',
          from: 'x t',
          watermark: 't.a',
          exclude: ['a; drop'],
        },
      ]),
    ).toThrow('not a column name');
    expect(() =>
      assertSources([
        {
          name: 'dup',
          module: 'crm',
          from: 'x t',
          watermark: 't.a',
          exclude: [],
        },
        {
          name: 'dup',
          module: 'crm',
          from: 'x t',
          watermark: 't.a',
          exclude: [],
        },
      ]),
    ).toThrow('declared twice');
  });
});

describe('CD-90 DataLakeService', () => {
  function harness(
    options: {
      configured?: boolean;
      pages?: Record<string, LakeRow[][]>;
      failing?: string;
      mode?: 'mock' | 'sapb1';
    } = {},
  ) {
    const appended: { name: string; rows: number; cursor: unknown }[] = [];
    const errors: string[] = [];
    const audits: string[] = [];
    const served: Record<string, number> = {};
    const lake = {
      configured: options.configured ?? true,
      ensureSchema: jest.fn(() => Promise.resolve()),
      states: jest.fn(() =>
        Promise.resolve([
          {
            source: 'customers',
            watermark: '2026-09-01T00:00:00.000000',
            last_id: 'cus-9',
            last_run_at: null,
            last_rows: 0,
            total_rows: '5',
            last_error: null,
          },
        ]),
      ),
      changedRows: jest.fn(
        (
          source: { name: string },
          after: { watermark: string; lastId: string },
        ) => {
          if (source.name === options.failing) {
            return Promise.reject(new Error('column does not exist'));
          }
          const pages = options.pages?.[source.name] ?? [];
          const index = served[source.name] ?? 0;
          served[source.name] = index + 1;
          void after;
          return Promise.resolve(pages[index] ?? []);
        },
      ),
      appendPage: jest.fn((name: string, rows: LakeRow[], cursor: unknown) => {
        appended.push({ name, rows: rows.length, cursor });
        return Promise.resolve(rows.length);
      }),
      recordError: jest.fn((name: string) => {
        errors.push(name);
        return Promise.resolve();
      }),
      sapCustomers: jest.fn(() =>
        Promise.resolve([
          {
            customerId: 'cus-1',
            customerCode: 'CUS-1',
            companyCode: 'OSD',
            externalCode: 'BP-1',
          },
          {
            customerId: 'cus-2',
            customerCode: 'CUS-2',
            companyCode: 'OSD',
            externalCode: 'BP-2',
          },
        ]),
      ),
    };
    const erp = {
      mode: options.mode ?? 'sapb1',
      listInvoices: jest.fn((_ctx: unknown, bp: string) =>
        bp === 'BP-2'
          ? Promise.reject(new Error('SAP down'))
          : Promise.resolve([
              { docNo: 'INV-1', outstanding: 100, status: 'open' },
              { docNo: 'INV-2', outstanding: 0, status: 'paid' },
            ]),
      ),
    };
    const service = new DataLakeService(
      lake as never,
      erp as never,
      { get: jest.fn(() => 0) } as never,
      {
        record: jest.fn((event: { eventType: string }) => {
          audits.push(event.eventType);
          return Promise.resolve();
        }),
      } as never,
    );
    return { service, lake, appended, errors, audits };
  }

  const row = (id: string, ts: string): LakeRow => ({ id, ts, data: { id } });

  it('CD-90: changed rows go in and the cursor moves to the last one', async () => {
    const h = harness({
      pages: { customers: [[row('cus-10', '2026-09-02T00:00:00.000000')]] },
    });
    const results = await h.service.extract();

    expect(h.lake.changedRows).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'customers' }),
      { watermark: '2026-09-01T00:00:00.000000', lastId: 'cus-9' },
      PAGE_SIZE,
    );
    expect(h.appended.find((a) => a.name === 'customers')).toEqual({
      name: 'customers',
      rows: 1,
      cursor: { watermark: '2026-09-02T00:00:00.000000', lastId: 'cus-10' },
    });
    // a table never read starts at the beginning
    expect(h.lake.changedRows).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'requests' }),
      { watermark: EPOCH, lastId: '' },
      PAGE_SIZE,
    );
    expect(results?.find((r) => r.source === 'customers')?.rows).toBe(1);
  });

  it('a full page asks for the next one; a short page ends the source', async () => {
    const full = Array.from({ length: PAGE_SIZE }, (_, i) =>
      row(`r-${String(i).padStart(5, '0')}`, '2026-09-02T00:00:00.000000'),
    );
    const h = harness({
      pages: { requests: [full, [row('r-z', '2026-09-03T00:00:00.000000')]] },
    });
    await h.service.extract();
    const pages = h.appended.filter((a) => a.name === 'requests');
    expect(pages.map((p) => p.rows)).toEqual([PAGE_SIZE, 1]);
  });

  it('one failing source keeps its cursor and is reported; the others still run', async () => {
    const h = harness({
      failing: 'quotations',
      pages: { sale_orders: [[row('so-1', '2026-09-02T00:00:00.000000')]] },
    });
    const results = await h.service.extract();
    expect(h.errors).toEqual(['quotations']);
    expect(h.appended.some((a) => a.name === 'quotations')).toBe(false);
    expect(results?.find((r) => r.source === 'sale_orders')?.rows).toBe(1);
    expect(results?.find((r) => r.source === 'quotations')?.error).toContain(
      'column does not exist',
    );
  });

  it('CD-90: SAP invoices daily, one version per invoice per Bangkok day; one customer down is counted, not fatal', async () => {
    const h = harness({});
    const result = await h.service.extractSap(new Date('2026-09-29T20:00:00Z'));
    const call = (
      h.lake.appendPage.mock.calls[0] as unknown as [string, LakeRow[]]
    )[1];
    expect(call.map((r) => r.id)).toEqual(['OSD:BP-1:INV-1', 'OSD:BP-1:INV-2']);
    // 20:00 UTC on the 29th is already the 30th in Bangkok
    expect(call[0].ts).toBe('2026-09-30T00:00:00.000000');
    expect(result).toMatchObject({ rows: 2 });
    expect(result.error).toContain('1 ราย');
    expect(h.errors).toEqual(['sap_invoices']);
  });

  it('never from the mock ERP — invented invoices must not become history', async () => {
    const h = harness({ mode: 'mock' });
    const result = await h.service.extractSap();
    expect(result.rows).toBe(0);
    expect(h.lake.appendPage).not.toHaveBeenCalled();
  });

  it('no LAKE_DATABASE_URL: nothing scheduled, status says so, run-now is refused', async () => {
    const h = harness({ configured: false });
    h.service.onModuleInit();
    await expect(h.service.status()).resolves.toEqual({
      configured: false,
      tables: [],
    });
    await expect(h.service.runNow(admin)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(h.lake.ensureSchema).not.toHaveBeenCalled();
  });

  it('run-now is audited and answers the fresh status', async () => {
    const h = harness({});
    const status = await h.service.runNow(admin);
    expect(h.audits).toEqual(['bi.lake.extracted']);
    expect(status.configured).toBe(true);
    expect(status.tables.map((t) => t.table_name)).toEqual([...LAKE_TABLES]);
  });
});
