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
}

function harness(options: {
  checkResult?: DuplicateCheckResult;
  detail?: Record<string, unknown> | null;
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

  const service = new CustomersService(
    customers as never,
    { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() } as never,
    { create: jest.fn(), update: jest.fn(), findFirst: jest.fn() } as never,
    {
      findMany: jest.fn(() => Promise.resolve([])),
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
    { issue: jest.fn(() => Promise.resolve('CUS-OSD-000001')) } as never,
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
  );

  return { service, audits, timelineEvents, fieldChangeRows, customers };
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
      checkResult: { duplicate: null, headOffice: null, similar: [similar()], threshold: 0.85 },
    });

    await expect(service.create(createDto(), principal())).rejects.toThrow(
      expect.objectContaining({ code: 'CRM_CUSTOMER_SIMILAR' }),
    );
  });

  it('CM-03 refuses the override without the dedicated permission', async () => {
    const { service } = harness({
      checkResult: { duplicate: null, headOffice: null, similar: [similar()], threshold: 0.85 },
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
      checkResult: { duplicate: null, headOffice: null, similar: [similar()], threshold: 0.85 },
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
      checkResult: { duplicate: null, headOffice: null, similar: [similar()], threshold: 0.85 },
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
