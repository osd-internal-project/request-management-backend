import { PERMISSIONS_KEY, Principal } from '@request-management/share';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

function principal(): Principal {
  return {
    userId: 'me',
    activeCompanyId: 'osd',
    permissions: ['notification.read'],
  } as unknown as Principal;
}

function harness() {
  const prisma = {
    notification: {
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(3)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const service = new NotificationsService(prisma as never, {} as never);
  return { service, prisma };
}

type Where = Record<string, unknown>;
const whereOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ where: Where }])[0].where;

describe('SUP-03 กล่องแจ้งเตือน', () => {
  it('SUP-03 the bell counts only my unread notifications in the active company', async () => {
    const { service, prisma } = harness();

    await expect(service.unreadCount(principal())).resolves.toEqual({
      count: 3,
    });
    expect(whereOf(prisma.notification.count)).toEqual({
      userId: 'me',
      companyId: 'osd',
      // CD-52: items held for the digest are not in the bell
      heldForDigest: false,
      readAt: null,
    });
  });

  it('SUP-03 unread=true narrows the list; without it read ones stay listed', async () => {
    const { service, prisma } = harness();

    await service.list(principal(), { page: 1, page_size: 20, unread: 'true' });
    await service.list(principal(), { page: 1, page_size: 20 });

    const [unread, all] = prisma.notification.findMany.mock
      .calls as unknown as [{ where: Where }][];
    expect(unread[0].where).toMatchObject({ readAt: null });
    expect(all[0].where).not.toHaveProperty('readAt');
    expect(all[0].where).toMatchObject({ userId: 'me', companyId: 'osd' });
  });

  it('SUP-03 marking read is scoped to the owner — another person’s id changes nothing', async () => {
    const { service, prisma } = harness();

    await service.markRead('someone-elses', principal());

    expect(whereOf(prisma.notification.updateMany)).toEqual({
      id: 'someone-elses',
      userId: 'me',
      readAt: null,
    });
  });

  it('CD-55 opening keeps the FIRST read time and records it as opened', async () => {
    const { service, prisma } = harness();

    await service.markRead('n-1', principal());

    const call = (
      prisma.notification.updateMany.mock.calls[0] as unknown as [
        { where: Where; data: Where },
      ]
    )[0];
    // `readAt: null` in the where: a second open matches nothing, so the
    // original read time survives.
    expect(call.where).toMatchObject({ readAt: null });
    expect(call.data).toMatchObject({ readVia: 'opened' });
  });

  it('CD-55 "อ่านทั้งหมด" is recorded as mark_all, not as having opened each one', async () => {
    const { service, prisma } = harness();

    await service.markAllRead(principal());

    const call = (
      prisma.notification.updateMany.mock.calls[0] as unknown as [
        { where: Where; data: Where },
      ]
    )[0];
    expect(call.where).toMatchObject({ readAt: null });
    expect(call.data).toMatchObject({ readVia: 'mark_all' });
  });

  it('SUP-03 ROLE-01 every inbox route needs notification.read', () => {
    const permissionsOf = (handler: string) =>
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        Object.getOwnPropertyDescriptor(
          NotificationsController.prototype,
          handler,
        )?.value as object,
      ) as string[];

    for (const handler of ['list', 'unreadCount', 'markRead', 'markAllRead']) {
      expect(permissionsOf(handler)).toEqual(['notification.read']);
    }
  });

  it('CD-55 the company-wide log needs audit.read, not the inbox permission', () => {
    expect(
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        Object.getOwnPropertyDescriptor(
          NotificationsController.prototype,
          'searchLog',
        )?.value as object,
      ),
    ).toEqual(['audit.read']);
  });
});
