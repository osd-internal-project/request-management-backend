import type { Principal } from '@request-management/share';
import { BiService } from './bi.service';
import type { BiDashboardRepository } from './bi-dashboard.repository';

/**
 * CD-92 v2 — dashboards as configuration rows with per-team visibility.
 *
 * The Prisma `where` that resolves an audience through `org_closure` lives in
 * the repository; these tests pin the service's decisions around it: when the
 * env fallback applies, how the menu is shaped, and that the admin surface
 * refuses foreign org units and answers 404 across the company boundary.
 */

const CONFIG_VALUES: Record<string, unknown> = {
  'metabase.siteUrl': 'http://bi.local:3300',
  'metabase.embedSecret': 'secret',
  'metabase.dashboards.requestOverview': 11,
  'metabase.dashboards.approval': 12,
  'metabase.dashboards.sla': 0,
};

const config = {
  get: (key: string) => CONFIG_VALUES[key],
};

const principal = (overrides: Partial<Principal> = {}): Principal =>
  ({
    userId: 'user-1',
    keycloakId: 'kc-1',
    username: 'somchai',
    displayName: 'สมชาย',
    email: null,
    companies: [
      { id: 'company-1', name: 'บริษัท 1', docPrefix: 'C1', isPrimary: true },
    ],
    activeCompanyId: 'company-1',
    orgUnitId: 'team-sales',
    supervisorUserId: null,
    teamOrgUnitIds: ['team-sales'],
    departmentOrgUnitIds: ['team-sales'],
    roles: [],
    permissions: ['report.dashboard.read'],
    scopes: {},
    sensitiveFieldsVisible: [],
    sensitiveFieldsAll: [],
    isServiceAccount: false,
    pendingOrgAssignment: false,
    ...overrides,
  }) as unknown as Principal;

interface Mocks {
  repo: jest.Mocked<
    Pick<
      BiDashboardRepository,
      | 'count'
      | 'findVisible'
      | 'findForCompany'
      | 'findOwn'
      | 'findAssignableUnits'
      | 'findCompanyUnits'
      | 'replaceAudiences'
      | 'create'
      | 'update'
    >
  >;
  audit: { record: jest.Mock };
  service: BiService;
}

const build = (): Mocks => {
  const repo = {
    count: jest.fn(),
    findVisible: jest.fn(),
    findForCompany: jest.fn(),
    findOwn: jest.fn(),
    findAssignableUnits: jest.fn(),
    findCompanyUnits: jest.fn(),
    replaceAudiences: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  } as Mocks['repo'];

  const audit = { record: jest.fn() };
  const tx = {
    execute: (work: (prisma: unknown) => Promise<unknown>) => work({}),
  };

  const service = new BiService(
    config as never,
    repo as never,
    tx as never,
    audit as never,
  );

  return { repo, audit, service };
};

const dbRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'dash-1',
  companyId: 'company-1',
  title: 'ยอดขายทีม',
  metabaseDashboardId: 42,
  sortOrder: 0,
  active: true,
  createdAt: new Date('2026-08-27T00:00:00Z'),
  createdBy: 'user-9',
  updatedAt: new Date('2026-08-27T00:00:00Z'),
  updatedBy: null,
  ...overrides,
});

