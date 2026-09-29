import type { Principal } from '@request-management/share';
import { ClarificationsService } from './clarifications.service';

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
  id: 'c-1',
  solutionId: 'sol-1',
  question: 'ใช้ firewall ยี่ห้อไหน',
  answer: null,
  answerRecordedAt: null,
  answeredOnVersionNo: null,
  affectsScope: false,
  scopeResolvedVersionNo: null,
};

function harness(
  options: {
    item?: Record<string, unknown> | null;
    version?: Record<string, unknown> | null;
  } = {},
) {
  const manage = (actor: Principal) =>
    actor.permissions.includes('presales.solution.manage');
  const solutions = {
    requireReadable: jest.fn(() =>
      Promise.resolve({ id: 'sol-1', companyId: 'osd', currentVersionNo: 2 }),
    ),
    requireManageable: jest.fn((_: string, actor: Principal) =>
      manage(actor)
        ? Promise.resolve({
            id: 'sol-1',
            companyId: 'osd',
            currentVersionNo: 2,
          })
        : Promise.reject(Object.assign(new Error('x'), { code: 'FORBIDDEN' })),
    ),
    canManage: jest.fn(manage),
    canAnswerAsSales: jest.fn((actor: Principal) =>
      actor.permissions.includes('crm.sales.manage'),
    ),
    findOne: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
  };
  const clarifications = {
    count: jest.fn(() => Promise.resolve(0)),
    findFirst: jest.fn((args: { select?: unknown }) =>
      Promise.resolve(
        args.select
          ? { seq: 6 }
          : options.item === undefined
            ? ITEM
            : options.item,
      ),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'c-9', seq: 7 })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const versions = {
    findFirst: jest.fn(() => Promise.resolve(options.version ?? null)),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new ClarificationsService(
    solutions as never,
    clarifications as never,
    versions as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
  );
  return { service, clarifications, audit };
}

const dataOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('CD-140 clarifications', () => {
  it('CD-140: the salesperson on the deal asks; the entry is numbered and dated', async () => {
    const { service, clarifications, audit } = harness();
    await service.ask(
      'sol-1',
      { question: ' มี UPS ทุกสาขาไหม ', asked_on: '2026-09-28' },
      seller,
    );
    expect(dataOf(clarifications.create)).toMatchObject({
      seq: 7,
      question: 'มี UPS ทุกสาขาไหม',
      askedOn: new Date('2026-09-28T00:00:00Z'),
      askedBy: 'sales-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'presales.solution.clarification_asked',
      }),
      { prisma: {} },
    );
  });

  it('an answer records the respondent, the day and the version it was given on', async () => {
    const { service, clarifications } = harness();
    await service.answer(
      'sol-1',
      'c-1',
      {
        answer: 'Fortinet 100F',
        respondent: 'คุณเอ · IT Manager',
        answered_on: '2026-09-29',
        affects_scope: true,
      },
      presales,
    );
    expect(dataOf(clarifications.update)).toMatchObject({
      answer: 'Fortinet 100F',
      respondent: 'คุณเอ · IT Manager',
      answeredOn: new Date('2026-09-29T00:00:00Z'),
      answeredOnVersionNo: 2,
      affectsScope: true,
      scopeResolvedVersionNo: null,
    });
  });

  it('ROLE-01: a read-only viewer writes nothing; only Pre-Sales closes or removes', async () => {
    await expect(
      harness().service.ask('sol-1', { question: 'x' }, viewer),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      harness().service.remove('sol-1', 'c-1', seller),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an answered question is not reworded', async () => {
    await expect(
      harness({ item: { ...ITEM, answer: 'ok' } }).service.edit(
        'sol-1',
        'c-1',
        { question: 'y' },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a scope change closes only on a version edited after the answer', async () => {
    const answered = {
      ...ITEM,
      answer: 'เพิ่มสาขาที่ 13',
      affectsScope: true,
      answerRecordedAt: new Date('2026-09-29T10:00:00Z'),
      answeredOnVersionNo: 2,
    };
    const stale = harness({
      item: answered,
      version: {
        versionNo: 2,
        status: 'locked',
        lockedAt: new Date('2026-09-29T09:00:00Z'),
      },
    });
    await expect(
      stale.service.resolveScope('sol-1', 'c-1', { version_no: 2 }, presales),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const draft = harness({
      item: answered,
      version: { versionNo: 3, status: 'draft', lockedAt: null },
    });
    await draft.service.resolveScope(
      'sol-1',
      'c-1',
      { version_no: 3 },
      presales,
    );
    expect(dataOf(draft.clarifications.update)).toMatchObject({
      scopeResolvedVersionNo: 3,
      scopeResolvedBy: 'ps-1',
    });

    await expect(
      harness({ item: ITEM }).service.resolveScope(
        'sol-1',
        'c-1',
        { version_no: 3 },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
