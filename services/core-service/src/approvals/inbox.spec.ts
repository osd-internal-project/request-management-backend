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
