import type { Principal } from '@request-management/share';
import { ContractRenewalService } from './contract-renewal.service';
import { ContractsService } from './contracts.service';
import { NotificationRulesService } from '../notifications/notification-rules.service';

const NOW = new Date('2026-09-29T03:00:00Z'); // 29 Sep 2026, Bangkok
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('CD-70 contract register — from a completed contract request', () => {
  function harness(options: {
    typeCode?: string | null;
    refType?: string;
    form?: Record<string, unknown>;
    dealCustomer?: string | null;
    existing?: boolean;
  }) {
    const created: Record<string, unknown>[] = [];
    const service = new ContractsService(
      {
        findFirst: jest.fn(() =>
          Promise.resolve(options.existing ? { id: 'c-0' } : null),
        ),
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return Promise.resolve({ id: 'c-1' });
        }),
      } as never,
      {} as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: 'opp-1',
            title: 'ระบบกล้อง อาคาร B',
            customerId:
              options.dealCustomer === undefined
                ? 'cus-1'
                : options.dealCustomer,
            ownerUserId: 'sales-1',
            ownerOrgUnitId: 'ou-sales',
          }),
        ),
      } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: 'req-1',
            requestNo: 'OSD-CTR-2609-0001',
            companyId: 'osd',
            refType: options.refType ?? 'opportunity',
            refId: 'OPP-OSD-0001',
            requesterId: 'sales-1',
            requesterOrgUnitId: 'ou-sales',
            formData: options.form ?? {
              start_date: '2026-10-01',
              end_date: '2027-09-30',
              contract_value: 480000,
              counterparty: 'บริษัท ลูกค้า จำกัด',
            },
          }),
        ),
      } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            contractRequestTypeCode:
              options.typeCode === undefined ? 'CTR' : options.typeCode,
          }),
        ),
      } as never,
      { on: jest.fn() } as never,
      { publish: jest.fn(() => Promise.resolve()) } as never,
      { record: jest.fn(() => Promise.resolve()) } as never,
      {} as never,
      { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) } as never,
    );
    return { service, created };
  }

  const event = { request_id: 'req-1', type_code: 'CTR', company_id: 'osd' };

  it('CD-70: a closed contract request on a deal becomes the customer’s contract, owned by the deal owner', async () => {
    const { service, created } = harness({});
    await service.onRequestCompleted(event);
    expect(created[0]).toMatchObject({
      customerId: 'cus-1',
      contractNo: 'OSD-CTR-2609-0001',
      title: 'ระบบกล้อง อาคาร B',
      endOn: day('2027-09-30'),
      startOn: day('2026-10-01'),
      value: 480000,
      opportunityId: 'opp-1',
      requestId: 'req-1',
      ownerUserId: 'sales-1',
    });
  });

  it('nothing is registered for another type, no end date, a prospect deal, or twice', async () => {
    for (const setup of [
      { typeCode: 'OTHER' },
      { typeCode: null },
      { form: { counterparty: 'x' } },
      { dealCustomer: null },
      { existing: true },
    ]) {
      const { service, created } = harness(setup);
      await service.onRequestCompleted(event);
      expect(created).toHaveLength(0);
    }
  });
});

