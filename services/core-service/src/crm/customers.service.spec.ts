import {
  accessSubject,
  salesAccessSubject,
  visibleRequestsWhere,
  visibleSalesWhere,
} from '@request-management/share';
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

function principal(
  permissions: string[] = ['crm.customer.manage'],
  /** Whether the seeded `customer.taxId` rule lets this caller see it. */
  seesTaxId = true,
): Principal {
  return {
    userId: ME,
    activeCompanyId: OSD,
    username: 'me',
    displayName: 'ทดสอบ ระบบ',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
    sensitiveFieldsAll: ['customer.taxId'],
    sensitiveFieldsVisible: seesTaxId ? ['customer.taxId'] : [],
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
    search: jest.Mock;
  };
  requestCount: jest.Mock;
  /** C360-04 — the ยอดค้างชำระ cache read, asserted *not* to run without permission. */
  erpLookup: jest.Mock;
  /** C360-04 — the โอกาสการขาย count, same. */
  opportunityCount: jest.Mock;
  erpKicks: string[];
}

function harness(options: {
  checkResult?: DuplicateCheckResult;
  pdpaDown?: boolean;
  detail?: Record<string, unknown> | null;
  /** driver SAP จริง (true) หรือ mock (ค่าตั้งต้น). */
  erpLive?: boolean;
  /** payload ใน customer_external_codes ที่รอบ sync เติมไว้. */
  erpPayload?: Record<string, unknown>;
  /** CM-01 field-history rows the history read returns. */
  history?: Record<string, unknown>[];
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
  const erpLookup = jest.fn(() =>
    Promise.resolve(
      options.erpPayload ? { payload: options.erpPayload } : null,
    ),
  );
  const opportunityCount = jest.fn(() => Promise.resolve(0));
  const erpKicks: string[] = [];

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
      findFirst: erpLookup,
      upsert: jest.fn(),
    } as never,
    {
      createMany: jest.fn((rows: Harness['fieldChangeRows']) => {
        fieldChangeRows.push(...rows);
        return Promise.resolve({ count: rows.length });
      }),
      findMany: jest.fn(() => Promise.resolve(options.history ?? [])),
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
      receivablesLive: options.erpLive ?? false,
      kickCustomer: jest.fn((id: string) => {
        erpKicks.push(id);
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
    erpLookup,
    opportunityCount,
    erpKicks,
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

    await expect(
      service.create(createDto(), principal()),
    ).rejects.toMatchObject({
      code: 'CRM_CUSTOMER_DUPLICATE',
      // the form links straight to the row that already exists
      details: expect.arrayContaining([
        { field: 'existing_customer_id', reason: 'cust-dup' },
      ]) as unknown,
    });
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

  it('CM-08/SCOPE-02 the card counts use the very filter the tabs use — compared, not assumed', async () => {
    const { service, requestCount, opportunityCount } = harness({});
    const viewer = principal([
      'crm.customer.read',
      'request.read',
      'crm.sales.read',
    ]);

    await service.summaryOf('cust-1', viewer);

    type Counted = { where: { AND: unknown[] } };
    const requestWheres = (requestCount.mock.calls as [Counted][]).map(
      ([args]) => args.where,
    );
    // total, and open = total's where AND a status filter
    expect(requestWheres[0]).toEqual({
      AND: [
        visibleRequestsWhere(accessSubject(viewer)),
        { refType: 'customer', refId: 'cust-1' },
      ],
    });
    expect(requestWheres[1].AND[0]).toEqual(requestWheres[0]);

    const [[opportunityArgs]] = opportunityCount.mock.calls as [Counted][];
    expect(opportunityArgs.where.AND[0]).toEqual({
      AND: [
        visibleSalesWhere(salesAccessSubject(viewer)),
        { customerId: 'cust-1' },
      ],
    });
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

  it('C360-02 ERP_MODE=mock — ยอดค้างชำระใน cache เป็นตัวเลขปลอม ตอบ null ไม่โชว์เป็นยอดจริง', async () => {
    const { service } = harness({ erpPayload: cachedReceivables });

    const summary = await service.summaryOf('cust-1', financeViewer());

    expect(summary.financials).toBeNull();
  });

  it('C360-02 driver SAP จริง — ยอดค้างชำระอ่านจาก cache ของรอบ sync', async () => {
    const { service } = harness({
      erpLive: true,
      erpPayload: cachedReceivables,
    });

    const summary = await service.summaryOf('cust-1', financeViewer());

    expect(summary.financials).toEqual(cachedReceivables.receivables);
  });

  it('C360-04 ไม่มี crm.customer.financial.read — ไม่อ่าน cache และไม่มียอดใน payload', async () => {
    const { service, erpLookup } = harness({
      erpLive: true,
      erpPayload: cachedReceivables,
    });

    const summary = await service.summaryOf(
      'cust-1',
      principal(['crm.customer.read']),
    );

    expect(summary.financials).toBeNull();
    expect(erpLookup).not.toHaveBeenCalled();
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

describe('CM-08 เลขผู้เสียภาษีไม่หลุดถึงคนที่ไม่มี crm.customer.sensitive.read', () => {
  const checked: DuplicateCheckResult = {
    duplicate: similar({ id: 'cust-dup', taxId: VALID_TAX_ID, similarity: 1 }),
    headOffice: similar({ id: 'cust-hq', taxId: VALID_TAX_ID }),
    similar: [similar({ taxId: '3101234567891' })],
    threshold: 0.85,
  };
  const dto = { name_th: 'บริษัท กขค จำกัด', tax_id: VALID_TAX_ID };

  it('check-duplicate: ไม่มีสิทธิ์ = ไม่มีเลขภาษีในทุกแถว แต่ยังบอกว่าซ้ำกับใคร', async () => {
    const { service } = harness({ checkResult: checked });

    const result = await service.checkDuplicate(
      dto,
      principal(['crm.customer.read'], false),
    );

    expect(result.duplicate).toMatchObject({ id: 'cust-dup' });
    expect(result.headOffice).toMatchObject({ id: 'cust-hq' });
    expect(result.similar).toHaveLength(1);
    for (const row of [
      result.duplicate,
      result.headOffice,
      ...result.similar,
    ]) {
      expect(row).not.toHaveProperty('taxId');
    }
  });

  it('check-duplicate: มีสิทธิ์ = ได้ครบ', async () => {
    const { service } = harness({ checkResult: checked });

    const result = await service.checkDuplicate(dto, principal());

    expect(result).toEqual(checked);
  });

  it('history: เห็นว่าเลขภาษีถูกแก้เมื่อไร แต่ไม่เห็นค่าก่อน/หลัง; ฟิลด์อื่นเห็นปกติ', async () => {
    const { service } = harness({
      history: [
        {
          field: 'taxId',
          before: '3101234567891',
          after: VALID_TAX_ID,
          changedBy: null,
        },
        { field: 'nameTh', before: 'เก่า', after: 'ใหม่', changedBy: null },
      ],
    });

    const rows = await service.history(
      'cust-1',
      principal(['crm.customer.read'], false),
    );

    expect(rows[0]).toEqual({
      field: 'taxId',
      changedBy: null,
      changedByName: null,
    });
    expect(rows[1]).toMatchObject({ before: 'เก่า', after: 'ใหม่' });
  });

  it('history: มีสิทธิ์ = เห็นค่าเลขภาษีก่อน/หลัง', async () => {
    const { service } = harness({
      history: [{ field: 'taxId', before: 'a', after: 'b', changedBy: null }],
    });

    const rows = await service.history('cust-1', principal());

    expect(rows[0]).toMatchObject({ before: 'a', after: 'b' });
  });

  function taxIdClause(search: jest.Mock): unknown {
    const [[where]] = search.mock.calls as [
      {
        AND: [unknown, { OR: Record<string, unknown>[] }];
      },
    ][];
    return where.AND[1].OR.find((clause) => 'taxId' in clause)?.taxId;
  }

  it('ค้นรายการ: ไม่มีสิทธิ์ = เลขภาษีต้องตรงทั้งเลข ค้นบางส่วนไม่ได้', async () => {
    const h = harness({});

    await h.service.list(principal(['crm.customer.read'], false), {
      search: '31012',
    } as never);

    expect(taxIdClause(h.customers.search)).toBe('31012');
  });

  it('ค้นรายการ: มีสิทธิ์ = ค้นเลขภาษีบางส่วนได้', async () => {
    const h = harness({});

    await h.service.list(principal(), { search: '31012' } as never);

    expect(taxIdClause(h.customers.search)).toEqual({ contains: '31012' });
  });
});

/**
 * SCOPE-03 — every `:id` route answers 404 for a customer the caller cannot
 * reach (another company, or outside their book), and writes nothing first.
 * `findDetail` returning null is what the scoped, company-pinned lookup
 * answers in that case.
 */
describe('SCOPE-03 every :id customer route answers 404 out of reach', () => {
  const p = () => principal(['crm.customer.manage', 'admin.crm.manage']);
  const routes: [string, (s: Harness['service']) => Promise<unknown>][] = [
    ['findOne', (s) => s.findOne('x', p())],
    ['contactConsents', (s) => s.contactConsents('x', p())],
    ['summaryOf', (s) => s.summaryOf('x', p())],
    ['update', (s) => s.update('x', { name_th: 'y' }, p())],
    ['activate', (s) => s.activate('x', p())],
    ['suspend', (s) => s.suspend('x', 'เหตุผล', p())],
    ['deactivate', (s) => s.deactivate('x', 'เหตุผล', p())],
    ['addLocation', (s) => s.addLocation('x', {} as never, p())],
    ['updateLocation', (s) => s.updateLocation('x', 'l', {} as never, p())],
    ['removeLocation', (s) => s.removeLocation('x', 'l', p())],
    ['addContact', (s) => s.addContact('x', {} as never, p())],
    ['updateContact', (s) => s.updateContact('x', 'c', {} as never, p())],
    ['removeContact', (s) => s.removeContact('x', 'c', p())],
    ['setSegments', (s) => s.setSegments('x', { segment_value_ids: [] }, p())],
    ['history', (s) => s.history('x', p())],
    ['timelineOf', (s) => s.timelineOf('x', p(), {})],
    ['listExternalCodes', (s) => s.listExternalCodes('x', p())],
    ['upsertExternalCode', (s) => s.upsertExternalCode('x', {} as never, p())],
  ];

  it.each(routes)('%s', async (_name, call) => {
    const h = harness({ detail: null });

    await expect(call(h.service)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.customers.update).not.toHaveBeenCalled();
    expect(h.audits).toHaveLength(0);
    expect(h.timelineEvents).toHaveLength(0);
  });

  it('the lookup behind them is pinned to the caller’s company', async () => {
    const h = harness({ detail: null });

    await h.service.findOne('x', p()).catch(() => undefined);

    const [[lookup]] = h.customers.findDetail.mock.calls as [unknown][];
    expect(JSON.stringify(lookup)).toContain(`"companyId":"${OSD}"`);
  });
});
