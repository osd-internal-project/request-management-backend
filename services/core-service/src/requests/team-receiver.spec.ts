import type { Principal } from '@request-management/share';
import { RequestRepository } from './request.repository';
import type { RequestWithType } from './request.repository';
import { RequestsService } from './requests.service';
import { pickReceiver } from './submit-rules';

const COMPANY = 'company-dcall';
const TEAM = 'ou-it';
const actor = { userId: 'system-key', activeCompanyId: COMPANY } as unknown as Principal;

function draft(overrides: Partial<RequestWithType> = {}): RequestWithType {
  // Only the fields the receiver pick reads; the full row type needs the cast.
  return {
    id: 'req-1',
    companyId: COMPANY,
    receiverUserId: null,
    receiverOrgUnitId: TEAM,
    requestType: { receiverUserId: null },
    ...overrides,
  } as unknown as RequestWithType;
}

/** The service with only what the team-receiver step reaches. */
function serviceWith(members: string[], load: Record<string, number>) {
  const updates: unknown[] = [];
  const events: { type: string; data: unknown }[] = [];
  const service = new RequestsService(
    {
      teamMemberIds: jest.fn(() => Promise.resolve(members)),
      openLoad: jest.fn(() => Promise.resolve(new Map(Object.entries(load)))),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) =>
        work({ request: { update: jest.fn((args: unknown) => updates.push(args)) } }),
      ),
    } as never,
    { latestFor: jest.fn(() => Promise.resolve(null)) } as never,
  );
  jest
    .spyOn(service as never, 'recordEvent')
    .mockImplementation(((_: unknown, entry: { type: string; data: unknown }) => {
      events.push(entry);
      return Promise.resolve();
    }) as never);
  // Private on purpose: submit() runs it before every other check; this is that step alone.
  const fill = (request: RequestWithType) =>
    (service as unknown as {
      withTeamReceiver(r: RequestWithType, a: Principal): Promise<RequestWithType>;
    }).withTeamReceiver(request, actor);
  return { fill, updates, events };
}

describe('auto-receive: a request with a receiving team and no receiver', () => {
  it('goes to the team member with the least open requests', async () => {
    const { fill, updates, events } = serviceWith(['u-a', 'u-b', 'u-c'], { 'u-a': 3, 'u-b': 1, 'u-c': 2 });

    const result = await fill(draft());

    expect(result.receiverUserId).toBe('u-b');
    expect(updates).toEqual([
      { where: { id: 'req-1' }, data: { receiverUserId: 'u-b', updatedBy: 'system-key' } },
    ]);
    expect(events[0]).toMatchObject({
      type: 'request.receiver_auto_assigned',
      data: { receiver_user_id: 'u-b', org_unit_id: TEAM, open_requests: 1 },
    });
  });

  it('counts a member with no open request as zero', async () => {
    const { fill } = serviceWith(['u-a', 'u-b'], { 'u-a': 2 });

    expect((await fill(draft())).receiverUserId).toBe('u-b');
  });

  it.each([
    ['the requester named someone', draft({ receiverUserId: 'u-named' })],
    ['the type fixes a receiver', draft({ requestType: { receiverUserId: 'u-fixed' } } as never)],
    ['there is no receiving team', draft({ receiverOrgUnitId: null })],
  ])('changes nothing when %s', async (_, request) => {
    const { fill, updates } = serviceWith(['u-a'], {});

    expect(await fill(request)).toBe(request);
    expect(updates).toEqual([]);
  });

  it('leaves an empty team to the usual "name a receiver" error', async () => {
    const { fill, updates } = serviceWith([], {});

    expect((await fill(draft())).receiverUserId).toBeNull();
    expect(updates).toEqual([]);
  });
});

describe('pickReceiver', () => {
  it('breaks a tie on the lowest id, so the same data picks the same person', () => {
    expect(pickReceiver([{ userId: 'u-c', open: 1 }, { userId: 'u-a', open: 1 }, { userId: 'u-b', open: 4 }]))
      .toEqual({ userId: 'u-a', open: 1 });
  });

  it('has nobody to pick from an empty team', () => {
    expect(pickReceiver([])).toBeNull();
  });
});

describe('RequestRepository.openLoad', () => {
  it('counts a request once for someone who both receives and holds it', async () => {
    const findMany = jest.fn(() =>
      Promise.resolve([
        { receiverUserId: 'u-a', assigneeUserId: 'u-a' },
        { receiverUserId: 'u-a', assigneeUserId: 'u-b' },
        { receiverUserId: 'u-x', assigneeUserId: 'u-b' },
      ]),
    );
    const repo = new RequestRepository({ request: { findMany } } as never);

    const load = await repo.openLoad(COMPANY, ['u-a', 'u-b']);

    expect(Object.fromEntries(load)).toEqual({ 'u-a': 2, 'u-b': 2 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: COMPANY,
          status: { in: ['submitted', 'returned', 'in_progress', 'on_hold', 'pending_approval'] },
        }),
      }),
    );
  });
});
