import type { Principal } from '@request-management/share';
import { RequirementsService } from './requirements.service';

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
const viewer = {
  userId: 'v-1',
  activeCompanyId: 'osd',
  permissions: ['crm.sales.read'],
} as unknown as Principal;

const ITEM = {
  id: 'r-1',
  solutionId: 'sol-1',
  kind: 'technical',
  text: 'เชื่อมต่อ firewall เดิม',
  assessment: 'needs_info',
  note: 'firewall ยี่ห้อไหน',
  customerAnswer: null,
};

function harness(item: Record<string, unknown> | null = ITEM) {
  const manage = (actor: Principal) =>
    actor.permissions.includes('presales.solution.manage');
  const solutions = {
    requireManageable: jest.fn((_: string, actor: Principal) =>
      manage(actor)
        ? Promise.resolve({ id: 'sol-1', companyId: 'osd' })
        : Promise.reject(Object.assign(new Error('x'), { code: 'FORBIDDEN' })),
    ),
    requireReadable: jest.fn(() =>
      Promise.resolve({ id: 'sol-1', companyId: 'osd' }),
    ),
    canManage: jest.fn(manage),
    canAnswerAsSales: jest.fn((actor: Principal) =>
      actor.permissions.includes('crm.sales.manage'),
    ),
    findOne: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
  };
  const requirements = {
    count: jest.fn(() => Promise.resolve(0)),
    findFirst: jest.fn((args: { select?: unknown }) =>
      Promise.resolve(args.select ? { seq: 4 } : item),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'r-9', seq: 5 })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new RequirementsService(
    solutions as never,
    requirements as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
  );
  return { service, requirements, audit };
}

const dataOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-131 requirement analysis', () => {
  it('CD-131: an item is numbered after the last one, removed ones included', async () => {
    const { service, requirements, audit } = harness();
    await service.add(
      'sol-1',
      { kind: 'business', text: '  ลดค่าวงจรลง 20%  ' },
      presales,
    );
    expect(dataOf(requirements.create)).toMatchObject({
      seq: 5,
      kind: 'business',
      text: 'ลดค่าวงจรลง 20%',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'presales.solution.requirement_added',
      }),
      { prisma: {} },
    );
  });

  it('a question to the customer must say what is asked', async () => {
    const { service } = harness({
      ...ITEM,
      assessment: 'unassessed',
      note: '',
    });
    await expect(
      service.update('sol-1', 'r-1', { assessment: 'needs_info' }, presales),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('asking a new question clears the old answer; re-assessing keeps it', async () => {
    const answered = { ...ITEM, customerAnswer: 'Fortinet' };
    const first = harness(answered);
    await first.service.update(
      'sol-1',
      'r-1',
      { note: 'รุ่นและ firmware เท่าไร' },
      presales,
    );
    expect(dataOf(first.requirements.update)).toMatchObject({
      customerAnswer: null,
      answeredAt: null,
    });

    const second = harness(answered);
    await second.service.update(
      'sol-1',
      'r-1',
      { assessment: 'feasible' },
      presales,
    );
    expect(dataOf(second.requirements.update)).not.toHaveProperty(
      'customerAnswer',
    );
  });

  it('the salesperson on the deal records the customer answer', async () => {
    const { service, requirements, audit } = harness();
    await service.answer('sol-1', 'r-1', { answer: ' Fortinet 100F ' }, seller);
    expect(dataOf(requirements.update)).toMatchObject({
      customerAnswer: 'Fortinet 100F',
      answeredBy: 'sales-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'presales.solution.requirement_answered',
      }),
      { prisma: {} },
    );
  });

  it('ROLE-01: a read-only viewer cannot answer, and nobody edits the analysis without presales', async () => {
    await expect(
      harness().service.answer('sol-1', 'r-1', { answer: 'x' }, viewer),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      harness().service.add('sol-1', { kind: 'business', text: 'x' }, seller),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('only an item that asks can be answered', async () => {
    const { service } = harness({ ...ITEM, assessment: 'feasible' });
    await expect(
      service.answer('sol-1', 'r-1', { answer: 'x' }, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('removal is a soft delete', async () => {
    const { service, requirements } = harness();
    await service.remove('sol-1', 'r-1', presales);
    expect(dataOf(requirements.update)).toHaveProperty('deletedAt');
  });
});
