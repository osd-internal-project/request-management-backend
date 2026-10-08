import type { Principal } from '@request-management/share';
import { SmartKeeperService } from './smart-keeper.service';

const ops = {
  userId: 'u-ops',
  username: 'ops',
  displayName: 'ทีม AI SMART',
  isServiceAccount: false,
  activeCompanyId: 'osd',
} as unknown as Principal;

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  companyId: 'osd',
  name: 'บริษัท ลูกค้าเดิม จำกัด',
  status: 'screened',
  sourceId: 'src-1',
  matchKind: 'customer',
  matchCustomerId: 'c-1',
  keeperOpportunityId: null,
  lastCallId: 'call-1',
  score: 70,
  ...overrides,
});

function harness(
  options: {
    row?: Record<string, unknown> | null;
    customer?: Record<string, unknown> | null;
    units?: Record<string, string | null>;
    keeperTeam?: string | null;
    call?: Record<string, unknown> | null;
  } = {},
) {
  const prospects = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.row === undefined ? prospect() : options.row),
    ),
    update: jest.fn(() => Promise.resolve({})),
  };
  const calls = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.call === undefined
          ? {
              summary: 'สนใจขยายอีก 2 สาขา',
              outcome: 'interested',
              startedAt: new Date('2026-10-08'),
            }
          : options.call,
      ),
    ),
  };
  const customers = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.customer === undefined
          ? {
              id: 'c-1',
              nameTh: 'บริษัท ลูกค้าเดิม จำกัด',
              accountOwnerUserId: 'u-owner',
              ownerOrgUnitId: 'unit-sales',
            }
          : options.customer,
      ),
    ),
  };
  const touchpoints = { create: jest.fn(() => Promise.resolve({ id: 't-1' })) };
  const opportunities = {
    create: jest.fn(() =>
      Promise.resolve({ id: 'opp-1', opportunityCode: 'OPP-9' }),
    ),
  };
  const opportunityRows = { update: jest.fn(() => Promise.resolve({})) };
  const orgUnits = {
    findFirst: jest.fn((args: { where: { id: string } }) =>
      Promise.resolve({
        managerUserId: options.units?.[args.where.id] ?? null,
      }),
    ),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({ smartKeeperOrgUnitId: options.keeperTeam ?? null }),
    ),
  };
  const timeline = { publish: jest.fn(() => Promise.resolve()) };
  const notifications = {
    smartKeeperInterest: jest.fn(() => Promise.resolve()),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new SmartKeeperService(
    prospects as never,
    calls as never,
    customers as never,
    touchpoints as never,
    opportunities as never,
    opportunityRows as never,
    orgUnits as never,
    configs as never,
    timeline as never,
    notifications as never,
    audit as never,
  );
  return {
    service,
    prospects,
    touchpoints,
    opportunities,
    opportunityRows,
    timeline,
    notifications,
  };
}

const dataOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-294 an existing customer interested in more → its account owner', () => {
  it('logs the call on the customer, opens an upsell deal for the owner, and tells them', async () => {
    const h = harness();
    const [result] = await h.service.send(ops, ['p-1']);
    expect(result).toMatchObject({
      outcome: 'sent',
      opportunity_id: 'opp-1',
      owner_user_id: 'u-owner',
    });
    expect(dataOf(h.touchpoints.create)).toMatchObject({
      customerId: 'c-1',
      type: 'call',
      summary: 'AI SMART: สนใจขยายอีก 2 สาขา',
    });
    expect(h.timeline.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'c-1',
        eventType: 'customer.contacted',
      }),
    );
    expect(h.opportunities.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'c-1', deal_type: 'upsell' }),
      ops,
    );
    expect(dataOf(h.opportunityRows.update)).toMatchObject({
      ownerUserId: 'u-owner',
      ownerOrgUnitId: 'unit-sales',
    });
    expect(h.notifications.smartKeeperInterest).toHaveBeenCalledWith(
      'u-owner',
      'osd',
      expect.objectContaining({
        opportunityCode: 'OPP-9',
        summary: 'สนใจขยายอีก 2 สาขา',
      }),
    );
    expect(dataOf(h.prospects.update)).toMatchObject({
      keeperOpportunityId: 'opp-1',
      handoffAxis: 'keeper',
    });
  });

  it('no owner → the head of the customer’s team; else the Keeper team’s head', async () => {
    const teamHead = harness({
      customer: {
        id: 'c-1',
        nameTh: 'x',
        accountOwnerUserId: null,
        ownerOrgUnitId: 'unit-sales',
      },
      units: { 'unit-sales': 'u-head' },
    });
    await expect(teamHead.service.send(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ owner_user_id: 'u-head' }),
    ]);
    const keeperHead = harness({
      customer: {
        id: 'c-1',
        nameTh: 'x',
        accountOwnerUserId: null,
        ownerOrgUnitId: null,
      },
      keeperTeam: 'unit-keeper',
      units: { 'unit-keeper': 'u-keeper-head' },
    });
    await expect(keeperHead.service.send(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ owner_user_id: 'u-keeper-head' }),
    ]);
  });

  it('with no one to give it to, nothing is created and the reason is given', async () => {
    const h = harness({
      customer: {
        id: 'c-1',
        nameTh: 'x',
        accountOwnerUserId: null,
        ownerOrgUnitId: null,
      },
    });
    const [result] = await h.service.send(ops, ['p-1']);
    expect(result.outcome).toBe('skipped');
    expect(h.opportunities.create).not.toHaveBeenCalled();
    expect(h.touchpoints.create).not.toHaveBeenCalled();
  });

  it('sent from the queue with no call, the timeline records it (no call touchpoint)', async () => {
    const h = harness({ row: prospect({ lastCallId: null }), call: null });
    await h.service.send(ops, ['p-1']);
    expect(h.touchpoints.create).not.toHaveBeenCalled();
    expect(h.timeline.publish).toHaveBeenCalled();
    expect(h.opportunities.create).toHaveBeenCalled();
  });

  it('only an existing customer, only once', async () => {
    const notCustomer = harness({ row: prospect({ matchKind: 'none' }) });
    await expect(notCustomer.service.send(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ outcome: 'skipped' }),
    ]);
    const again = harness({ row: prospect({ keeperOpportunityId: 'opp-0' }) });
    await expect(again.service.send(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ outcome: 'skipped', opportunity_id: 'opp-0' }),
    ]);
    expect(again.opportunities.create).not.toHaveBeenCalled();
  });

  it('a deal that cannot be opened leaves nothing half-written', async () => {
    const h = harness();
    h.opportunities.create.mockRejectedValueOnce(
      new Error('no document number'),
    );
    await expect(h.service.send(ops, ['p-1'])).rejects.toThrow(
      'no document number',
    );
    expect(h.touchpoints.create).not.toHaveBeenCalled();
    expect(h.timeline.publish).not.toHaveBeenCalled();
    expect(h.prospects.update).not.toHaveBeenCalled();
  });
});