describe('CD-70 renewal sweep', () => {
  const contract = (overrides: Record<string, unknown> = {}) => ({
    id: 'c-1',
    companyId: 'osd',
    customerId: 'cus-1',
    contractNo: 'CTR-1',
    title: 'บริการดูแลระบบ',
    endOn: day('2026-12-15'),
    value: { toString: () => '480000' },
    ownerUserId: 'sales-1',
    ownerOrgUnitId: 'ou-sales',
    renewalOpportunityId: null,
    remindedDays: [] as number[],
    ...overrides,
  });

  function harness(options: {
    past?: unknown[];
    toOpen?: unknown[];
    due?: unknown[];
    /** CD-53 — the company's saved `contract.renewal` rule, if any. */
    rule?: { enabled: boolean; params: Record<string, unknown> };
    renewalStage?: 'open' | 'won' | 'lost';
    claim?: number;
    createFails?: boolean;
  }) {
    const updates: Record<string, unknown>[] = [];
    const notices: string[] = [];
    const contracts = {
      findMany: jest.fn((args: { where: Record<string, unknown> }) => {
        const where = args.where;
        if ('lt' in (where.endOn as object))
          return Promise.resolve(options.past ?? []);
        if ('renewalCreatedAt' in where)
          return Promise.resolve(options.toOpen ?? []);
        return Promise.resolve(options.due ?? []);
      }),
      updateMany: jest.fn((args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return Promise.resolve({ count: options.claim ?? 1 });
      }),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return Promise.resolve({});
      }),
    };
    const stage = options.renewalStage ?? 'open';
    const opportunities = {
      findFirst: jest.fn((args: { where: { stage: unknown } }) => {
        const wanted = args.where.stage;
        const matches = wanted === 'won' ? stage === 'won' : stage === 'open';
        return Promise.resolve(
          matches ? { id: 'opp-r', opportunityCode: 'OPP-OSD-0099' } : null,
        );
      }),
    };
    const deals = {
      createRenewal: jest.fn(() =>
        options.createFails
          ? Promise.reject(new Error('run number down'))
          : Promise.resolve({ id: 'opp-r', opportunityCode: 'OPP-OSD-0099' }),
      ),
    };
    const notifications = {
      contractRenewalOpened: jest.fn(() => {
        notices.push('opened');
        return Promise.resolve();
      }),
      contractRenewalDue: jest.fn((...args: unknown[]) => {
        notices.push(`due:${String(args[4])}`);
        return Promise.resolve();
      }),
    };
    const service = new ContractRenewalService(
      contracts as never,
      opportunities as never,
      deals as never,
      notifications as never,
      new NotificationRulesService({
        notificationRule: {
          findMany: jest.fn(() =>
            Promise.resolve(
              options.rule ? [{ companyId: 'osd', ...options.rule }] : [],
            ),
          ),
        },
      } as never),
      { get: jest.fn(() => 0) } as never,
    );
    return { service, updates, notices, deals, contracts };
  }

  it('CD-70: within 90 days a renewal deal opens under the contract owner, and the owner is told', async () => {
    const h = harness({ toOpen: [contract()] });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ opened: 1 });
    expect(h.deals.createRenewal).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus-1',
        title: 'ต่ออายุ: บริการดูแลระบบ',
        amount: 480000,
        ownerUserId: 'sales-1',
        expectedCloseAt: day('2026-12-15'),
      }),
    );
    expect(h.updates).toEqual([
      { renewalCreatedAt: NOW },
      { renewalOpportunityId: 'opp-r', remindedDays: [] },
    ]);
    expect(h.notices).toEqual(['opened']);
  });

  it('a failed deal releases the claim so the next tick tries again', async () => {
    const h = harness({ toOpen: [contract()], createFails: true });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ opened: 0 });
    expect(h.updates.at(-1)).toEqual({ renewalCreatedAt: null });
  });

  it('CD-70: 60 and 30 days out the owner is reminded while the renewal deal is open', async () => {
    const at60 = contract({
      renewalOpportunityId: 'opp-r',
      endOn: day('2026-11-28'),
    });
    const h60 = harness({ due: [at60] });
    await expect(h60.service.sweep(NOW)).resolves.toMatchObject({
      reminded: 1,
    });
    expect(h60.notices).toEqual(['due:60']);

    // first seen inside 30 days: one reminder, not the 60-day one on top
    const at30 = contract({
      renewalOpportunityId: 'opp-r',
      endOn: day('2026-10-29'),
    });
    const h30 = harness({ due: [at30] });
    await expect(h30.service.sweep(NOW)).resolves.toMatchObject({
      reminded: 1,
    });
    expect(h30.notices).toEqual(['due:30']);
    expect(h30.updates).toEqual([{ remindedDays: [60, 30] }]);

    // a step already sent is not sent again
    const again = harness({
      due: [contract({ ...at30, remindedDays: [60, 30] })],
    });
    await expect(again.service.sweep(NOW)).resolves.toMatchObject({
      reminded: 0,
    });
  });

  it('CD-53: the days are the company rule — opened at its own window, reminded at its own steps', async () => {
    const rule = {
      enabled: true,
      params: { open_days: 120, remind_days: [45] },
    };
    // 100 days out: outside the standard 90, inside this company's 120
    const far = contract({ endOn: day('2027-01-07') });
    const h = harness({ toOpen: [far], rule });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ opened: 1 });
    const openQuery = (
      h.contracts.findMany.mock.calls as unknown as [
        { where: Record<string, unknown> },
      ][]
    ).find(([args]) => 'renewalCreatedAt' in args.where)![0];
    expect(openQuery.where.endOn).toEqual({
      gte: day('2026-09-29'),
      lte: day('2027-01-27'),
    });

    // 60 days out: the standard would remind, this company waits for 45
    const at60 = contract({
      renewalOpportunityId: 'opp-r',
      endOn: day('2026-11-28'),
    });
    const quiet = harness({ due: [at60], rule });
    await expect(quiet.service.sweep(NOW)).resolves.toMatchObject({
      reminded: 0,
    });
  });

  it('CD-53: a company that switched the rule off gets no renewal deals and no reminders', async () => {
    const rule = {
      enabled: false,
      params: { open_days: 90, remind_days: [60, 30] },
    };
    const h = harness({
      toOpen: [contract()],
      due: [
        contract({ renewalOpportunityId: 'opp-r', endOn: day('2026-10-29') }),
      ],
      rule,
    });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({
      opened: 0,
      reminded: 0,
    });
    expect(h.deals.createRenewal).not.toHaveBeenCalled();
  });

  it('a renewal opened late marks the reminders already covered by its notice', async () => {
    const late = contract({ endOn: day('2026-10-20') }); // 21 days out
    const h = harness({ toOpen: [late] });
    await h.service.sweep(NOW);
    expect(h.updates[1]).toEqual({
      renewalOpportunityId: 'opp-r',
      remindedDays: [60, 30],
    });
  });

  it('a won or lost renewal deal gets no reminder', async () => {
    const renewing = contract({ renewalOpportunityId: 'opp-r' });
    const h = harness({
      due: [contract({ ...renewing, endOn: day('2026-11-28') })],
      renewalStage: 'won',
    });
    await expect(h.service.sweep(NOW)).resolves.toMatchObject({ reminded: 0 });
    expect(h.notices).toEqual([]);
  });

  it('CD-70: past the end date — renewed when its renewal deal was won, ended otherwise', async () => {
    const won = harness({
      past: [
        contract({ renewalOpportunityId: 'opp-r', endOn: day('2026-09-01') }),
      ],
      renewalStage: 'won',
    });
    await won.service.sweep(NOW);
    expect(won.updates[0]).toEqual({ status: 'renewed' });

    const lapsed = harness({ past: [contract({ endOn: day('2026-09-01') })] });
    await lapsed.service.sweep(NOW);
    expect(lapsed.updates[0]).toEqual({ status: 'ended' });
  });
});

