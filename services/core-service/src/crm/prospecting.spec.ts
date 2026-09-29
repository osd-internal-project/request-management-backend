import type { Principal } from '@request-management/share';
import { LeadsService } from './leads.service';
import { discoveryMissing, targetMayMove } from './prospecting-rules';
import { TargetAccountsService } from './target-accounts.service';

function principal(
  permissions: string[] = ['crm.sales.read', 'crm.sales.manage'],
): Principal {
  return {
    userId: 'me',
    username: 'me',
    displayName: 'ทดสอบ ขาย',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-getter',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
  } as unknown as Principal;
}

const noDiscovery = {
  discoveryNeed: null,
  discoveryBudget: null,
  discoveryBudgetNote: null,
  discoveryDecisionMaker: null,
  discoveryTimeframe: null,
};

describe('CD-85 Getter rules', () => {
  it('CD-85 Discovery: four items, a budget note counts as an answer, blanks do not', () => {
    expect(discoveryMissing(noDiscovery)).toEqual([
      'need',
      'budget',
      'decision_maker',
      'timeframe',
    ]);
    expect(
      discoveryMissing({
        discoveryNeed: '  ',
        discoveryBudget: 0,
        discoveryBudgetNote: null,
        discoveryDecisionMaker: 'ผอ. ไอที',
        discoveryTimeframe: new Date('2026-12-31T00:00:00Z'),
      }),
    ).toEqual(['need']);
    expect(
      discoveryMissing({
        ...noDiscovery,
        discoveryBudgetNote: 'ไม่เปิดเผย อยู่ในงบปีหน้า',
      }),
    ).not.toContain('budget');
  });

  it('CD-85 a target moves only forward, by what happened to it; a dropped one can come back', () => {
    expect(targetMayMove('targeting', 'approaching')).toBe(true);
    expect(targetMayMove('approaching', 'converted')).toBe(true);
    expect(targetMayMove('targeting', 'converted')).toBe(false);
    expect(targetMayMove('converted', 'dropped')).toBe(false);
    expect(targetMayMove('dropped', 'targeting')).toBe(true);
    expect(targetMayMove('dropped', 'approaching')).toBe(true);
  });
});

