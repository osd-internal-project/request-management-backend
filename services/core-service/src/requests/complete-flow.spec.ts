import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';

const OSD = 'company-osd';
const WORKER = 'user-worker';
const REQUESTER = 'user-requester';

function principal(userId: string = WORKER): Principal {
  return {
    userId,
    activeCompanyId: OSD,
    username: 'worker',
    permissions: ['request.complete', 'request.create'],
    // Only the fields this path reads. Double cast because a partial
    // principal no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

/**
 * A request sitting where `complete` expects to find one.
 *
 * `receiverUserId` is the worker: since 2 ก.ย. 2569 only the person carrying a
 * ticket may finish it (`assertMayAct`), so a fixture handed to nobody would
 * now be refused before these tests reached the branch they are about.
 */
function inProgressRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    requestNo: 'OSD-PC-01-202608-0001',
    companyId: OSD,
    typeCode: 'PC-01',
    status: 'in_progress',
    requesterId: REQUESTER,
    receiverUserId: WORKER,
    assigneeUserId: null,
    requesterOrgUnitId: null,
    receiverOrgUnitId: null,
    formData: {},
    requestType: { approvalPolicy: {} },
    attachments: [],
    ...overrides,
  };
}

/**
 * Builds the service with only the collaborators `complete` reaches.
 *
 * The transaction runner is replaced with one that hands back a recording
 * client: the point of these tests is *which status the request is left in*,
 * and that is decided before any database is involved.
 */
function serviceWith(options: {
  hasMatrix: boolean;
  openChildren?: { id: string; requestNo: string | null }[];
  request?: Record<string, unknown>;
}) {
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
    approvalCase: { update: jest.fn(() => Promise.resolve({})) },
  };

  const openCase = jest.fn(() =>
    Promise.resolve({
      id: 'case-1',
      status: 'pending',
      steps: [{ stepNo: 1 }],
    }),
  );

  const service = new RequestsService(
    {
      findWithType: jest.fn(() =>
        Promise.resolve(options.request ?? inProgressRequest()),
      ),
      findOpenChildren: jest.fn(() =>
        Promise.resolve(options.openChildren ?? []),
      ),
    } as never,
    {} as never,
    // `RequestCommentRepository` — none of these paths comment.
    {} as never,
    {} as never,
    // `OrgUnitRepository` — `complete` never resolves a receiving team.
    {} as never,
    {} as never,
    {
      hasPublishedMatrix: jest.fn(() => Promise.resolve(options.hasMatrix)),
      openCase,
    } as never,
    {
      stop: jest.fn(() => Promise.resolve()),
      pause: jest.fn(() => Promise.resolve()),
    } as never,
    {} as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work(prisma)),
    } as never,
    {} as never, // flows
  );

  return { service, updates, openCase };
}

describe('completing a request decides whether the result is checked', () => {
  /**
   * Eighteen of OSD's forty types are Pattern C — "คำขอนี้ไม่มีชั้นอนุมัติ".
   * Before this branch existed they could not be finished at all.
   */
  it('accepts the result outright when the type has no approval matrix', async () => {
    const { service, updates, openCase } = serviceWith({ hasMatrix: false });

    await service.complete('req-1', principal(), 'Bearer token');

    expect(updates.map((update) => update.status)).toEqual([
      'completed',
      'approved',
    ]);
    expect(openCase).not.toHaveBeenCalled();
  });

  it('opens a case and waits for the check when the type has one', async () => {
    const { service, updates, openCase } = serviceWith({ hasMatrix: true });

    await service.complete('req-1', principal(), 'Bearer token');

    expect(updates.map((update) => update.status)).toEqual([
      'completed',
      'pending_approval',
    ]);
    expect(openCase).toHaveBeenCalledTimes(1);
  });

  describe('a parent waits for its children', () => {
    it('refuses to complete while a child is still open', async () => {
      const { service, updates } = serviceWith({
        hasMatrix: false,
        openChildren: [
          { id: 'child-1', requestNo: 'OSD-EN-02-202608-0007' },
          { id: 'child-2', requestNo: 'OSD-PR-01-202608-0008' },
        ],
      });

      await expect(
        service.complete('req-1', principal(), 'Bearer token'),
      ).rejects.toThrow(AppError);

      // Nothing was written: the refusal happens before the transaction.
      expect(updates).toHaveLength(0);
    });

    it('names every open child, because "finish them first" needs a which', async () => {
      expect.assertions(2);

      const { service } = serviceWith({
        hasMatrix: false,
        openChildren: [
          { id: 'child-1', requestNo: 'OSD-EN-02-202608-0007' },
          { id: 'child-2', requestNo: null },
        ],
      });

      try {
        await service.complete('req-1', principal(), 'Bearer token');
      } catch (error) {
        expect((error as AppError).code).toBe('REQ_CHILDREN_OPEN');
        expect((error as AppError).details).toEqual([
          { field: 'children', reason: 'OSD-EN-02-202608-0007' },
          // A draft child has no number yet; its id still identifies it.
          { field: 'children', reason: 'child-2' },
        ]);
      }
    });

    /**
     * `close` is the other end of the chain, and it had no guard at all.
     *
     * `complete` checks once, when the doing team finishes. A sub-request
     * raised after that — the usual moment, while the parent waits on approval
     * — passed no check, so the requester could close the parent over live work
     * underneath it. Found by walking a two-level chain against the running
     * services on 1 ก.ย. 2569.
     */
    it('refuses to close while a child is still open', async () => {
      expect.assertions(2);

      const { service, updates } = serviceWith({
        hasMatrix: false,
        request: inProgressRequest({
          status: 'approved',
          requesterId: REQUESTER,
        }),
        openChildren: [{ id: 'child-1', requestNo: 'OSD-DSC-202609-0005' }],
      });

      try {
        await service.close('req-1', principal(REQUESTER));
      } catch (error) {
        expect((error as AppError).code).toBe('REQ_CHILDREN_OPEN');
      }

      // Refused before the transaction, so nothing was written.
      expect(updates).toHaveLength(0);
    });

    it('closes once the children are finished', async () => {
      const { service, updates } = serviceWith({
        hasMatrix: false,
        request: inProgressRequest({
          status: 'approved',
          requesterId: REQUESTER,
        }),
        openChildren: [],
      });

      await service.close('req-1', principal(REQUESTER));

      expect(updates.map((update) => update.status)).toEqual(['closed']);
    });
  });
});
