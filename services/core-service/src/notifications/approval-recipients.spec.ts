import { NotificationsService } from './notifications.service';

const OSD = 'company-osd';

const REQUEST = {
  id: 'req-1',
  requestNo: 'OSD-IT-0012',
  requesterId: 'user-requester',
  receiverUserId: 'user-receiver',
  assigneeUserId: 'user-worker',
  requestType: { name: 'ติดตั้งระบบ' },
};

function approvalCase(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    companyId: OSD,
    status: 'pending',
    currentStep: 1,
    subjectType: 'request:IT',
    requestId: 'req-1',
    createdBy: 'user-requester',
    steps: [
      {
        stepNo: 1,
        candidateUserIds: ['user-a', 'user-b', 'user-requester'],
        approverUserId: 'user-a',
      },
      { stepNo: 2, candidateUserIds: ['user-c'], approverUserId: 'user-c' },
    ],
    ...overrides,
  };
}

function serviceWith(delegates: string[] = []) {
  const sent: { userId: string; eventType: string; resourceType: string }[] =
    [];
  const prisma = {
    request: { findUnique: jest.fn(() => Promise.resolve(REQUEST)) },
    delegation: {
      findMany: jest.fn(() =>
        Promise.resolve(
          delegates.map((delegateUserId) => ({ delegateUserId })),
        ),
      ),
    },
    notification: {
      create: jest.fn(({ data }: { data: (typeof sent)[number] }) => {
        sent.push(data);
        return Promise.resolve({ id: `n-${sent.length}` });
      }),
    },
    notificationDeliveryLog: { create: jest.fn(() => Promise.resolve({})) },
    user: { findUnique: jest.fn(() => Promise.resolve(null)) },
    // CD-54/52: the standard wording, no stored preference.
    notificationTemplate: { findUnique: jest.fn(() => Promise.resolve(null)) },
    notificationPreference: { findUnique: jest.fn(() => Promise.resolve(null)) },
  };
  const service = new NotificationsService(
    prisma as never,
    { isConfigured: false, send: jest.fn() } as never,
  );
  return { service, sent };
}

const recipients = (sent: { userId: string }[]) =>
  sent.map((entry) => entry.userId);

describe('SUP-03: who hears about an approval', () => {
  it('tells every candidate and their delegates, never the requester, and links the request', async () => {
    const { service, sent } = serviceWith(['user-cover']);

    await service.awaitingApproval(approvalCase() as never, OSD);

    expect(recipients(sent)).toEqual(['user-a', 'user-b', 'user-cover']);
    expect(sent[0].resourceType).toBe('request');
  });

  it('tells the requester a level passed, then the next level it is waiting', async () => {
    const { service, sent } = serviceWith();

    await service.decisionMade(
      approvalCase({ currentStep: 2 }) as never,
      'approve',
    );

    expect(sent.map((entry) => [entry.userId, entry.eventType])).toEqual([
      ['user-requester', 'approval.step_passed'],
      ['user-c', 'approval.awaiting'],
    ]);
  });

  it('sends a pre-work send-back to the requester', async () => {
    const { service, sent } = serviceWith();

    await service.decisionMade(
      approvalCase({
        status: 'returned',
        subjectType: 'request:IT:pre',
      }) as never,
      'return',
      'แนบใบเสนอราคา',
    );

    expect(recipients(sent)).toEqual(['user-requester']);
  });

  it('sends an after-work send-back to the team doing the work, not the requester', async () => {
    const { service, sent } = serviceWith();

    await service.decisionMade(
      approvalCase({ status: 'returned' }) as never,
      'return',
    );

    expect(recipients(sent)).toEqual(['user-worker']);
  });

  it('tells both requester and receiver when pre-work approval completes', async () => {
    const { service, sent } = serviceWith();

    await service.decisionMade(
      approvalCase({
        status: 'approved',
        subjectType: 'request:IT:pre',
      }) as never,
      'approve',
    );

    expect(recipients(sent)).toEqual(['user-requester', 'user-receiver']);
  });
});
