import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';

const OSD = 'company-osd';

describe('APV inbox — the same reach as the อนุมัติ tab', () => {
  it('includes cases a scope grant reaches, not only steps that name the person', async () => {
    const search = jest.fn<Promise<unknown[]>, [{ OR: unknown[] }, unknown]>(
      () => Promise.resolve([]),
    );
    const service = new ApprovalsService(
      { search, countWhere: jest.fn(() => Promise.resolve(0)) } as never,
      { delegatorsFor: jest.fn(() => Promise.resolve([])) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        stop: jest.fn(() => Promise.resolve()),
        resume: jest.fn(() => Promise.resolve()),
        pause: jest.fn(() => Promise.resolve()),
        dueAfter: jest.fn(() => Promise.resolve(null)),
      } as never, // sla
    );

    await service.inbox(
      {
        userId: 'user-lead',
        activeCompanyId: OSD,
        permissions: ['approval.decide'],
        scopeGrants: [],
        ledUnitIds: [],
        // Only the fields these paths read.
      } as unknown as Principal,
      {} as never,
    );

    const where = search.mock.calls[0][0];
    expect(where.OR).toHaveLength(2);
    expect(where.OR[1]).toHaveProperty('request');
  });
});

describe('SCOPE-02 opening one case needs a reason, not just approval.decide', () => {
  function serviceWhere(reachable: number) {
    const countWhere = jest.fn<Promise<number>, [{ id: string; OR: unknown[] }]>(
      () => Promise.resolve(reachable),
    );
    const found = { id: 'case-1', companyId: OSD, steps: [] };
    const service = new ApprovalsService(
      { findWithSteps: jest.fn(() => Promise.resolve(found)), countWhere } as never,
      { delegatorsFor: jest.fn(() => Promise.resolve([])) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, countWhere, found };
  }

  const approver = {
    userId: 'user-x',
    activeCompanyId: OSD,
    permissions: ['approval.decide'],
    scopeGrants: [],
    ledUnitIds: [],
  } as unknown as Principal;

  it('answers 404 for a case no step names them on and whose request they cannot see', async () => {
    const { service } = serviceWhere(0);

    await expect(service.findOne('case-1', approver)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('opens a case reached by a step, a past decision, or the request', async () => {
    const { service, countWhere, found } = serviceWhere(1);

    await expect(service.findOne('case-1', approver)).resolves.toBe(found);

    const where = countWhere.mock.calls[0][0];
    expect(where.id).toBe('case-1');
    expect(where.OR).toHaveLength(3);
    expect(where.OR[1]).toEqual({
      steps: { some: { decidedByUserId: 'user-x' } },
    });
    expect(where.OR[2]).toHaveProperty('request');
  });
});
