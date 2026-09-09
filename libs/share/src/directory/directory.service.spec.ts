import type { AccessSubject } from '../access/access-rules';
import { DirectoryService } from './directory.service';

const subject = (overrides: Partial<AccessSubject> = {}): AccessSubject => ({
  userId: 'user-1',
  activeCompanyId: 'company-osd',
  ledUnitIds: [],
  levelUnitIds: [],
  scopedUnitIds: [],
  scopedActUnitIds: [],
  scopedUserIds: [],
  scopedActUserIds: [],
  scopedDecideUnitIds: [],
  scopedDecideUserIds: [],
  coveringUserIds: [],
  readsWholeCompany: false,
  ...overrides,
});

function build() {
  const repo = {
    search: jest.fn<Promise<unknown[]>, [unknown, unknown]>(),
    countWhere: jest.fn<Promise<number>, [unknown]>(),
  };

  return { repo, service: new DirectoryService(repo as never) };
}

/** The clauses `whereFor` produced, flattened for readability. */
const clauses = (where: Record<string, unknown>) =>
  (where.AND as Record<string, unknown>[]) ?? [];

describe('SCOPE-03 — the company boundary is absolute', () => {
  it('pins the active company on every query', () => {
    const { service } = build();

    const where = service.whereFor(subject(), { page: 1, page_size: 20 });

    expect(clauses(where)[0]).toEqual({
      companies: { some: { companyId: 'company-osd' } },
    });
  });

  it('pins it for a caller who reads the whole company too', () => {
    // `request.read.all` widens which *requests* are readable. It says nothing
    // about people, and must not leak the directory across a boundary.
    const { service } = build();

    const where = service.whereFor(subject({ readsWholeCompany: true }), {
      page: 1,
      page_size: 20,
    });

    expect(clauses(where)[0]).toEqual({
      companies: { some: { companyId: 'company-osd' } },
    });
  });
});

describe('the directory filter', () => {
  it('excludes suspended accounts without being asked', () => {
    const { service } = build();

    const where = service.whereFor(subject(), { page: 1, page_size: 20 });

    expect(clauses(where)).toContainEqual({ status: 'ACTIVE' });
  });

  it('searches display name, username and email together', () => {
    const { service } = build();

    const where = service.whereFor(subject(), {
      page: 1,
      page_size: 20,
      q: 'สมชาย',
    });

    expect(clauses(where)).toContainEqual({
      OR: [
        { displayName: { contains: 'สมชาย', mode: 'insensitive' } },
        { username: { contains: 'สมชาย', mode: 'insensitive' } },
        { email: { contains: 'สมชาย', mode: 'insensitive' } },
      ],
    });
  });

  it('ignores a search term that is only whitespace', () => {
    const { service } = build();

    const where = service.whereFor(subject(), {
      page: 1,
      page_size: 20,
      q: '   ',
    });

    expect(clauses(where)).toHaveLength(2); // company + ACTIVE, nothing else
  });

  /*
    The case that made `orgUnitIds` an explicit list rather than a root id: a
    person in the รอจัดสังกัด queue asking for "my team" has no team, and the
    subtree their caller resolved is empty. Dropping an empty clause would
    answer with the whole company — the widest possible answer to the narrowest
    possible question.
  */
  it('matches nobody when the caller resolved an empty subtree', () => {
    const { service } = build();

    const where = service.whereFor(subject(), {
      page: 1,
      page_size: 20,
      orgUnitIds: [],
    });

    expect(clauses(where)).toContainEqual({ orgUnitId: { in: [] } });
  });

  it('narrows to one group when asked for one', () => {
    const { service } = build();

    const where = service.whereFor(subject(), {
      page: 1,
      page_size: 20,
      org_unit_id: 'ou-sales',
    });

    expect(clauses(where)).toContainEqual({ orgUnitId: 'ou-sales' });
  });
});

describe('the rows it returns', () => {
  it('carries the group name and drops the columns nobody picking a name needs', async () => {
    const { repo, service } = build();

    repo.search.mockResolvedValue([
      {
        id: 'u-1',
        displayName: 'นายชนะกุล แก้วทรงเกษ',
        username: 'chanakulk',
        email: 'chanakulk@osd.co.th',
        position: 'Solution Architect',
        orgUnitId: 'ou-bsc',
        orgUnit: { name: 'Business Solution Consulting' },
      },
    ]);
    repo.countWhere.mockResolvedValue(1);

    const page = await service.searchUsers(subject(), {
      page: 1,
      page_size: 20,
    });

    expect(page.data[0]).toEqual({
      id: 'u-1',
      displayName: 'นายชนะกุล แก้วทรงเกษ',
      username: 'chanakulk',
      email: 'chanakulk@osd.co.th',
      position: 'Solution Architect',
      orgUnitId: 'ou-bsc',
      orgUnitName: 'Business Solution Consulting',
    });
    expect(page.total).toBe(1);
  });

  it('answers null for somebody who has no group yet', async () => {
    const { repo, service } = build();

    repo.search.mockResolvedValue([
      {
        id: 'u-2',
        displayName: 'พนักงานใหม่',
        username: 'newbie',
        email: null,
        position: null,
        orgUnitId: null,
        orgUnit: null,
      },
    ]);
    repo.countWhere.mockResolvedValue(1);

    const page = await service.searchUsers(subject(), {
      page: 1,
      page_size: 20,
    });

    expect(page.data[0].orgUnitName).toBeNull();
  });

  it('counts with the same filter it lists with (SCOPE-02)', async () => {
    const { repo, service } = build();

    repo.search.mockResolvedValue([]);
    repo.countWhere.mockResolvedValue(0);

    await service.searchUsers(subject(), { page: 1, page_size: 20, q: 'ก' });

    expect(repo.countWhere).toHaveBeenCalledWith(repo.search.mock.calls[0][0]);
  });
});
