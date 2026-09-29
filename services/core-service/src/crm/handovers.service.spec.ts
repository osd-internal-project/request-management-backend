import type { Principal } from '@request-management/share';
import { checklistGaps, mergeChecklist } from './handover-rules';
import { HandoversService } from './handovers.service';

const TEMPLATE = [
  {
    code: 'PRICE',
    category: 'commercial' as const,
    label: 'ราคาตรงกับใบเสนอราคา',
    requiresDetail: false,
  },
  {
    code: 'SCOPE',
    category: 'requirement' as const,
    label: 'ขอบเขตงาน',
    requiresDetail: true,
  },
  {
    code: 'DATES',
    category: 'commitment' as const,
    label: 'วันส่งมอบที่รับปาก',
    requiresDetail: true,
  },
];

const ALL_DONE = [
  { code: 'PRICE', checked: true },
  { code: 'SCOPE', checked: true, detail: 'กล้อง 24 ตัว อาคาร B' },
  { code: 'DATES', checked: true, detail: 'ติดตั้งเสร็จ 31 ต.ค.' },
];

const seller = {
  userId: 'sales-1',
  displayName: 'สมชาย ขายดี',
  activeCompanyId: 'osd',
  orgUnitId: 'ou-sales',
  ledUnitIds: [],
  permissions: ['crm.sales.read', 'crm.sales.manage'],
} as unknown as Principal;

const installer = {
  userId: 'inst-1',
  displayName: 'สมหญิง ติดตั้งไว',
  activeCompanyId: 'osd',
  orgUnitId: 'ou-install',
  ledUnitIds: [],
  permissions: [],
} as unknown as Principal;

const outsider = {
  ...installer,
  userId: 'other-1',
  orgUnitId: 'ou-finance',
} as unknown as Principal;

describe('CD-84 handover checklist rules', () => {
  it('the list is the company’s current one; old answers kept by code, dropped lines forgotten', () => {
    const items = mergeChecklist(TEMPLATE, [
      { code: 'SCOPE', checked: true, detail: '  ติดตั้งกล้อง  ' },
      { code: 'GONE', checked: true },
    ]);
    expect(items.map((item) => [item.code, item.checked, item.detail])).toEqual(
      [
        ['PRICE', false, null],
        ['SCOPE', true, 'ติดตั้งกล้อง'],
        ['DATES', false, null],
      ],
    );
  });

  it('every gap is named: an unticked line, and a ticked one that needs detail but has none', () => {
    const items = mergeChecklist(TEMPLATE, [
      { code: 'PRICE', checked: true },
      { code: 'SCOPE', checked: true, detail: ' ' },
    ]);
    expect(checklistGaps(items)).toEqual([
      'ต้องกรอกรายละเอียด: ขอบเขตงาน',
      'ยังไม่ได้ยืนยัน: วันส่งมอบที่รับปาก',
    ]);
    expect(checklistGaps(mergeChecklist(TEMPLATE, ALL_DONE))).toEqual([]);
  });
});

