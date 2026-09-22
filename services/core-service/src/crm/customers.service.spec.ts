import type { Principal } from '@request-management/share';
import { CustomersService } from './customers.service';
import type {
  DuplicateCheckResult,
  SimilarCustomer,
} from './customer-dedup.service';

const OSD = 'company-osd';
const ME = 'user-me';

// 1234567890121 passes the 13-digit checksum; …0 does not (see customer-name.spec).
const VALID_TAX_ID = '1234567890121';

function principal(permissions: string[] = ['crm.customer.manage']): Principal {
  return {
    userId: ME,
    activeCompanyId: OSD,
    username: 'me',
    displayName: 'ทดสอบ ระบบ',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
    isServiceAccount: false,
  } as unknown as Principal;
}

function similar(overrides: Partial<SimilarCustomer> = {}): SimilarCustomer {
  return {
    id: 'cust-similar',
    customerCode: 'CUS-OSD-000009',
    nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด',
    nameEn: null,
    taxId: null,
    branchCode: '00000',
    branchName: null,
    status: 'active',
    similarity: 0.93,
    ...overrides,
  };
}

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cust-1',
    customerCode: 'CUS-OSD-000001',
    companyId: OSD,
    type: 'corporate',
    nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด',
    nameEn: null,
    taxId: VALID_TAX_ID,
    branchCode: '00000',
    branchName: null,
    headOfficeId: null,
    status: 'active',
    kycVerified: false,
    accountOwnerUserId: ME,
    ownerOrgUnitId: 'unit-sales',
    mergedIntoCustomerId: null,
    segments: [],
    contacts: [],
    ...overrides,
  };
}

interface Harness {
  service: CustomersService;
  audits: { eventType: string; after?: unknown }[];
  timelineEvents: { eventType: string }[];
  fieldChangeRows: { field: string; before: unknown; after: unknown }[];
  customers: {
    create: jest.Mock;
    update: jest.Mock;
    findDetail: jest.Mock;
  };
  requestCount: jest.Mock;
  /** C360-04 — the ยอดค้างชำระ cache read, asserted *not* to run without permission. */
  odooLookup: jest.Mock;
  /** C360-04 — the โอกาสการขาย count, same. */
  opportunityCount: jest.Mock;
  odooKicks: string[];
}

