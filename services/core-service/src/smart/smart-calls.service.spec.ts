import type { Principal } from '@request-management/share';
import { SmartCallsService } from './smart-calls.service';

const ops = {
  userId: 'u-ops',
  username: 'ops',
  isServiceAccount: false,
  activeCompanyId: 'osd',
} as unknown as Principal;

/** Wednesday 10:00 Bangkok. */
const NOW = new Date('2026-10-07T03:00:00Z');

function harness(
  options: {
    certified?: boolean;
    listStatus?: string;
    blocked?: string[];
  } = {},
) {
  const policy = {
    companyId: 'osd',
    windows: [{ day: 3, from: '09:00', to: '18:00' }],
    maxAttempts: 3,
    minGapDays: 3,
    openingScript: 'AI โทรจาก {company}',
    optOutScript: 'พูดว่า ไม่ต้องติดต่ออีก',
    certifiedBy: options.certified === false ? null : 'u-legal',
    certifiedAt: options.certified === false ? null : new Date('2026-10-01'),
    certifiedNote: null,
    updatedAt: new Date('2026-10-01'),
  };
  const policies = {
    findFirst: jest.fn(() => Promise.resolve(policy)),
    upsert: jest.fn(() => Promise.resolve({})),
    update: jest.fn(() => Promise.resolve({})),
  };
  const list = {
    id: 'l-1',
    companyId: 'osd',
    name: 'ตะวันออก',
    script: 'แนะนำระบบกล้อง',
    kbArticleIds: [],
    status: options.listStatus ?? 'active',
    createdAt: new Date(),
  };
  const lists = {
    findFirst: jest.fn(() => Promise.resolve(list)),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...list, ...args.data }),
    ),
  };
  const target = (
    id: string,
    phone: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    companyId: 'osd',
    listId: 'l-1',
    prospectId: `p-${id}`,
    name: id,
    phone,
    status: 'pending',
    attempts: 0,
    lastAttemptAt: null,
    ...extra,
  });
  const targets = {
    findMany: jest.fn(() =>
      Promise.resolve([
        target('a', '021111111'),
        target('b', '022222222'),
        target('c', '023333333', {
          attempts: 1,
          lastAttemptAt: new Date('2026-10-06'),
        }),
      ]),
    ),
    findFirst: jest.fn(() => Promise.resolve(target('a', '021111111'))),
    createMany: jest.fn((args: { data: unknown[] }) =>
      Promise.resolve({ count: args.data.length }),
    ),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const prospects = {
    findMany: jest.fn(() =>
      Promise.resolve([
        { id: 'p1', name: 'มีเบอร์', phone: '021111111', status: 'screened' },
        { id: 'p2', name: 'ไม่มีเบอร์', phone: null, status: 'screened' },
        { id: 'p3', name: 'ยังไม่คัดกรอง', phone: '024444444', status: 'new' },
        { id: 'p4', name: 'ห้ามโทร', phone: '022222222', status: 'sent' },
      ]),
    ),
  };
  const optOuts = {
    blockedPhones: jest.fn(() =>
      Promise.resolve(new Set(options.blocked ?? [])),
    ),
    add: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new SmartCallsService(
    policies as never,
    lists as never,
    targets as never,
    prospects as never,
    optOuts as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    { findFirst: jest.fn(() => Promise.resolve({ name: 'OSD' })) } as never,
    { findFirst: jest.fn(() => Promise.resolve({ holidays: [] })) } as never,
    audit as never,
    { execute: jest.fn((fn: (p: unknown) => unknown) => fn({})) } as never,
  );
  return { service, policies, lists, targets, optOuts, audit };
}

describe('CD-291 call lists and the checks before a call', () => {
  it('only targets passing every check are callable now', async () => {
    const h = harness({ blocked: ['022222222'] });
    const callable = await h.service.callable('osd', 'l-1', NOW);
    // b is on the register; c was tried yesterday (gap 3 days)
    expect(callable.map((row) => row.id)).toEqual(['a']);
  });

  it('nothing is callable while the policy is uncertified', async () => {
    const h = harness({ certified: false });
    await expect(h.service.callable('osd', 'l-1', NOW)).resolves.toEqual([]);
    const listed = await h.service.listTargets(ops, 'l-1', NOW);
    expect(listed[0]).toMatchObject({ hold: 'policy_uncertified' });
  });

  it('a list cannot be switched on before legal certifies the policy', async () => {
    const h = harness({ certified: false, listStatus: 'draft' });
    await expect(
      h.service.setStatus(ops, 'l-1', 'active'),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('saving the policy clears its certification; certifying records who', async () => {
    const h = harness();
    await h.service.savePolicy(ops, {
      windows: [{ day: 1, from: '09:00', to: '18:00' }],
      max_attempts: 3,
      min_gap_days: 3,
      opening_script: 'AI โทรจาก {company}',
      optout_script: 'พูดว่า ไม่ต้องติดต่ออีก',
    });
    const saved = (
      h.policies.upsert.mock.calls[0] as unknown as [
        { update: Record<string, unknown> },
      ]
    )[0].update;
    expect(saved).toMatchObject({ certifiedAt: null, certifiedBy: null });
    await h.service.certify(ops, 'ตรวจแล้ว');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'smart.call_policy.certified' }),
      expect.anything(),
    );
  });

  it('adds screened rows with a phone; marks a register hit blocked; says why others were skipped', async () => {
    const h = harness({ blocked: ['022222222'] });
    const result = await h.service.addTargets(ops, 'l-1', [
      'p1',
      'p2',
      'p3',
      'p4',
    ]);
    expect(result).toMatchObject({ added: 2, blocked: 1 });
    expect(result.skipped.map((row) => row.id)).toEqual(['p2', 'p3']);
    const data = (
      h.targets.createMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown>[] },
      ]
    )[0].data;
    expect(data[1]).toMatchObject({
      status: 'blocked',
      blockReason: 'do_not_contact',
    });
  });

  it('a refusal joins the register and stops the number on every list', async () => {
    const h = harness();
    await h.service.refuse('osd', 'a', null);
    expect(h.optOuts.add).toHaveBeenCalledWith(
      'osd',
      expect.objectContaining({
        kind: 'phone',
        value: '021111111',
        channel: 'call',
        source: 'call_refusal',
      }),
      null,
    );
    expect(h.targets.updateMany).toHaveBeenCalledWith({
      where: { companyId: 'osd', phone: '021111111', status: 'pending' },
      data: { status: 'blocked', blockReason: 'do_not_contact' },
    });
  });

  it('the opening names the company and ends with how to refuse', async () => {
    const h = harness();
    await expect(h.service.script(ops, 'l-1')).resolves.toMatchObject({
      opening: 'AI โทรจาก OSD พูดว่า ไม่ต้องติดต่ออีก',
    });
  });
});
