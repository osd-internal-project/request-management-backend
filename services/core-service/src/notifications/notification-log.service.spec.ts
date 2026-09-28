import type { Principal } from '@request-management/share';
import { NotificationLogService } from './notification-log.service';

const OSD = 'company-osd';

function auditor(): Principal {
  return {
    userId: 'auditor',
    activeCompanyId: OSD,
    companies: [{ id: OSD, name: 'OSD', docPrefix: 'OSD', isPrimary: true }],
    permissions: ['audit.read'],
  } as unknown as Principal;
}

const row = {
  id: 'n-1',
  createdAt: new Date('2026-09-28T02:00:00Z'),
  eventType: 'approval.requested',
  title: 'มีคำขอรออนุมัติ',
  body: 'REQ-1',
  resourceType: 'request',
  resourceId: 'req-1',
  readAt: new Date('2026-09-28T03:00:00Z'),
  readVia: 'opened',
  user: {
    id: 'u-1',
    displayName: 'สมชาย',
    username: 'somchai',
    email: 'somchai@example.com',
  },
  deliveries: [
    {
      channel: 'in_app',
      target: 'u-1',
      status: 'sent',
      error: null,
      sentAt: new Date('2026-09-28T02:00:00Z'),
      createdAt: new Date('2026-09-28T02:00:00Z'),
    },
  ],
};

function harness() {
  const prisma = {
    notification: {
      findMany: jest.fn(() => Promise.resolve([row])),
      count: jest.fn(() => Promise.resolve(1)),
    },
  };
  return { service: new NotificationLogService(prisma as never), prisma };
}

type Where = Record<string, unknown>;
const whereOf = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ where: Where }])[0].where;

describe('CD-55 NotificationLogService', () => {
  it('CD-55: who, when, which channel, and whether it was read — for one company', async () => {
    const { service, prisma } = harness();

    const page = await service.search({ page: 1, page_size: 50 }, auditor());

    expect(whereOf(prisma.notification.findMany)).toEqual({ companyId: OSD });
    expect(page.total).toBe(1);
    expect(page.data[0]).toMatchObject({
      recipient: { username: 'somchai' },
      event_type: 'approval.requested',
      read_at: '2026-09-28T03:00:00.000Z',
      read_via: 'opened',
      deliveries: [{ channel: 'in_app', status: 'sent' }],
    });
  });

  it('read=unread asks for never-read; opened / mark_all ask for how it was read', async () => {
    for (const [read, expected] of [
      ['unread', { readAt: null }],
      ['opened', { readVia: 'opened' }],
      ['mark_all', { readVia: 'mark_all' }],
    ] as const) {
      const { service, prisma } = harness();
      await service.search({ page: 1, page_size: 50, read }, auditor());
      expect(whereOf(prisma.notification.findMany)).toMatchObject(expected);
    }
  });

  it('q searches the recipient and the title; the other filters narrow exactly', async () => {
    const { service, prisma } = harness();

    await service.search(
      {
        page: 1,
        page_size: 50,
        q: ' somchai ',
        event_type: 'sla.breached',
        resource_type: 'request',
        resource_id: 'req-1',
        from: '2026-09-01T00:00:00Z',
      },
      auditor(),
    );

    const where = whereOf(prisma.notification.findMany);
    expect(where).toMatchObject({
      companyId: OSD,
      eventType: 'sla.breached',
      resourceType: 'request',
      resourceId: 'req-1',
      createdAt: { gte: new Date('2026-09-01T00:00:00Z') },
    });
    expect(JSON.stringify(where.OR)).toContain('"contains":"somchai"');
  });

  it('SCOPE-03: another company the auditor does not belong to is refused', async () => {
    const { service } = harness();
    await expect(
      service.search(
        { page: 1, page_size: 50, company_id: 'company-other' },
        auditor(),
      ),
    ).rejects.toThrow();
  });
});
