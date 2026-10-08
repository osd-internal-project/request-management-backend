import type { Principal } from '@request-management/share';
import { SmartHandoffService } from './smart-handoff.service';

const ops = {
  userId: 'u-ops',
  username: 'ops',
  isServiceAccount: false,
  activeCompanyId: 'osd',
} as unknown as Principal;

const prospect = (overrides: Record<string, unknown> = {}) => ({
  id: 'p-1',
  companyId: 'osd',
  name: 'บริษัท สนใจ จำกัด',
  status: 'screened',
  salesAxis: 'getter',
  matchKind: 'none',
  leadId: null,
  sentOutcome: null,
  handoffRequestId: null,
  handedOffAt: null,
  lastCallId: 'call-1',
  interestedAt: new Date('2026-10-07'),
  score: 80,
  phone: '021234567',
  ...overrides,
});

function harness(
  options: {
    row?: Record<string, unknown> | null;
    typeCode?: string | null;
    sendOutcome?: string;
    submitFails?: boolean;
  } = {},
) {
  const prospects = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.row === undefined ? prospect() : options.row),
    ),
    update: jest.fn(() => Promise.resolve({})),
  };
  const lists = {
    findFirst: jest.fn(() => Promise.resolve({ createdBy: 'u-author' })),
  };
  const calls = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        outcome: 'interested',
        summary: 'สนใจกล้อง',
        startedAt: new Date(),
      }),
    ),
  };
  const leads = { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        smartHandoffTypeCode:
          options.typeCode === undefined ? 'SLH' : options.typeCode,
        smartGetterOrgUnitId: 'team-getter',
        smartGovernmentOrgUnitId: 'team-gov',
        smartPartnerOrgUnitId: null,
      }),
    ),
  };
  const people = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'u-author',
        keycloakId: 'k',
        username: 'author',
        displayName: 'ผู้สร้างรายการ',
        email: null,
        orgUnitId: null,
        supervisorUserId: null,
        companies: [],
      }),
    ),
  };
  const screening = {
    send: jest.fn(() =>
      Promise.resolve([
        {
          id: 'p-1',
          name: 'x',
          outcome: options.sendOutcome ?? 'created',
          lead_id: 'lead-1',
        },
      ]),
    ),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-1' })),
    submit: jest.fn(() =>
      options.submitFails
        ? Promise.reject(new Error('no receiver'))
        : Promise.resolve({}),
    ),
    cancel: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const keeper = {
    one: jest.fn(() =>
      Promise.resolve({
        id: 'p-1',
        name: 'x',
        outcome: 'sent',
        opportunity_id: 'opp-1',
      }),
    ),
  };
  const service = new SmartHandoffService(
    prospects as never,
    lists as never,
    calls as never,
    leads as never,
    configs as never,
    people as never,
    screening as never,
    requests as never,
    audit as never,
    keeper as never,
  );
  return { service, prospects, leads, screening, requests, audit, keeper };
}

describe('CD-293 an interested prospect to its sales axis', () => {
  it('makes the Lead, gives it to the axis team, and raises the handoff request', async () => {
    const h = harness();
    const [result] = await h.service.handOff(ops, ['p-1']);
    expect(result).toMatchObject({
      outcome: 'handed_off',
      axis: 'getter',
      lead_id: 'lead-1',
      request_id: 'req-1',
    });
    // only an unowned Lead moves to the team
    expect(h.leads.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'lead-1', companyId: 'osd', ownerUserId: null },
        data: expect.objectContaining({
          ownerOrgUnitId: 'team-getter',
        }) as unknown,
      }),
    );
    expect(h.requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'SLH',
        ref_type: 'lead',
        ref_id: 'lead-1',
        form_data: expect.objectContaining({
          call_summary: 'สนใจกล้อง',
          sales_axis: 'getter',
        }) as unknown,
      }),
      ops,
    );
    expect(h.requests.submit).toHaveBeenCalledWith('req-1', ops, '');
  });

  it('a staff override sends it to another axis', async () => {
    const h = harness();
    const [result] = await h.service.handOff(ops, ['p-1'], 'government');
    expect(result.axis).toBe('government');
    expect(h.leads.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ownerOrgUnitId: 'team-gov',
        }) as unknown,
      }),
    );
  });

  it('with no handoff type set, the Lead is made and the reason says so', async () => {
    const h = harness({ typeCode: null });
    const [result] = await h.service.handOff(ops, ['p-1']);
    expect(result).toMatchObject({ outcome: 'lead_only', request_id: null });
    expect(h.requests.create).not.toHaveBeenCalled();
  });

  it('an existing customer goes to its account owner (CD-294), not an axis', async () => {
    const matched = harness({ row: prospect({ matchKind: 'customer' }) });
    await expect(matched.service.handOff(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ outcome: 'customer', axis: 'keeper' }),
    ]);
    expect(matched.keeper.one).toHaveBeenCalledWith(ops, 'p-1');
    expect(matched.screening.send).not.toHaveBeenCalled();
    const viaScreening = harness({ sendOutcome: 'customer' });
    await expect(viaScreening.service.handOff(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ outcome: 'customer', axis: 'keeper' }),
    ]);
    expect(viaScreening.requests.create).not.toHaveBeenCalled();
  });

  it('a row already handed off, discarded or unscreened is skipped', async () => {
    for (const row of [
      prospect({ handoffRequestId: 'req-0' }),
      prospect({ status: 'discarded' }),
      prospect({ status: 'new' }),
    ]) {
      const h = harness({ row });
      const [result] = await h.service.handOff(ops, ['p-1']);
      expect(result.outcome).toBe('skipped');
      expect(h.screening.send).not.toHaveBeenCalled();
    }
  });

  it('CD-294: an existing customer found interested on a call reaches its owner automatically', async () => {
    const h = harness({ row: prospect({ matchKind: 'customer' }) });
    await h.service.afterInterest('osd', 'p-1', 'l-1');
    expect(h.keeper.one).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-author' }),
      'p-1',
    );
  });

  it('a Lead-only handoff is redone only to raise the request, once a type is set', async () => {
    const noType = harness({
      typeCode: null,
      row: prospect({ handedOffAt: new Date(), leadId: 'lead-1' }),
    });
    await expect(noType.service.handOff(ops, ['p-1'])).resolves.toEqual([
      expect.objectContaining({ outcome: 'skipped' }),
    ]);
    const typeSet = harness({
      row: prospect({
        handedOffAt: new Date(),
        leadId: 'lead-1',
        sentOutcome: 'created',
      }),
    });
    const [result] = await typeSet.service.handOff(ops, ['p-1']);
    expect(result).toMatchObject({
      outcome: 'handed_off',
      request_id: 'req-1',
    });
    // the Lead it already had, not a second one
    expect(typeSet.screening.send).not.toHaveBeenCalled();
  });

  it('a failed submit cancels the draft; after a call the failure is kept on the prospect', async () => {
    const h = harness({ submitFails: true });
    await h.service.afterInterest('osd', 'p-1', 'l-1');
    expect(h.requests.cancel).toHaveBeenCalled();
    expect(h.prospects.update).toHaveBeenCalledWith({
      where: { id: 'p-1' },
      data: { handoffError: 'no receiver' },
    });
  });
});
