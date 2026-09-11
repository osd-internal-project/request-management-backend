import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ApprovalsService } from './approvals.service';
import type { MatrixLevel } from '../access/access.service';

const OSD = 'company-osd';
const OTHER = 'company-other';

const REQUESTER = 'user-requester';
const RECEIVER = 'user-receiver';
const REQUESTER_BOSS = 'user-requester-boss';
const RECEIVER_BOSS = 'user-receiver-boss';
const OUTSIDER = 'user-outsider';

const REQUESTER_UNIT = 'unit-rnd';
const RECEIVER_UNIT = 'unit-finance';

/**
 * §16 หน้าที่ 3 previews the route before anything is submitted, and the two
 * ladders a request can meet climb **different charts**: the before-work one
 * follows the requester, the one that reviews finished work follows whoever
 * carries it (`requests/approval-stage.ts`).
 *
 * These tests hold that distinction in place. It was absent for long enough to
 * ship a screen that showed the requester's own supervisors and labelled them
 * the reviewers — and a second screen that announced "ไม่มีชั้นอนุมัติ" for a
 * type whose submit routes through an approver.
 */
function principal(userId = REQUESTER): Principal {
  return {
    userId,
    username: userId,
    activeCompanyId: OSD,
    permissions: ['request.create'],
    scopedByPermission: {},
    // Only the fields this path reads. Double cast because a partial principal
    // no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

/** Who sits where, and who heads their unit. */
const CHARTS: Record<string, { orgUnitId: string; head: string }> = {
  [REQUESTER]: { orgUnitId: REQUESTER_UNIT, head: REQUESTER_BOSS },
  [RECEIVER]: { orgUnitId: RECEIVER_UNIT, head: RECEIVER_BOSS },
  [OUTSIDER]: { orgUnitId: 'unit-elsewhere', head: 'user-elsewhere-boss' },
};

const ONE_SUPERVISOR: MatrixLevel[] = [{ type: 'supervisor', up: 1 }];

/** The `user` table's own answer to "what is this person called". */
const DIRECTORY: Record<string, string> = {
  [REQUESTER_BOSS]: 'ชนกุล ค.',
  [RECEIVER_BOSS]: 'หัวหน้าฝ่ายการเงิน',
};

/**
 * The service with only the collaborators a preview reaches.
 *
 * `members` is the company roster the chart-owner guard asks; by default only
 * the people who belong to OSD are in it.
 */
function serviceWith(
  levels: MatrixLevel[] | null = ONE_SUPERVISOR,
  members: string[] = [REQUESTER, RECEIVER, REQUESTER_BOSS, RECEIVER_BOSS],
  /**
   * What user-service says, which in this chart is **nothing**.
   *
   * `ApprovalContextService` names only the requester's personal supervisor
   * chain and the role holders, and 80 of this deployment's 90 users carry no
   * `User.supervisorUserId` at all — the chart is kept on
   * `OrgUnit.managerUserId` instead. So the remote map is empty by default
   * here, which is the condition the reported defect appeared under.
   */
  contextNames: Record<string, string> = {},
) {
  /** Which chart was climbed — the fact every test here is about. */
  const climbed: string[] = [];

  const matrix = {
    requireEffective: jest.fn(() =>
      Promise.resolve({ id: 'matrix-1', levels, currency: 'THB' }),
    ),
  };

  const context = {
    resolve: jest.fn((_auth: string, userId: string) => {
      climbed.push(userId);
      const chart = CHARTS[userId];

      return Promise.resolve({
        orgUnitId: chart?.orgUnitId ?? null,
        supervisorUserId: chart?.head ?? null,
        supervisorChain: [],
        roleHolders: {},
        displayNames: contextNames,
      });
    }),
  };

  const access = {
    /*
      A `supervisor` level resolves to the head of whichever unit the context
      put the chart owner in — which is the whole point of these tests. An
      `org` level here names a group with nobody at its head, so it stands in
      for the level that cannot be filled.
    */
    approverCandidatesOf: jest.fn(
      (level: MatrixLevel, subject: { orgUnitId: string | null }) => {
        if (level.type !== 'supervisor') return Promise.resolve([]);

        const entry = Object.values(CHARTS).find(
          (chart) => chart.orgUnitId === subject.orgUnitId,
        );

        return Promise.resolve(entry ? [entry.head] : []);
      },
    ),
    assertChartOwnerInCompany: jest.fn((userId: string) => {
      if (members.includes(userId)) return Promise.resolve();

      return Promise.reject(
        new AppError('VALIDATION_FAILED', 'ผู้รับที่เลือกไม่ได้อยู่ในบริษัทนี้'),
      );
    }),
    /** The `user` table, which knows everyone in this company by name. */
    displayNamesOf: jest.fn((ids: readonly string[]) =>
      Promise.resolve(
        new Map(
          ids
            .filter((id) => id in DIRECTORY && members.includes(id))
            .map((id) => [id, DIRECTORY[id]]),
        ),
      ),
    ),
  };

  const service = new ApprovalsService(
    {} as never, // cases
    {} as never, // delegations
    matrix as never,
    access as never,
    context as never,
    {} as never, // notifications
    {} as never, // domainEvents
    {} as never, // audit
    {} as never, // transactions
  );

  return { service, climbed, access };
}

async function refused(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }

  throw new Error('expected the preview to be refused');
}

describe('APV-02 preview — whose chart a supervisor level climbs', () => {
  it('climbs the caller when no chart owner is named (the :pre ladder)', async () => {
    const { service, climbed } = serviceWith();

    const preview = await service.previewChain(
      { subject_type: 'request:FI05:pre' },
      principal(),
      'Bearer t',
    );

    expect(climbed).toEqual([REQUESTER]);
    expect(preview.steps[0].user_id).toBe(REQUESTER_BOSS);
  });

  /**
   * The defect this endpoint shipped with: หน้าที่ 3 asked for the after-work
   * ladder and got the requester's own supervisors back.
   */
  it('climbs the named chart owner for the ladder that reviews the work', async () => {
    const { service, climbed } = serviceWith();

    const preview = await service.previewChain(
      { subject_type: 'request:FI05', chart_owner_user_id: RECEIVER },
      principal(),
      'Bearer t',
    );

    expect(climbed).toEqual([RECEIVER]);
    expect(preview.steps[0].user_id).toBe(RECEIVER_BOSS);
    expect(preview.steps[0].user_id).not.toBe(REQUESTER_BOSS);
  });

  it('refuses a chart owner from another company (SCOPE-03)', async () => {
    const { service } = serviceWith(ONE_SUPERVISOR, [REQUESTER, RECEIVER]);

    const error = await refused(
      service.previewChain(
        { subject_type: 'request:FI05', chart_owner_user_id: OUTSIDER },
        principal(),
        'Bearer t',
      ),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('does not ask the roster when the chart owner is the caller', async () => {
    const { service, access } = serviceWith();

    await service.previewChain(
      { subject_type: 'request:FI05:pre', chart_owner_user_id: REQUESTER },
      principal(),
      'Bearer t',
    );

    expect(access.assertChartOwnerInCompany).not.toHaveBeenCalled();
  });
});

describe('APV-02 preview — what each approver is called', () => {
  /**
   * The reported defect: the step resolved to the head of the requester's
   * department, user-service had never heard of them, and the screen printed
   * the level's storage code — `supervisor:1` — in place of a name.
   */
  it('names an approver user-service did not know about', async () => {
    const { service } = serviceWith();

    const preview = await service.previewChain(
      { subject_type: 'request:FI05:pre' },
      principal(),
      'Bearer t',
    );

    expect(preview.steps[0].user_id).toBe(REQUESTER_BOSS);
    expect(preview.steps[0].display_name).toBe('ชนกุล ค.');
  });

  /**
   * Where both answer, the `user` table wins: the persisted request detail
   * reads names through a Prisma relation on that same table, and the two
   * screens must not call one person two things.
   */
  it('prefers the user table over the approval context', async () => {
    const { service } = serviceWith(ONE_SUPERVISOR, undefined, {
      [REQUESTER_BOSS]: 'ชื่อเก่าจาก context',
    });

    const preview = await service.previewChain(
      { subject_type: 'request:FI05:pre' },
      principal(),
      'Bearer t',
    );

    expect(preview.steps[0].display_name).toBe('ชนกุล ค.');
  });

  /** A name that cannot be found is absent, not an error. */
  it('leaves the name null when nobody can say who that id is', async () => {
    const { service } = serviceWith(ONE_SUPERVISOR, [
      REQUESTER,
      RECEIVER,
      // `REQUESTER_BOSS` is missing, so neither source names them.
    ]);

    const preview = await service.previewChain(
      { subject_type: 'request:FI05:pre' },
      principal(),
      'Bearer t',
    );

    expect(preview.steps[0].user_id).toBe(REQUESTER_BOSS);
    expect(preview.steps[0].display_name).toBeNull();
  });
});

describe('APV-02 preview — a level nobody fills', () => {
  /**
   * The docstring promised `user_id: null` while `resolveLevels` dropped the
   * level, so a ladder of two could preview as one and the red
   * "ยังไม่มีผู้อนุมัติ" tag on หน้าที่ 3 could never appear.
   */
  it('reports the level with no approver instead of dropping it', async () => {
    const { service } = serviceWith([
      { type: 'supervisor', up: 1 },
      // Nobody heads this: `approverCandidatesOf` finds no chart for it.
      { type: 'org', orgUnitIds: ['unit-with-no-head'] },
    ]);

    const preview = await service.previewChain(
      { subject_type: 'request:FI05:pre' },
      principal(),
      'Bearer t',
    );

    expect(preview.steps).toHaveLength(2);
    expect(preview.steps[1]).toMatchObject({
      step_no: 2,
      position: 'org',
      user_id: null,
      display_name: null,
      candidate_user_ids: [],
    });
  });

  it('still refuses a ladder with no levels at all', async () => {
    const { service } = serviceWith([]);

    const error = await refused(
      service.previewChain(
        { subject_type: 'request:FI05:pre' },
        principal(),
        'Bearer t',
      ),
    );

    expect(error.code).toBe('APV_MATRIX_NOT_FOUND');
  });
});