function harness(options: {
  checkResult?: DuplicateCheckResult;
  pdpaDown?: boolean;
  detail?: Record<string, unknown> | null;
  /** ODOO_MODE=http (true) หรือ mock (ค่าตั้งต้น). */
  odooLive?: boolean;
  /** payload ใน customer_external_codes ที่รอบ sync เติมไว้. */
  odooPayload?: Record<string, unknown>;
}): Harness {
  const audits: Harness['audits'] = [];
  const timelineEvents: Harness['timelineEvents'] = [];
  const fieldChangeRows: Harness['fieldChangeRows'] = [];

  const customers = {
    create: jest.fn(() => Promise.resolve(customerRow())),
    update: jest.fn(() => Promise.resolve(customerRow())),
    findDetail: jest.fn(() =>
      Promise.resolve(
        options.detail === undefined ? customerRow() : options.detail,
      ),
    ),
    search: jest.fn(() => Promise.resolve([])),
    countWhere: jest.fn(() => Promise.resolve(0)),
  };

  const requestCount = jest.fn(() => Promise.resolve(0));
  const odooLookup = jest.fn(() =>
    Promise.resolve(
      options.odooPayload ? { payload: options.odooPayload } : null,
    ),
  );
  const opportunityCount = jest.fn(() => Promise.resolve(0));
  const odooKicks: string[] = [];

  const service = new CustomersService(
    customers as never,
    {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(() => Promise.resolve(2)),
    } as never,
    {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      count: jest.fn(() => Promise.resolve(3)),
    } as never,
    {
      findMany: jest.fn(() => Promise.resolve([])),
      findFirst: odooLookup,
      upsert: jest.fn(),
    } as never,
    {
      createMany: jest.fn((rows: Harness['fieldChangeRows']) => {
        fieldChangeRows.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
      findMany: jest.fn(() => Promise.resolve([])),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    {
      findMany: jest.fn(() => Promise.resolve([])),
      createMany: jest.fn(),
    } as never,
    { findFirst: jest.fn(() => Promise.resolve(null)) } as never,
    { count: requestCount } as never,
    { issueUnused: jest.fn(() => Promise.resolve('CUS-OSD-000001')) } as never,
    {
      headOfficeOf: jest.fn(() => Promise.resolve(null)),
      check: jest.fn(() =>
        Promise.resolve(
          options.checkResult ?? {
            duplicate: null,
            headOffice: null,
            similar: [],
            threshold: 0.85,
          },
        ),
      ),
    } as never,
    {
      publish: jest.fn((event: { eventType: string }) => {
        timelineEvents.push(event);
        return Promise.resolve();
      }),
      list: jest.fn(() => Promise.resolve([])),
    } as never,
    {
      record: jest.fn((entry: Harness['audits'][number]) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    } as never,
    {
      execute: (work: (prisma: unknown) => Promise<unknown>) =>
        work({
          customerSegmentAssignment: {
            deleteMany: jest.fn(),
            createMany: jest.fn(),
          },
        }),
    } as never,
    {
      receivablesLive: options.odooLive ?? false,
      kickCustomer: jest.fn((id: string) => {
        odooKicks.push(id);
      }),
    } as never,
    {
      mode: 'mock',
      lookupConsents: options.pdpaDown
        ? jest.fn(() => Promise.reject(new Error('pdpa down')))
        : jest.fn((queries: { contactId: string }[]) =>
            Promise.resolve(
              queries.map((query) => ({
                contactId: query.contactId,
                email: 'granted',
                phone: 'granted',
                doNotCall: false,
              })),
            ),
          ),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    {
      count: opportunityCount,
      sumAmount: jest.fn(() => Promise.resolve(0)),
    } as never,
  );

  return {
    service,
    audits,
    timelineEvents,
    fieldChangeRows,
    customers,
    requestCount,
    odooLookup,
    opportunityCount,
    odooKicks,
  };
}

function createDto(overrides: Record<string, unknown> = {}) {
  return {
    type: 'corporate',
    name_th: 'บริษัท กขค เทรดดิ้ง จำกัด',
    tax_id: VALID_TAX_ID,
    ...overrides,
  } as never;
}

describe('CM-03 duplicate prevention on create', () => {
  it('CM-03 blocks duplicate tax id with CRM_CUSTOMER_DUPLICATE', async () => {
    const { service } = harness({
      checkResult: {
        duplicate: similar({ id: 'cust-dup', taxId: VALID_TAX_ID }),
        headOffice: null,
        similar: [],
        threshold: 0.85,
      },
    });

    await expect(service.create(createDto(), principal())).rejects.toThrow(
      expect.objectContaining({ code: 'CRM_CUSTOMER_DUPLICATE' }),
    );
  });

  it('CM-03 warns on a similar name until the caller confirms', async () => {
    const { service } = harness({
      checkResult: {
        duplicate: null,
        headOffice: null,
        similar: [similar()],
        threshold: 0.85,
      },
    });

    await expect(service.create(createDto(), principal())).rejects.toThrow(
      expect.objectContaining({ code: 'CRM_CUSTOMER_SIMILAR' }),
    );
  });

  it('CM-03 refuses the override without the dedicated permission', async () => {
    const { service } = harness({
      checkResult: {
        duplicate: null,
        headOffice: null,
        similar: [similar()],
        threshold: 0.85,
      },
    });

    await expect(
      service.create(
        createDto({
          confirm_duplicate: true,
          override_reason: 'ลูกค้าคนละราย',
        }),
        principal(['crm.customer.manage']),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('CM-03 refuses the override without a reason', async () => {
    const { service } = harness({
      checkResult: {
        duplicate: null,
        headOffice: null,
        similar: [similar()],
        threshold: 0.85,
      },
    });

    await expect(
      service.create(
        createDto({ confirm_duplicate: true }),
        principal(['crm.customer.manage', 'crm.customer.dedup.override']),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('CM-03 records an audited override when permitted, with the reason', async () => {
    const { service, audits } = harness({
      checkResult: {
        duplicate: null,
        headOffice: null,
        similar: [similar()],
        threshold: 0.85,
      },
    });

    await service.create(
      createDto({ confirm_duplicate: true, override_reason: 'ลูกค้าคนละราย' }),
      principal(['crm.customer.manage', 'crm.customer.dedup.override']),
    );

    const override = audits.find(
      (a) => a.eventType === 'crm.customer.dedup_overridden',
    );
    expect(override).toBeDefined();
    expect(override?.after).toMatchObject({ reason: 'ลูกค้าคนละราย' });
  });

  it('a confirm flag on a clean name demands nothing extra', async () => {
    const { service } = harness({});

    await expect(
      service.create(
        createDto({ confirm_duplicate: true }),
        principal(['crm.customer.manage']),
      ),
    ).resolves.toBeDefined();
  });
});

describe('CM-01 registry rules', () => {
  it('CM-01 rejects a tax id that fails the 13-digit checksum', async () => {
    const { service } = harness({});

    await expect(
      service.create(createDto({ tax_id: '1234567890120' }), principal()),
    ).rejects.toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('CM-01 writes one field-history row per changed field, none for untouched', async () => {
    const { service, fieldChangeRows } = harness({});

    await service.update(
      'cust-1',
      { name_th: 'บริษัท กขค กรุ๊ป จำกัด', name_en: undefined },
      principal(),
    );

    expect(fieldChangeRows.map((r) => r.field)).toEqual(['nameTh']);
    expect(fieldChangeRows[0]).toMatchObject({
      before: 'บริษัท กขค เทรดดิ้ง จำกัด',
      after: 'บริษัท กขค กรุ๊ป จำกัด',
    });
  });

  it('SCOPE-03: a customer outside the caller’s reach answers NOT_FOUND', async () => {
    const { service } = harness({ detail: null });

    await expect(service.findOne('cust-x', principal())).rejects.toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('an alias (merged) customer refuses edits', async () => {
    const { service } = harness({
      detail: customerRow({ mergedIntoCustomerId: 'cust-main' }),
    });

    await expect(
      service.update('cust-1', { name_th: 'x' }, principal()),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'CRM_CUSTOMER_STATE_INVALID' }),
    );
  });
});

describe('CM-04 lifecycle through the service', () => {
  it('CM-04 refuses a transition outside the table (active → active)', async () => {
    const { service } = harness({ detail: customerRow({ status: 'active' }) });

    await expect(service.activate('cust-1', principal())).rejects.toThrow(
      expect.objectContaining({ code: 'CRM_CUSTOMER_STATE_INVALID' }),
    );
  });

  it('CM-04 deactivation records the reason and publishes a timeline event', async () => {
    const { service, audits, timelineEvents, customers } = harness({
      detail: customerRow({ status: 'active' }),
    });

    await service.deactivate('cust-1', 'เลิกกิจการ', principal());

    const [[updateArg]] = customers.update.mock.calls as [
      [{ data: Record<string, unknown> }],
    ];
    expect(updateArg.data).toMatchObject({
      status: 'inactive',
      deactivateReason: 'เลิกกิจการ',
    });
    expect(
      audits.some((a) => a.eventType === 'crm.customer.status_changed'),
    ).toBe(true);
    expect(
      timelineEvents.some((t) => t.eventType === 'customer.status_changed'),
    ).toBe(true);
  });

  it('CM-04 there is no path that deletes — deactivate keeps the row', async () => {
    const { service, customers } = harness({
      detail: customerRow({ status: 'active' }),
    });

    await service.deactivate('cust-1', 'เลิกกิจการ', principal());

    // The only write is an update; nothing in the service reaches a delete.
    expect(customers.update).toHaveBeenCalled();
    expect(
      Object.getOwnPropertyNames(Object.getPrototypeOf(service)).filter((m) =>
        m.toLowerCase().includes('delete'),
      ),
    ).toEqual([]);
  });
});

describe('C360-03 timeline publishing', () => {
  it('create publishes customer.created through the central interface', async () => {
    const { service, timelineEvents } = harness({});

    await service.create(createDto(), principal());

    expect(timelineEvents.map((t) => t.eventType)).toContain(
      'customer.created',
    );
  });
});

describe('C360-01 summary — ตัวเลขการ์ดหน้า 360°', () => {
  it('C360-01 counts children and requests through the same scoped filters', async () => {
    const { service, requestCount } = harness({});

    const summary = await service.summaryOf(
      'cust-1',
      principal(['crm.customer.read', 'request.read']),
    );

    expect(summary.contacts).toBe(3);
    expect(summary.locations).toBe(2);
    expect(summary.requests).toEqual({ total: 0, open: 0 });
    // both counts (total + open) went through the request repository —
    // meaning visibleRequestsWhere, not a hand-rolled where.
    expect(requestCount).toHaveBeenCalledTimes(2);
    expect(summary.financials).toBeNull();
  });

  it('C360-04 a viewer without request.read gets null, not a number that 403s on click', async () => {
    const { service, requestCount } = harness({});

    const summary = await service.summaryOf(
      'cust-1',
      principal(['crm.customer.read']),
    );

    expect(summary.requests).toBeNull();
    expect(requestCount).not.toHaveBeenCalled();
  });

  const cachedReceivables = {
    receivables: {
      outstanding: 75000,
      invoiceCount: 2,
      asOf: '2026-09-15T06:51:00.000Z',
    },
  };

  /** C360-02 — ผู้ที่ config ให้เห็นยอดค้างชำระ (เช่น ผู้จัดการฝ่าย/ผู้บริหาร). */
  const financeViewer = () =>
    principal(['crm.customer.read', 'crm.customer.financial.read']);

  it('C360-02 ODOO_MODE=mock — ยอดค้างชำระใน cache เป็นตัวเลขปลอม ตอบ null ไม่โชว์เป็นยอดจริง', async () => {
    const { service } = harness({ odooPayload: cachedReceivables });

    const summary = await service.summaryOf('cust-1', financeViewer());

    expect(summary.financials).toBeNull();
  });

  it('C360-02 ODOO_MODE=http — ยอดค้างชำระอ่านจาก cache ของรอบ sync', async () => {
    const { service } = harness({
      odooLive: true,
      odooPayload: cachedReceivables,
    });

    const summary = await service.summaryOf('cust-1', financeViewer());

    expect(summary.financials).toEqual(cachedReceivables.receivables);
  });

  it('C360-04 ไม่มี crm.customer.financial.read — ไม่อ่าน cache และไม่มียอดใน payload', async () => {
    const { service, odooLookup } = harness({
      odooLive: true,
      odooPayload: cachedReceivables,
    });

    const summary = await service.summaryOf(
      'cust-1',
      principal(['crm.customer.read']),
    );

    expect(summary.financials).toBeNull();
    expect(odooLookup).not.toHaveBeenCalled();
  });

  it('C360-04 a viewer without crm.sales.read never counts opportunities', async () => {
    const { service, opportunityCount } = harness({});

    const summary = await service.summaryOf(
      'cust-1',
      principal(['crm.customer.read']),
    );

    expect(summary.opportunities).toBeNull();
    expect(opportunityCount).not.toHaveBeenCalled();
  });

  it('SCOPE-03 a customer outside the caller answers 404 before any counting', async () => {
    const { service, requestCount } = harness({ detail: null });

    await expect(
      service.summaryOf('cust-elsewhere', principal(['crm.customer.read'])),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(requestCount).not.toHaveBeenCalled();
  });
});

describe('CM-05 consent badge — อ่านสดจากระบบ PDPA กลาง', () => {
  it('CM-05 returns one live status per contact, never storing a copy', async () => {
    const { service } = harness({
      detail: customerRow({
        contacts: [
          { id: 'ct-1', email: 'a@b.co', phone: '0812345678' },
          { id: 'ct-2', email: null, phone: '021112229' },
        ],
      }),
    });

    const statuses = await service.contactConsents(
      'cust-1',
      principal(['crm.customer.read']),
    );

    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({ contactId: 'ct-1', email: 'granted' });
  });

  it('CM-05 the PDPA service being down degrades to unknown, not a broken tab', async () => {
    const { service } = harness({
      pdpaDown: true,
      detail: customerRow({
        contacts: [{ id: 'ct-1', email: 'a@b.co', phone: null }],
      }),
    });

    const statuses = await service.contactConsents(
      'cust-1',
      principal(['crm.customer.read']),
    );

    expect(statuses[0]).toMatchObject({
      contactId: 'ct-1',
      email: 'unknown',
      phone: null,
      doNotCall: false,
    });
  });
});