describe('CD-84 sending a won deal to the next team', () => {
  function harness(options: {
    stage?: string;
    existing?: Record<string, unknown> | null;
    defaultTeam?: string | null;
    unitExists?: boolean;
    claim?: number;
    head?: string | null;
    handoverCompany?: string;
    dealVisible?: boolean;
  }) {
    const written: Record<string, unknown>[] = [];
    const audits: string[] = [];
    const notices: { to: readonly (string | null)[]; event: string }[] = [];
    const deal = {
      id: 'opp-1',
      companyId: 'osd',
      opportunityCode: 'OPP-OSD-0042',
      title: 'ระบบกล้อง อาคาร B',
      stage: options.stage ?? 'won',
      amount: null,
      customerId: 'cus-1',
      prospectName: null,
      ownerUserId: 'sales-1',
      customer: { nameTh: 'บริษัท ลูกค้า จำกัด' },
    };
    let stored = options.existing ?? null;
    const handovers = {
      findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
        if (
          stored &&
          'companyId' in args.where &&
          args.where.companyId !== (options.handoverCompany ?? 'osd')
        )
          return Promise.resolve(null);
        return Promise.resolve(stored);
      }),
      findMany: jest.fn(() => Promise.resolve(stored ? [stored] : [])),
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        written.push(args.data);
        stored = { id: 'ho-1', round: 0, history: [], ...args.data };
        return Promise.resolve({ id: 'ho-1' });
      }),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        written.push(args.data);
        const count = options.claim ?? 1;
        if (count && stored) stored = { ...stored, ...args.data };
        return Promise.resolve({ count });
      }),
    };
    const service = new HandoversService(
      handovers as never,
      {
        findMany: jest.fn(() => Promise.resolve(TEMPLATE)),
      } as never,
      {
        findFirst: jest.fn((args: { where: Record<string, unknown> }) =>
          Promise.resolve(
            'AND' in args.where && options.dealVisible === false ? null : deal,
          ),
        ),
        findMany: jest.fn(() => Promise.resolve([deal])),
      } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            handoverOrgUnitId:
              options.defaultTeam === undefined
                ? 'ou-install'
                : options.defaultTeam,
          }),
        ),
      } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve(
            options.unitExists === false
              ? null
              : { id: 'ou-install', name: 'ฝ่ายติดตั้ง' },
          ),
        ),
        findMany: jest.fn(() =>
          Promise.resolve([{ id: 'ou-install', name: 'ฝ่ายติดตั้ง' }]),
        ),
        ancestorIdsOf: jest.fn(() => Promise.resolve(['ou-install', 'ou-ops'])),
        managersOf: jest.fn(() =>
          Promise.resolve(
            options.head === null ? [] : [options.head ?? 'install-head'],
          ),
        ),
      } as never,
      { findMany: jest.fn(() => Promise.resolve([])) } as never,
      {
        handoverChanged: jest.fn(
          (to: readonly (string | null)[], _company: string, event: string) => {
            notices.push({ to, event });
            return Promise.resolve();
          },
        ),
      } as never,
      { publish: jest.fn(() => Promise.resolve()) } as never,
      {
        record: jest.fn((event: { eventType: string }) => {
          audits.push(event.eventType);
          return Promise.resolve();
        }),
      } as never,
      {
        execute: jest.fn((work: (p: unknown) => unknown) => work({})),
      } as never,
    );
    return { service, written, audits, notices };
  }

  const submitted = (overrides: Record<string, unknown> = {}) => ({
    id: 'ho-1',
    companyId: 'osd',
    opportunityId: 'opp-1',
    status: 'submitted',
    toOrgUnitId: 'ou-install',
    items: mergeChecklist(TEMPLATE, ALL_DONE),
    round: 1,
    submittedBy: 'sales-1',
    history: [],
    ...overrides,
  });

  it('CD-84: an incomplete checklist cannot be sent — every gap is named, nothing written', async () => {
    const h = harness({});
    await expect(
      h.service.submit(
        'opp-1',
        { items: [{ code: 'PRICE', checked: true }] },
        seller,
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        { field: 'items', reason: 'ยังไม่ได้ยืนยัน: ขอบเขตงาน' },
        { field: 'items', reason: 'ยังไม่ได้ยืนยัน: วันส่งมอบที่รับปาก' },
      ],
    });
    expect(h.written).toHaveLength(0);
    expect(h.notices).toHaveLength(0);
  });

  it('no team chosen and no company default → refused', async () => {
    const h = harness({ defaultTeam: null });
    await expect(
      h.service.submit('opp-1', { items: ALL_DONE }, seller),
    ).rejects.toMatchObject({
      details: [{ field: 'items', reason: 'ต้องเลือกทีมที่รับงานต่อ' }],
    });
  });

  it('CD-84: complete → sent to the default team, its head told, audited', async () => {
    const h = harness({});
    await h.service.submit('opp-1', { items: ALL_DONE }, seller);
    expect(h.written[0]).toMatchObject({
      status: 'submitted',
      round: 1,
      submittedBy: 'sales-1',
      toOrgUnitId: 'ou-install',
    });
    expect((h.written[0].history as { action: string }[])[0]).toMatchObject({
      action: 'submitted',
      round: 1,
    });
    expect(h.audits).toEqual(['crm.handover.submitted']);
    expect(h.notices).toEqual([{ to: ['install-head'], event: 'submitted' }]);
  });

  it('only a won deal can be handed over; a team from nowhere is refused', async () => {
    await expect(
      harness({ stage: 'negotiating' }).service.submit(
        'opp-1',
        { items: ALL_DONE },
        seller,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness({ unitExists: false }).service.submit(
        'opp-1',
        { items: ALL_DONE, to_org_unit_id: 'ou-elsewhere' },
        seller,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('while the team holds it, the salesperson cannot change it', async () => {
    const h = harness({ existing: submitted() });
    await expect(
      h.service.save('opp-1', { items: ALL_DONE }, seller),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a returned handover is fixed and sent again as the next round', async () => {
    const h = harness({
      existing: submitted({
        status: 'returned',
        returnReason: 'ขาดวันติดตั้ง',
      }),
    });
    await h.service.submit('opp-1', { items: ALL_DONE }, seller);
    expect(h.written[0]).toMatchObject({ status: 'submitted', round: 2 });
  });

  it('CD-84: someone in the receiving team accepts; the deal owner is told', async () => {
    const h = harness({ existing: submitted({ submittedBy: 'sales-2' }) });
    await h.service.accept('ho-1', installer);
    expect(h.written[0]).toMatchObject({
      status: 'accepted',
      decidedBy: 'inst-1',
    });
    expect(h.audits).toEqual(['crm.handover.accepted']);
    expect(h.notices).toEqual([
      { to: ['sales-1', 'sales-2'], event: 'accepted' },
    ]);
  });

  it('CD-84: returned with a reason; a return without one is refused', async () => {
    const h = harness({ existing: submitted() });
    await expect(
      h.service.returnToSales('ho-1', '  ', installer),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await h.service.returnToSales(
      'ho-1',
      'ยังไม่ระบุผู้ติดต่อหน้างาน',
      installer,
    );
    expect(h.written[0]).toMatchObject({
      status: 'returned',
      returnReason: 'ยังไม่ระบุผู้ติดต่อหน้างาน',
    });
    expect(h.notices[0].event).toBe('returned');
  });

  it('someone outside the team cannot decide, even when they can see the deal', async () => {
    const h = harness({ existing: submitted() });
    await expect(h.service.accept('ho-1', outsider)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(h.written).toHaveLength(0);
  });

  it('SCOPE-03: another company’s handover, or one out of sight, is 404', async () => {
    await expect(
      harness({
        existing: submitted(),
        handoverCompany: 'other',
      }).service.findOne('ho-1', installer),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness({
        existing: submitted({ toOrgUnitId: 'ou-somewhere' }),
        dealVisible: false,
      }).service.findOne('ho-1', outsider),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('two people acting at once — the second finds it already decided', async () => {
    const h = harness({ existing: submitted(), claim: 0 });
    await expect(h.service.accept('ho-1', installer)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(h.notices).toHaveLength(0);
  });
});

describe('CD-84 the checklist in CRM settings', () => {
  it('a duplicated code is refused before anything is written', async () => {
    const upsert = jest.fn();
    const service = new HandoversService(
      {} as never,
      { upsert } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { execute: jest.fn() } as never,
    );
    await expect(
      service.replaceItems(
        {
          items: [
            { code: 'A', category: 'commercial', label: 'x' },
            { code: 'A', category: 'commitment', label: 'y' },
          ],
        },
        seller,
      ),
    ).rejects.toThrow('รหัสรายการซ้ำ: A');
    expect(upsert).not.toHaveBeenCalled();
  });
});