describe('CD-85 Prospecting on leads', () => {
  function harness(
    options: {
      activities?: Record<string, unknown>[];
      discoveryRequired?: boolean;
      activityType?: string;
    } = {},
  ) {
    const lead = {
      id: 'lead-1',
      companyId: 'osd',
      name: 'บริษัท มุ่งหวัง จำกัด',
      status: 'contacted',
      ownerUserId: 'me',
      customerId: null,
      taxId: null,
      contactName: null,
      phone: null,
      email: null,
      ...noDiscovery,
      discoveryNeed: 'ตู้สาขาเก่า',
      activities: options.activities ?? [],
    };
    const leads = {
      findFirst: jest.fn(() => Promise.resolve(lead)),
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            ...lead,
            _count: { activities: 3 },
            activities: [
              {
                completedAt: new Date('2026-09-28T03:00:00Z'),
                outcome: 'no_answer',
              },
            ],
          },
        ]),
      ),
      count: jest.fn(() => Promise.resolve(1)),
      create: jest.fn(() => Promise.resolve({ id: 'lead-new' })),
      update: jest.fn(() => Promise.resolve({})),
    };
    const activities = {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'act-1',
          type: options.activityType ?? 'call',
          completedAt: null,
        }),
      ),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'act-2', ...args.data }),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'act-1', ...args.data }),
      ),
    };
    const targets = {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    };
    const statuses = {
      require: jest.fn((_c: string, code: string) =>
        Promise.resolve({
          code,
          kind: 'open',
          active: true,
          nameTh: code,
        }),
      ),
      defaultCode: jest.fn(() => Promise.resolve('new')),
      closingCode: jest.fn(() => Promise.resolve('converted')),
    };
    const service = new LeadsService(
      leads as never,
      { findFirst: jest.fn(() => Promise.resolve({ id: 'cus-1' })) } as never,
      {
        create: jest.fn(() =>
          Promise.resolve({ id: 'opp-1', opportunityCode: 'OPP-OSD-1' }),
        ),
      } as never,
      { record: jest.fn(() => Promise.resolve()) } as never,
      { execute: jest.fn() } as never,
      activities as never,
      { findMany: jest.fn(() => Promise.resolve([])) } as never,
      statuses as never,
      { kickLead: jest.fn() } as never,
      { resolveCode: jest.fn(() => Promise.resolve(undefined)) } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve(
            options.discoveryRequired === undefined
              ? null
              : { discoveryRequired: options.discoveryRequired },
          ),
        ),
      } as never,
      targets as never,
    );
    return { service, leads, activities, targets };
  }

  it('CD-85 an outcome is stored with a contact, refused on a task or a note', async () => {
    const h = harness();
    await h.service.addActivity(
      'lead-1',
      { type: 'line', subject: 'ทัก LINE OA', outcome: 'reached' },
      principal(),
    );
    const created = (
      h.activities.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(created).toMatchObject({ type: 'line', outcome: 'reached' });

    await expect(
      h.service.addActivity(
        'lead-1',
        { type: 'note', subject: 'x', outcome: 'interested' },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const onTask = harness({ activityType: 'task' });
    await expect(
      onTask.service.updateActivity(
        'lead-1',
        'act-1',
        { outcome: 'reached' },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('CD-85 the list carries attempts, the latest contact and what Discovery lacks; new_customer = no customer yet', async () => {
    const h = harness();
    const page = (await h.service.list(principal(), {
      new_customer: 'true',
    } as never)) as unknown as { data: Record<string, unknown>[] };
    const row = page.data[0];
    expect(row).toMatchObject({
      contact_attempts: 3,
      last_outcome: 'no_answer',
      discovery_missing: ['budget', 'decision_maker', 'timeframe'],
    });
    expect(row).not.toHaveProperty('_count');
    const where = (
      h.leads.findMany.mock.calls[0] as unknown as [
        { where: { AND: Record<string, unknown>[] } },
      ]
    )[0].where;
    expect(where.AND[1]).toMatchObject({ customerId: null });
  });

  it('CD-85 the detail counts only completed contacts and says whether the company wants Discovery first', async () => {
    const h = harness({
      discoveryRequired: true,
      activities: [
        {
          type: 'call',
          completedAt: new Date('2026-09-27T03:00:00Z'),
          outcome: 'no_answer',
          createdBy: 'me',
          completedBy: 'me',
        },
        {
          type: 'visit',
          completedAt: new Date('2026-09-28T03:00:00Z'),
          outcome: 'interested',
          createdBy: 'me',
          completedBy: 'me',
        },
        // planned, not yet an attempt
        {
          type: 'meeting',
          completedAt: null,
          outcome: null,
          createdBy: 'me',
          completedBy: null,
        },
        // not a contact
        {
          type: 'note',
          completedAt: new Date('2026-09-29T03:00:00Z'),
          outcome: null,
          createdBy: 'me',
          completedBy: 'me',
        },
      ],
    });
    await expect(
      h.service.findOne('lead-1', principal()),
    ).resolves.toMatchObject({
      contact_attempts: 2,
      last_outcome: 'interested',
      last_contact_at: new Date('2026-09-28T03:00:00Z'),
      discovery_required: true,
    });
  });

  it('CD-85 converting a lead marks the target it came from as converted — and is not blocked by Discovery (the workflow decides)', async () => {
    const h = harness({ discoveryRequired: true });
    await expect(
      h.service.convert('lead-1', {}, principal()),
    ).resolves.toMatchObject({ id: 'opp-1' });
    expect(h.targets.updateMany).toHaveBeenCalledWith({
      where: { leadId: 'lead-1', status: 'approaching' },
      data: { status: 'converted', updatedBy: 'me' },
    });
  });
});

describe('CD-85 target accounts', () => {
  function harness(
    options: {
      found?: Record<string, unknown> | null;
      claimed?: number;
      member?: Record<string, unknown> | null;
    } = {},
  ) {
    const audits: { eventType: string; after?: unknown }[] = [];
    const found =
      options.found === undefined
        ? {
            id: 't-1',
            companyId: 'osd',
            name: 'บริษัท เป้าหมาย จำกัด',
            nameEn: null,
            taxId: '0105551234567',
            industry: 'โรงพยาบาล',
            companySize: null,
            province: 'กรุงเทพมหานคร',
            note: 'ขยายสาขาปีหน้า',
            status: 'targeting',
            leadId: null,
            ownerUserId: 'me',
          }
        : options.found;
    const targets = {
      findFirst: jest.fn(() => Promise.resolve(found)),
      findMany: jest.fn(() => Promise.resolve(found ? [found] : [])),
      count: jest.fn(() => Promise.resolve(found ? 1 : 0)),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 't-new', ...args.data }),
      ),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() =>
        Promise.resolve({ count: options.claimed ?? 1 }),
      ),
    };
    const leads = {
      create: jest.fn(() => Promise.resolve({ id: 'lead-9' })),
    };
    const members = {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.member === undefined
            ? { id: 'sales-2', orgUnitId: 'unit-getter' }
            : options.member,
        ),
      ),
      findMany: jest.fn(() =>
        Promise.resolve([{ id: 'me', displayName: 'ทดสอบ ขาย' }]),
      ),
    };
    const audit = {
      record: jest.fn((entry: { eventType: string; after?: unknown }) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    };
    const service = new TargetAccountsService(
      targets as never,
      leads as never,
      members as never,
      audit as never,
    );
    return { service, targets, leads, members, audits };
  }

  it('CD-85 a target is created under the creator, medium priority by default, audited', async () => {
    const h = harness();
    await h.service.create({ name: '  รพ. ตัวอย่าง  ' }, principal());
    const data = (
      h.targets.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      companyId: 'osd',
      name: 'รพ. ตัวอย่าง',
      priority: 'medium',
      ownerUserId: 'me',
      ownerOrgUnitId: 'unit-getter',
    });
    expect(h.audits[0].eventType).toBe('crm.target_account.created');
  });

  it('an owner outside the company is refused; "" leaves it for anyone to take', async () => {
    const outsider = harness({ member: null });
    await expect(
      outsider.service.create(
        { name: 'x', owner_user_id: 'stranger' },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const pool = harness();
    await pool.service.create({ name: 'x', owner_user_id: '' }, principal());
    const data = (
      pool.targets.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.ownerUserId).toBeNull();
  });

  it('CD-85 start approaching: a lead is made from the company, linked, the target moves on', async () => {
    const h = harness();
    await expect(
      h.service.approach('t-1', { contact_name: 'คุณเอ' }, principal()),
    ).resolves.toEqual({ id: 't-1', status: 'approaching', lead_id: 'lead-9' });
    expect(h.leads.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'บริษัท เป้าหมาย จำกัด',
        tax_id: '0105551234567',
        industry: 'โรงพยาบาล',
        contact_name: 'คุณเอ',
        source_code: 'target_account',
      }),
      expect.anything(),
    );
    expect(h.targets.updateMany).toHaveBeenCalledWith({
      where: { id: 't-1', status: 'targeting' },
      data: { status: 'approaching', leadId: 'lead-9', updatedBy: 'me' },
    });
  });

  it('a dropped target taken up again keeps its lead — never a second one', async () => {
    const h = harness({
      found: {
        id: 't-1',
        name: 'x',
        status: 'dropped',
        leadId: 'lead-1',
        ownerUserId: 'me',
      },
    });
    await expect(h.service.reopen('t-1', principal())).resolves.toEqual({
      id: 't-1',
      status: 'approaching',
    });
    expect(h.leads.create).not.toHaveBeenCalled();
  });

  it('approaching twice, or a target already converted, is a conflict', async () => {
    const racing = harness({ claimed: 0 });
    await expect(
      racing.service.approach('t-1', {}, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const done = harness({
      found: { id: 't-1', name: 'x', status: 'converted', leadId: 'lead-1' },
    });
    await expect(
      done.service.drop('t-1', { reason: 'x' }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('SCOPE-03 a target out of reach answers 404', async () => {
    const h = harness({ found: null });
    await expect(
      h.service.approach('t-x', {}, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the list reads through the leads visibility rule and names the owner', async () => {
    const h = harness();
    const page = (await h.service.list(
      { priority: 'high' } as never,
      principal(),
    )) as unknown as { data: { owner: { displayName: string } }[] };
    expect(page.data[0].owner.displayName).toBe('ทดสอบ ขาย');
    const args = (
      h.targets.findMany.mock.calls[0] as unknown as [
        { where: { AND: Record<string, unknown>[] }; orderBy: unknown },
      ]
    )[0];
    expect(args.where.AND[0]).toMatchObject({ companyId: 'osd' });
    expect(args.where.AND[1]).toEqual({ priority: 'high' });
    expect(args.orderBy).toEqual([{ priority: 'asc' }, { createdAt: 'asc' }]);
  });
});
