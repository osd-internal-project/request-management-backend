import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';

const OSD = 'company-osd';
const REQUESTER = 'user-requester';
const RECEIVER = 'user-receiver';
const ASSIGNEE = 'user-assignee';
const STRANGER = 'user-stranger';
const HEAD = 'user-head';

const SALES = 'unit-sales';
const PRICING = 'unit-pricing';

function principal(userId: string, ledUnitIds: string[] = []): Principal {
  return {
    userId,
    activeCompanyId: OSD,
    username: userId,
    ledUnitIds,
    // Everyone now holds the request-menu permissions; the org chart is the
    // gate, which is exactly what these tests are about.
    permissions: [
      'request.create',
      'request.read',
      'request.complete',
      'approval.decide',
    ],
  } as unknown as Principal;
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    requestNo: 'OSD-DSC-202609-0009',
    companyId: OSD,
    typeCode: 'DSC',
    status: 'in_progress',
    requesterId: REQUESTER,
    receiverUserId: RECEIVER,
    assigneeUserId: null,
    requesterOrgUnitId: SALES,
    receiverOrgUnitId: PRICING,
    formData: {},
    requestType: { approvalPolicy: {} },
    attachments: [],
    ...overrides,
  };
}

/** The service with only the collaborators these paths reach. */
function serviceWith(request: Record<string, unknown> = ticket()) {
  const updates: Record<string, unknown>[] = [];

  const prisma = {
    request: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return Promise.resolve({ id: 'req-1', ...data });
      }),
    },
    // `nextRequestEventSeq` locks the row, then reads the last seq.
    $queryRaw: jest.fn(() => Promise.resolve([])),
    requestEvent: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve({})),
    },
    slaClock: { update: jest.fn(() => Promise.resolve({})) },
  };

  const service = new RequestsService(
    {
      findWithType: jest.fn(() => Promise.resolve(request)),
      findOpenChildren: jest.fn(() => Promise.resolve([])),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { hasPublishedMatrix: jest.fn(() => Promise.resolve(false)) } as never,
    {
      stop: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
      resume: jest.fn(() => Promise.resolve()),
    } as never,
    {} as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    {} as never, // flows
  );

  return { service, updates };
}

async function refused(work: Promise<unknown>): Promise<AppError> {
  try {
    await work;
  } catch (error) {
    return error as AppError;
  }

  throw new Error('expected the action to be refused');
}

/**
 * Authority over the request menu moved from the role to the org chart on
 * 2 ก.ย. 2569: every user now holds `request.complete` and `approval.decide`,
 * and involvement decides who may actually move a ticket.
 *
 * That trade is only safe if the involvement is enforced. Before the change,
 * `require()` checked the **company and nothing else** — the role permission
 * was the only thing standing between an employee and somebody else's request.
 * These are the tests that make the replacement real rather than assumed, and
 * they are deliberately all negative: the permissive cases are covered by the
 * lifecycle suites.
 */
describe('acting on a request needs involvement, not just a permission', () => {
  const carrierActions = [
    [
      'complete',
      (s: RequestsService, p: Principal) => s.complete('req-1', p, 'Bearer t'),
    ],
    [
      'assign',
      (s: RequestsService, p: Principal) =>
        s.assign('req-1', { assignee_user_id: ASSIGNEE }, p),
    ],
    [
      'hold',
      (s: RequestsService, p: Principal) =>
        s.hold('req-1', { reason: 'รอ vendor' }, p),
    ],
    ['resume', (s: RequestsService, p: Principal) => s.resume('req-1', {}, p)],
  ] as const;

  it.each(carrierActions)(
    'refuses %s from somebody who is neither receiver nor assignee',
    async (_name, run) => {
      const { service, updates } = serviceWith();

      const error = await refused(run(service, principal(STRANGER)));

      expect(error.code).toBe('FORBIDDEN');
      // Refused before the transaction: nothing was written.
      expect(updates).toHaveLength(0);
    },
  );

  it.each(carrierActions)(
    'refuses %s from the requester, who did not do the work',
    async (_name, run) => {
      const { service } = serviceWith();

      expect((await refused(run(service, principal(REQUESTER)))).code).toBe(
        'FORBIDDEN',
      );
    },
  );

  it('lets the assignee act once work has been handed to them', async () => {
    const { service } = serviceWith(
      ticket({ receiverUserId: RECEIVER, assigneeUserId: ASSIGNEE }),
    );

    await expect(
      service.hold('req-1', { reason: 'รอข้อมูล' }, principal(ASSIGNEE)),
    ).resolves.toBeDefined();
  });

  describe('cancelling', () => {
    it('refuses a stranger', async () => {
      const { service, updates } = serviceWith();

      const error = await refused(
        service.cancel('req-1', { reason: 'ไม่เอาแล้ว' }, principal(STRANGER)),
      );

      expect(error.code).toBe('FORBIDDEN');
      expect(updates).toHaveLength(0);
    });

    /**
     * A head may withdraw work raised into or by the part of the chart they
     * lead — `ledUnitIds` is that subtree, resolved when the principal is
     * built. This is the one place "ดูจากโครงสร้างองค์กร" does real work.
     */
    it('allows the head of the group the request came from', async () => {
      const { service } = serviceWith();

      await expect(
        service.cancel(
          'req-1',
          { reason: 'ซ้ำกับใบอื่น' },
          principal(HEAD, [SALES]),
        ),
      ).resolves.toBeDefined();
    });

    it('allows the head of the receiving group', async () => {
      const { service } = serviceWith();

      await expect(
        service.cancel(
          'req-1',
          { reason: 'ทีมไม่รับงานนี้' },
          principal(HEAD, [PRICING]),
        ),
      ).resolves.toBeDefined();
    });

    /**
     * A role's visibility level opens the rows; it never opens the buttons.
     *
     * `levelUnitIds` reaches a whole branch of the chart with no administrator
     * naming anybody, which is exactly why it stays out of `leads()`. Wiring it
     * in would hand every request beneath a division to whoever was given a
     * view of it.
     */
    it('refuses somebody who only reaches the group through a role level', async () => {
      const { service, updates } = serviceWith();

      const viewer = {
        ...principal(STRANGER),
        levelUnitIds: [SALES, PRICING],
      } as unknown as Principal;

      expect(
        (
          await refused(
            service.cancel('req-1', { reason: 'เห็นแล้วอยากยกเลิก' }, viewer),
          )
        ).code,
      ).toBe('FORBIDDEN');
      expect(updates).toHaveLength(0);
    });

    /** Leading *some* group is not leading *this* one. */
    it('refuses a head of an unrelated group', async () => {
      const { service } = serviceWith();

      expect(
        (
          await refused(
            service.cancel(
              'req-1',
              { reason: 'ไม่เกี่ยว' },
              principal(HEAD, ['unit-other']),
            ),
          )
        ).code,
      ).toBe('FORBIDDEN');
    });

    it('allows the requester to withdraw their own', async () => {
      const { service } = serviceWith();

      await expect(
        service.cancel('req-1', { reason: 'เปลี่ยนใจ' }, principal(REQUESTER)),
      ).resolves.toBeDefined();
    });
  });
});