describe('CD-92 v2: BI menu from configuration', () => {
  it('serves configured rows keyed by row id, filtered per caller unit', async () => {
    const { repo, service } = build();
    repo.count.mockResolvedValue(1);
    repo.findVisible.mockResolvedValue([dbRow()] as never);

    const menu = await service.menu(principal());

    expect(repo.findVisible).toHaveBeenCalledWith('company-1', 'team-sales');
    expect(menu.configured).toBe(true);
    expect(menu.dashboards).toHaveLength(1);
    expect(menu.dashboards[0].key).toBe('dash-1');
    expect(menu.dashboards[0].title).toBe('ยอดขายทีม');
    expect(menu.dashboards[0].embed_url).toContain(
      'http://bi.local:3300/embed/dashboard/',
    );
  });

  it('falls back to the env trio only while the company has no rows at all', async () => {
    const { repo, service } = build();
    repo.count.mockResolvedValue(0);

    const menu = await service.menu(principal());

    expect(repo.findVisible).not.toHaveBeenCalled();
    expect(menu.dashboards.map((item) => item.key)).toEqual([
      'requestOverview',
      'approval',
    ]);
  });

  it('a company that retired every dashboard gets an empty menu, not the fallback', async () => {
    const { repo, service } = build();
    repo.count.mockResolvedValue(2);
    repo.findVisible.mockResolvedValue([] as never);

    const menu = await service.menu(principal());

    expect(menu.configured).toBe(true);
    expect(menu.dashboards).toEqual([]);
  });

  it('reveals settings_url only to admin.bi.manage holders', async () => {
    const { repo, service } = build();
    repo.count.mockResolvedValue(0);

    const plain = await service.menu(principal());
    const admin = await service.menu(
      principal({
        permissions: ['report.dashboard.read', 'admin.bi.manage'] as never,
      }),
    );

    expect(plain.settings_url).toBeNull();
    expect(admin.settings_url).toBe('http://bi.local:3300');
  });
});

describe('CD-92 v2: dashboard administration', () => {
  it('creates a dashboard with its audience and audits it', async () => {
    const { repo, audit, service } = build();
    repo.findAssignableUnits.mockResolvedValue([
      { id: 'team-sales', name: 'ทีมขาย', kind: 'TEAM' },
    ] as never);
    repo.create.mockResolvedValue(dbRow());

    const item = await service.create(
      {
        title: 'ยอดขายทีม',
        metabase_dashboard_id: 42,
        org_unit_ids: ['team-sales'],
      },
      principal({ permissions: ['admin.bi.manage'] as never }),
    );

    expect(item.org_units).toEqual([
      { id: 'team-sales', name: 'ทีมขาย', kind: 'TEAM' },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'bi.dashboard.created' }),
      expect.anything(),
    );
  });

  it('rejects an audience unit outside the target company', async () => {
    const { repo, service } = build();
    // The other company's unit does not resolve — same as not existing.
    repo.findAssignableUnits.mockResolvedValue([] as never);

    await expect(
      service.create(
        {
          title: 'ยอดขายทีม',
          metabase_dashboard_id: 42,
          org_unit_ids: ['unit-of-other-company'],
        },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('answers 404, not 403, for a dashboard outside the caller companies', async () => {
    const { repo, service } = build();
    repo.findOwn.mockResolvedValue(null);

    await expect(
      service.update('dash-of-other-company', { title: 'x' }, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(repo.findOwn).toHaveBeenCalledWith('dash-of-other-company', [
      'company-1',
    ]);
  });

  it('DELETE retires the row instead of hard-deleting it', async () => {
    const { repo, audit, service } = build();
    repo.findOwn.mockResolvedValue({ ...dbRow(), audiences: [] });
    repo.update.mockResolvedValue(dbRow({ active: false }));

    await service.deactivate('dash-1', principal());

    expect(repo.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dash-1' },
        data: expect.objectContaining({ active: false }),
      }),
      expect.anything(),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'bi.dashboard.deactivated' }),
      expect.anything(),
    );
  });

  it('replaces the audience set on update when org_unit_ids is given', async () => {
    const { repo, service } = build();
    repo.findOwn.mockResolvedValue({
      ...dbRow(),
      audiences: [
        {
          dashboardId: 'dash-1',
          orgUnitId: 'team-sales',
          orgUnit: { id: 'team-sales', name: 'ทีมขาย', kind: 'TEAM' },
        },
      ],
    } as never);
    repo.findAssignableUnits.mockResolvedValue([
      { id: 'dept-ops', name: 'ฝ่ายปฏิบัติการ', kind: 'DEPARTMENT' },
    ] as never);
    repo.update.mockResolvedValue(dbRow());

    const item = await service.update(
      'dash-1',
      { org_unit_ids: ['dept-ops'] },
      principal(),
    );

    expect(repo.replaceAudiences).toHaveBeenCalledWith(
      'dash-1',
      ['dept-ops'],
      expect.anything(),
    );
    expect(item.org_units.map((unit) => unit.id)).toEqual(['dept-ops']);
  });
});
