import { Readable } from 'node:stream';
import type { Principal } from '@request-management/share';
import { TorService } from './tor.service';

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

function harness(options: { clause?: Record<string, unknown> | null } = {}) {
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
    findOne: jest.fn(() => Promise.resolve({ id: 'sol-1' })),
  };
  const tors = { upsert: jest.fn(() => Promise.resolve({})) };
  const files = {
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(() => Promise.resolve({})),
    findFirst: jest.fn(() => Promise.resolve(null)),
    update: jest.fn(() => Promise.resolve({})),
  };
  const clauses = {
    count: jest.fn(() => Promise.resolve(0)),
    findFirst: jest.fn((args: { select?: unknown }) =>
      Promise.resolve(
        args.select
          ? { seq: 4 }
          : options.clause === undefined
            ? {
                clauseNo: '3.1',
                text: 'x',
                mandatory: true,
                compliance: 'unanswered',
              }
            : options.clause,
      ),
    ),
    createMany: jest.fn(() => Promise.resolve({ count: 1 })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const storage = {
    put: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve(Readable.from(['x']))),
    remove: jest.fn(() => Promise.resolve()),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new TorService(
    solutions as never,
    tors as never,
    files as never,
    clauses as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
    storage,
  );
  return { service, tors, files, clauses, storage };
}

const argOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [Record<string, unknown>])[0];

describe('CD-138 TOR / RFP', () => {
  it('CD-138: the TOR facts are upserted once per Solution', async () => {
    const { service, tors } = harness();
    await service.saveFacts(
      'sol-1',
      {
        buyer: ' กรมตัวอย่าง ',
        project_no: 'e-GP 123',
        submission_deadline: '2026-10-15T10:00:00+07:00',
      },
      presales,
    );
    expect(argOf(tors.upsert)).toMatchObject({
      where: { solutionId: 'sol-1' },
      create: {
        buyer: 'กรมตัวอย่าง',
        projectNo: 'e-GP 123',
        submissionDeadline: new Date('2026-10-15T03:00:00Z'),
      },
    });
    await expect(
      service.saveFacts('sol-1', { submission_deadline: 'soon' }, presales),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('pasted clauses are numbered after the last, mandatory by default', async () => {
    const { service, clauses } = harness();
    await service.addBulk(
      'sol-1',
      { text: '3.2.1 รองรับ 13 สาขา\n3.2.2 failover < 30s' },
      presales,
    );
    expect(argOf(clauses.createMany)).toMatchObject({
      data: [
        { seq: 5, clauseNo: '3.2.1', text: 'รองรับ 13 สาขา', mandatory: true },
        { seq: 6, clauseNo: '3.2.2', text: 'failover < 30s', mandatory: true },
      ],
    });
  });

  it('an answer is recorded on the clause', async () => {
    const { service, clauses } = harness();
    await service.updateClause(
      'sol-1',
      'c-1',
      {
        compliance: 'partial',
        response: ' รองรับ 10 สาขา ',
        reference: 'SOW 1',
      },
      presales,
    );
    expect(argOf(clauses.update)).toMatchObject({
      data: {
        compliance: 'partial',
        response: 'รองรับ 10 สาขา',
        reference: 'SOW 1',
      },
    });
  });

  it('a TOR file is stored under the Solution; the object is dropped if the row fails', async () => {
    const { service, storage, files } = harness();
    files.create.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.uploadFile(
        'sol-1',
        {
          originalname: 'TOR.pdf',
          mimetype: 'application/pdf',
          size: 5,
          buffer: Buffer.from('x'),
        },
        presales,
      ),
    ).rejects.toThrow('db down');
    const key = (storage.put.mock.calls[0] as unknown as [string])[0];
    expect(key).toMatch(/^solutions\/sol-1\/tor\/.+\/TOR\.pdf$/);
    expect(storage.remove).toHaveBeenCalledWith(key);
  });

  it('ROLE-01: sales read the TOR but do not write it', async () => {
    await expect(
      harness().service.addClause('sol-1', { text: 'x' }, seller),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an unknown clause is 404', async () => {
    await expect(
      harness({ clause: null }).service.removeClause('sol-1', 'nope', presales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
