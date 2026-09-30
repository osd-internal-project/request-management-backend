import type { Principal } from '@request-management/share';
import { RisksService } from './risks.service';

const presales = {
  userId: 'ps-1',
  activeCompanyId: 'osd',
  permissions: ['presales.solution.manage'],
} as unknown as Principal;
const seller = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  permissions: ['crm.sales.read', 'crm.sales.manage'],
} as unknown as Principal;

const ROW = {
  id: 'r-1',
  title: 'อุปกรณ์ขาดตลาด',
  likelihood: 4,
  impact: 5,
  status: 'open',
};

function harness(item: Record<string, unknown> | null = ROW) {
  const manage = (actor: Principal) =>
    actor.permissions.includes('presales.solution.manage');
  const solutions = {
    requireManageable: jest.fn((_: string, actor: Principal) =>
      manage(actor)
        ? Promise.resolve({ id: 'sol-1', companyId: 'osd' })
        : Promise.reject(Object.assign(new Error('x'), { code: 'FORBIDDEN' })),
    ),
    findOne: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
  };
  const risks = {
    count: jest.fn(() => Promise.resolve(0)),
    findFirst: jest.fn((args: { select?: unknown }) =>
      Promise.resolve(args.select ? { seq: 3 } : item),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'r-9', seq: 4 })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new RisksService(
    solutions as never,
    risks as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
  );
  return { service, risks, audit };
}

const dataOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-141 risks', () => {
  it('CD-141: a risk is numbered after the last one, removed ones included', async () => {
    const { service, risks, audit } = harness();
    await service.add(
      'sol-1',
      {
        title: ' อุปกรณ์ขาดตลาด ',
        likelihood: 4,
        impact: 5,
        owner: ' จัดซื้อ ',
      },
      presales,
    );
    expect(dataOf(risks.create)).toMatchObject({
      seq: 4,
      title: 'อุปกรณ์ขาดตลาด',
      likelihood: 4,
      impact: 5,
      owner: 'จัดซื้อ',
      mitigation: '',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'presales.solution.risk_added' }),
      { prisma: {} },
    );
  });

  it('a risk is re-scored, planned and closed by update', async () => {
    const { service, risks } = harness();
    await service.update(
      'sol-1',
      'r-1',
      { impact: 2, mitigation: ' สั่งล่วงหน้า ', status: 'mitigated' },
      presales,
    );
    expect(dataOf(risks.update)).toEqual({
      impact: 2,
      mitigation: 'สั่งล่วงหน้า',
      status: 'mitigated',
      updatedBy: 'ps-1',
    });
  });

  it('ROLE-01: sales read the register but do not write it', async () => {
    await expect(
      harness().service.add(
        'sol-1',
        { title: 'x', likelihood: 1, impact: 1 },
        seller,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('removal is a soft delete; an unknown risk is 404', async () => {
    const { service, risks } = harness();
    await service.remove('sol-1', 'r-1', presales);
    expect(dataOf(risks.update)).toHaveProperty('deletedAt');
    await expect(
      harness(null).service.remove('sol-1', 'nope', presales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
