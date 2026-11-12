import type { Principal } from '@request-management/share';
import { CareService } from './care.service';

function agent(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'me',
    activeCompanyId: 'osd',
    permissions: ['service.care.manage'],
    ledUnitIds: ['care-team'],
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedUserIds: [],
    isServiceAccount: false,
    ...overrides,
  } as unknown as Principal;
}

function serviceWith(found: unknown = null) {
  const conversations = {
    findMany: jest.fn<Promise<unknown[]>, [{ where: Record<string, unknown> }]>(
      () => Promise.resolve([]),
    ),
    findFirst: jest.fn<Promise<unknown>, [{ where: Record<string, unknown> }]>(
      () => Promise.resolve(found),
    ),
  };
  const deps: unknown[] = Array.from({ length: 16 }, () => ({}));
  deps[0] = conversations;
  deps[3] = { userNames: jest.fn(() => Promise.resolve(new Map())) };
  const service = new (CareService as unknown as new (...a: unknown[]) => CareService)(
    ...deps,
  );
  return { service, conversations };
}

describe('Q9 Care — conversations are seen like owned rows', () => {
  it('an agent: own chats, chats held in the units they lead, and the waiting queue', async () => {
    const { service, conversations } = serviceWith();

    await service.list(agent(), {});

    expect(conversations.findMany.mock.calls[0][0].where).toEqual({
      companyId: 'osd',
      OR: [
        { agentUserId: 'me' },
        { agent: { orgUnitId: { in: ['care-team'] } } },
        { agentUserId: null },
      ],
    });
  });

  it('service.care.read.all: every conversation of the company', async () => {
    const { service, conversations } = serviceWith();

    await service.list(
      agent({ permissions: ['service.care.manage', 'service.care.read.all'] as never }),
      {},
    );

    expect(conversations.findMany.mock.calls[0][0].where).toEqual({ companyId: 'osd' });
  });

  it('opening a chat outside that reach answers 404', async () => {
    const { service, conversations } = serviceWith(null);

    await expect(service.detail(agent(), 'chat-9')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(conversations.findFirst.mock.calls[0][0].where).toMatchObject({
      id: 'chat-9',
      companyId: 'osd',
    });
  });
});
