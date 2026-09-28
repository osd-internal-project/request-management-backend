import type { Principal, PrismaService } from '@request-management/share';
import { SlaComplianceService } from './sla-compliance.service';

const OSD = 'company-osd';
const NOW = new Date('2026-09-28T03:00:00Z');
const HOUR = 3_600_000;

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-me',
    activeCompanyId: OSD,
    companies: [{ id: OSD, name: 'OSD', docPrefix: 'OSD', isPrimary: true }],
    ledUnitIds: [],
    permissions: ['report.request.read', 'request.read.all'],
    ...overrides,
  } as Principal;
}

const request = (team: string | null, type = 'SUP', completedAt?: Date) => ({
  typeCode: type,
  completedAt: completedAt ?? null,
  receiverOrgUnitId: team,
  requestType: { name: `ประเภท ${type}` },
});

/** Answers the three queries by what each one asks for. */
function harness(data: {
  finished?: unknown[];
  open?: unknown[];
  responded?: unknown[];
}) {
  const findMany = jest.fn((args: { where: Record<string, unknown> }) => {
    if ('respondedAt' in args.where)
      return Promise.resolve(data.responded ?? []);
    const state = args.where.state as { in: string[] };
    return Promise.resolve(
      state.in.includes('met') ? (data.finished ?? []) : (data.open ?? []),
    );
  });
  const prisma = {
    slaClock: { findMany },
    orgUnit: {
      findMany: jest.fn((args: { where: { id: { in: string[] } } }) =>
        Promise.resolve(
          args.where.id.in.map((id) => ({ id, name: `ทีม ${id}` })),
        ),
      ),
    },
  } as unknown as PrismaService;
  return { service: new SlaComplianceService(prisma), findMany };
}

describe('CD-50 SlaComplianceService', () => {
  const sept = new Date('2026-09-10T05:00:00Z');

  it('CD-50: on-time share per receiving team, worst first, with open overdue now', async () => {
    const { service } = harness({
      finished: [
        { state: 'met', request: request('ops', 'SUP', sept) },
        { state: 'met', request: request('ops', 'SUP', sept) },
        { state: 'breached', request: request('ops', 'SUP', sept) },
        { state: 'breached', request: request('it', 'SUP', sept) },
      ],
      open: [
        // running past due, not yet swept → overdue
        {
          state: 'running',
          dueAt: new Date(NOW.getTime() - HOUR),
          breachedAt: null,
          request: request('it'),
        },
        // paused, stale due date, never breached → on track
        {
          state: 'paused',
          dueAt: new Date(NOW.getTime() - HOUR),
          breachedAt: null,
          request: request('ops'),
        },
      ],
    });

    const report = await service.report({}, principal(), NOW);

    expect(report.group_by).toBe('team');
    expect(
      report.rows.map((row) => [row.key, row.label, row.compliance_pct]),
    ).toEqual([
      ['it', 'ทีม it', 0],
      ['ops', 'ทีม ops', 66.7],
    ]);
    expect(report.rows[0]).toMatchObject({ open_overdue: 1, open_on_track: 0 });
    expect(report.totals).toMatchObject({
      finished: 4,
      on_time: 2,
      late: 2,
      compliance_pct: 50,
      open_overdue: 1,
      open_on_track: 1,
    });
  });

  it('a team with nothing finished has no percentage rather than 0%', async () => {
    const { service } = harness({
      open: [
        {
          state: 'running',
          dueAt: new Date(NOW.getTime() + HOUR),
          breachedAt: null,
          request: request(null),
        },
      ],
    });
    const report = await service.report({}, principal(), NOW);
    expect(report.rows[0]).toMatchObject({
      key: null,
      label: 'ไม่ระบุทีมผู้รับ',
      compliance_pct: null,
      open_on_track: 1,
    });
  });

  it('month rows follow the Bangkok completion month and carry no open counts', async () => {
    const { service, findMany } = harness({
      finished: [
        // 30 Sep 20:00 UTC = 1 Oct 03:00 Bangkok
        {
          state: 'met',
          request: request('ops', 'SUP', new Date('2026-09-30T20:00:00Z')),
        },
        { state: 'breached', request: request('ops', 'SUP', sept) },
      ],
    });

    const report = await service.report(
      {
        group_by: 'month',
        from: '2026-09-01T00:00:00+07:00',
        to: '2026-10-31T23:59:59+07:00',
      },
      principal(),
      NOW,
    );

    expect(report.rows.map((row) => [row.key, row.compliance_pct])).toEqual([
      ['2026-09', 0],
      ['2026-10', 100],
    ]);
    expect(report.rows[0].open_overdue).toBeNull();
    // the open query is not even asked
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('CD-67: case responses in the period count toward the response share', async () => {
    const { service } = harness({
      responded: [
        { state: 'running', responseBreachedAt: null, request: request('ops') },
        { state: 'met', responseBreachedAt: NOW, request: request('ops') },
      ],
    });
    const report = await service.report({ group_by: 'team' }, principal(), NOW);
    expect(report.totals).toMatchObject({
      responses: 2,
      responses_on_time: 1,
      response_pct: 50,
    });
  });

  it('SCOPE-02: without request.read.all the counts cover only visible requests', async () => {
    const { service, findMany } = harness({});
    await service.report(
      {},
      principal({ permissions: ['report.request.read'] }),
      NOW,
    );
    const where = (
      findMany.mock.calls[0][0] as {
        where: { request: Record<string, unknown> };
      }
    ).where.request;
    expect(where.companyId).toBe(OSD);
    expect(Object.keys(where).length).toBeGreaterThan(2);
  });

  it('a backwards or over-long period is refused', async () => {
    const { service } = harness({});
    await expect(
      service.report(
        { from: '2026-09-10T00:00:00Z', to: '2026-09-01T00:00:00Z' },
        principal(),
        NOW,
      ),
    ).rejects.toThrow('วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด');
    await expect(
      service.report(
        { from: '2024-01-01T00:00:00Z', to: '2026-09-01T00:00:00Z' },
        principal(),
        NOW,
      ),
    ).rejects.toThrow('ไม่เกิน 1 ปี');
  });
});