describe('CD-70 contracts by hand', () => {
  const me = {
    userId: 'u-1',
    orgUnitId: 'ou-1',
    activeCompanyId: 'osd',
    displayName: 'x',
    ledUnitIds: [],
    permissions: [
      'crm.customer.manage',
      'crm.customer.read',
      'crm.customer.read.all',
    ],
  } as unknown as Principal;

  function harness(taken = false) {
    const created: Record<string, unknown>[] = [];
    const service = new ContractsService(
      {
        findFirst: jest.fn(() => Promise.resolve(taken ? { id: 'c-0' } : null)),
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return Promise.resolve({
            id: 'c-1',
            contractNo: args.data.contractNo,
          });
        }),
      } as never,
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            id: 'cus-1',
            companyId: 'osd',
            accountOwnerUserId: 'owner-1',
            ownerOrgUnitId: 'ou-own',
          }),
        ),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      { on: jest.fn() } as never,
      { publish: jest.fn(() => Promise.resolve()) } as never,
      { record: jest.fn(() => Promise.resolve()) } as never,
      {
        execute: jest.fn((work: (p: unknown) => unknown) => work({})),
      } as never,
      { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) } as never,
    );
    return { service, created };
  }

  it('an old contract is entered under the customer’s account owner', async () => {
    const { service, created } = harness();
    await service.create(
      'cus-1',
      {
        contract_no: 'CTR-2566-0012',
        title: 'MA',
        end_on: '2026-12-31',
        value: 120000,
      },
      me,
    );
    expect(created[0]).toMatchObject({
      contractNo: 'CTR-2566-0012',
      endOn: day('2026-12-31'),
      ownerUserId: 'owner-1',
    });
  });

  it('refuses a missing end date, a start after the end, and a number already used', async () => {
    const { service } = harness();
    await expect(
      service.create('cus-1', { contract_no: 'X', title: 'x' }, me),
    ).rejects.toThrow('วันสิ้นสุด');
    await expect(
      service.create(
        'cus-1',
        {
          contract_no: 'X',
          title: 'x',
          start_on: '2027-01-01',
          end_on: '2026-01-01',
        },
        me,
      ),
    ).rejects.toThrow('วันเริ่ม');
    await expect(
      harness(true).service.create(
        'cus-1',
        { contract_no: 'X', title: 'x', end_on: '2026-12-31' },
        me,
      ),
    ).rejects.toThrow('มีอยู่แล้ว');
  });
});
