import type { Principal } from '@request-management/share';
import { DEFAULT_CALENDAR } from '../sla/business-hours';
import { categoryOf, digestDue, settingOf } from './notification-categories';
import { templateOf } from './notification-templates';
import {
  NotificationDigestService,
  digestParts,
} from './notification-digest.service';
import { NotificationsService } from './notifications.service';

// Monday 28 Sep 2026, Bangkok = UTC+7
const MON_0759 = new Date('2026-09-28T00:59:00Z');
const MON_0800 = new Date('2026-09-28T01:00:00Z');
const SAT_0900 = new Date('2026-10-03T02:00:00Z');

describe('CD-52 categories and the digest clock', () => {
  it('event types map to what a person chooses between', () => {
    expect(categoryOf('approval.awaiting')).toBe('approval');
    expect(categoryOf('approval.rejected')).toBe('my_requests');
    expect(categoryOf('sla.breached')).toBe('sla');
    expect(categoryOf('sla.response_overdue')).toBe('sla');
    expect(categoryOf('crm.opportunity.stale')).toBe('crm');
    expect(categoryOf('something.new')).toBe('other');
  });

  it('an overdue approval is urgent, never held for a digest', () => {
    expect(categoryOf('approval.overdue')).toBe('sla');
    expect(categoryOf('approval.escalated')).toBe('sla');
    expect(categoryOf('approval.withdrawn')).toBe('approval');
    expect(categoryOf('approval.step_passed')).toBe('my_requests');
  });

  it('every event the service sends has a template, so rendering never throws', () => {
    for (const eventType of [
      'approval.awaiting',
      'approval.step_passed',
      'approval.approved',
      'approval.rejected',
      'approval.returned',
      'approval.withdrawn',
      'approval.overdue',
      'approval.escalated',
      'sla.warning',
      'sla.breached',
    ]) {
      expect(templateOf(eventType)).toBeDefined();
    }
  });

  it('defaults to email on, immediate; SLA can never be held even if stored so', () => {
    expect(settingOf(null, 'approval')).toEqual({
      email: true,
      frequency: 'immediate',
    });
    const stored = {
      approval: { email: false, frequency: 'daily' },
      sla: { frequency: 'daily' },
    };
    expect(settingOf(stored, 'approval')).toEqual({
      email: false,
      frequency: 'daily',
    });
    expect(settingOf(stored, 'sla').frequency).toBe('immediate');
  });

  it('CD-52: due from the chosen hour on a working day, once a day', () => {
    expect(digestDue(MON_0759, 8, null, DEFAULT_CALENDAR)).toEqual({
      due: false,
      date: '2026-09-28',
    });
    expect(digestDue(MON_0800, 8, null, DEFAULT_CALENDAR).due).toBe(true);
    expect(digestDue(MON_0800, 8, '2026-09-28', DEFAULT_CALENDAR).due).toBe(
      false,
    );
    expect(digestDue(MON_0800, 8, '2026-09-25', DEFAULT_CALENDAR).due).toBe(
      true,
    );
  });

  it('weekends and company holidays skip — held items wait for the next working day', () => {
    expect(digestDue(SAT_0900, 8, null, DEFAULT_CALENDAR).due).toBe(false);
    expect(
      digestDue(MON_0800, 8, null, {
        ...DEFAULT_CALENDAR,
        holidays: ['2026-09-28'],
      }).due,
    ).toBe(false);
  });

  it('the digest parts count per category and list the first items', () => {
    const held = Array.from({ length: 17 }, (_, i) => ({
      eventType: i < 16 ? 'approval.awaiting' : 'crm.opportunity.stale',
      title: `t${i}`,
      body: `b${i}`,
    }));
    const parts = digestParts(held);
    expect(parts.summary).toBe('รออนุมัติจากคุณ 16 · เตือนงานขาย 1');
    const items = parts.items.split('\n');
    expect(items).toHaveLength(15 + 1);
    expect(items.at(-1)).toBe('และอีก 2 รายการ');
  });
});

/** Just enough Prisma for emit(): a preference row and the writes. */
function emitHarness(preference: Record<string, unknown> | null) {
  const created: Record<string, unknown>[] = [];
  const logs: Record<string, unknown>[] = [];
  const prisma = {
    notificationPreference: {
      findUnique: jest.fn(() => Promise.resolve(preference)),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    notification: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return Promise.resolve({ id: 'n-1', ...args.data });
      }),
    },
    notificationDeliveryLog: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        logs.push(args.data);
        return Promise.resolve({});
      }),
    },
    user: {
      findUnique: jest.fn(() => Promise.resolve({ email: 'a@example.com' })),
    },
    // CD-54: no company wording → the standard; letterhead for the signature
    notificationTemplate: { findUnique: jest.fn(() => Promise.resolve(null)) },
    delegation: { findMany: jest.fn(() => Promise.resolve([])) },
    company: {
      findUnique: jest.fn(() =>
        Promise.resolve({ name: 'OSD', crmConfig: null }),
      ),
    },
  };
  const email = { isConfigured: false, send: jest.fn(() => Promise.resolve()) };
  const service = new NotificationsService(prisma as never, email as never);
  return { service, prisma, created, logs, email };
}

const approvalCase = {
  id: 'case-1',
  companyId: 'osd',
  subjectType: 'request:DSC',
  status: 'pending',
  currentStep: 1,
  steps: [{ stepNo: 1, approverUserId: 'approver', candidateUserIds: [] }],
} as never;

describe('CD-52 NotificationsService.emit honours the person’s choice', () => {
  it('CD-52: an approver on daily digest gets a held row, logged queued, no email yet', async () => {
    const { service, created, logs, email } = emitHarness({
      emailEnabled: true,
      categorySettings: { approval: { email: true, frequency: 'daily' } },
    });

    await service.awaitingApproval(approvalCase, 'osd');

    expect(created[0]).toMatchObject({ heldForDigest: true });
    expect(logs).toEqual([
      expect.objectContaining({
        channel: 'in_app',
        status: 'queued',
        sentAt: null,
      }),
    ]);
    expect(email.send).not.toHaveBeenCalled();
  });

  it('immediate by default: in the bell now, and email attempted', async () => {
    const { service, created, logs, email } = emitHarness(null);

    await service.awaitingApproval(approvalCase, 'osd');

    expect(created[0]).toMatchObject({ heldForDigest: false });
    expect(logs.map((log) => [log.channel, log.status])).toEqual([
      ['in_app', 'sent'],
      ['email', 'failed'], // no SMTP yet — recorded, not hidden
    ]);
    expect(email.send).toHaveBeenCalledTimes(1);
  });

  it('CD-52: switching email off is honoured — it used to be recorded and ignored', async () => {
    for (const preference of [
      { emailEnabled: false, categorySettings: null },
      {
        emailEnabled: true,
        categorySettings: { approval: { email: false } },
      },
    ]) {
      const { service, email, logs } = emitHarness(preference);
      await service.awaitingApproval(approvalCase, 'osd');
      expect(email.send).not.toHaveBeenCalled();
      expect(logs.map((log) => log.channel)).toEqual(['in_app']);
    }
  });

  it('a decision is named approval.rejected, not approval.rejectd', async () => {
    const { service, created } = emitHarness(null);
    await service.decisionMade(
      {
        ...(approvalCase as object),
        status: 'rejected',
        createdBy: 'requester',
      } as never,
      'reject',
    );
    expect(created[0]).toMatchObject({ eventType: 'approval.rejected' });
  });
});

describe('CD-52 updatePreferences', () => {
  const me = { userId: 'me', activeCompanyId: 'osd' } as Principal;

  it('refuses a daily digest for SLA alerts', async () => {
    const { service } = emitHarness(null);
    await expect(
      service.updatePreferences(me, {
        categories: { sla: { frequency: 'daily' } },
      }),
    ).rejects.toThrow('ต้องส่งทันที');
  });

  it('merges the change over what was saved and stores every category', async () => {
    const { service, prisma } = emitHarness({
      emailEnabled: true,
      categorySettings: { crm: { email: false, frequency: 'daily' } },
    });
    await service.updatePreferences(me, {
      digest_hour: 7,
      categories: { approval: { frequency: 'daily' } },
    });
    const call = (
      prisma.notificationPreference.upsert.mock.calls[0] as unknown as [
        { update: Record<string, unknown> },
      ]
    )[0];
    expect(call.update).toEqual({
      digestHour: 7,
      categorySettings: {
        approval: { email: true, frequency: 'daily' },
        my_requests: { email: true, frequency: 'immediate' },
        crm: { email: false, frequency: 'daily' },
        sla: { email: true, frequency: 'immediate' },
      },
    });
  });
});

describe('CD-52 NotificationDigestService.sweep', () => {
  function sweepHarness(options: {
    preference: Record<string, unknown> | null;
    held: { id: string; eventType: string; title: string; body: string }[];
    claimed?: number;
  }) {
    const prisma = {
      notification: {
        groupBy: jest.fn(() =>
          Promise.resolve(
            options.held.length ? [{ userId: 'u', companyId: 'osd' }] : [],
          ),
        ),
        findMany: jest.fn(() => Promise.resolve(options.held)),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'digest-1', ...args.data }),
        ),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      },
      notificationPreference: {
        findUnique: jest.fn(() => Promise.resolve(options.preference)),
        updateMany: jest.fn(() =>
          Promise.resolve({ count: options.claimed ?? 1 }),
        ),
        create: jest.fn(() => Promise.resolve({})),
      },
      notificationDeliveryLog: {
        create: jest.fn(() => Promise.resolve({})),
        updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
      },
      holidayCalendar: { findUnique: jest.fn(() => Promise.resolve(null)) },
    };
    const notifications = {
      deliverEmail: jest.fn(() => Promise.resolve()),
      queueTeams: jest.fn(() => Promise.resolve()),
      render: jest.fn(
        (_company: string, _event: string, values: Record<string, string>) =>
          Promise.resolve({
            title: `สรุปการแจ้งเตือนประจำวัน · ${values.count} รายการ`,
            body: `${values.summary}\n${values.items}`,
          }),
      ),
    };
    const service = new NotificationDigestService(
      prisma as never,
      notifications as never,
      { get: jest.fn(() => 0) } as never,
    );
    return { service, prisma, notifications };
  }

  const held = [
    {
      id: 'n-1',
      eventType: 'approval.awaiting',
      title: 'รออนุมัติ',
      body: 'A',
    },
    {
      id: 'n-2',
      eventType: 'approval.awaiting',
      title: 'รออนุมัติ',
      body: 'B',
    },
  ];
  const preference = {
    id: 'p-1',
    emailEnabled: true,
    digestHour: 8,
    lastDigestDate: '2026-09-25',
    categorySettings: { approval: { email: true, frequency: 'daily' } },
  };

  it('CD-52: at the hour, one digest carries the held items; their in-app delivery becomes sent', async () => {
    const { service, prisma, notifications } = sweepHarness({
      preference,
      held,
    });

    await expect(service.sweep(MON_0800)).resolves.toBe(1);

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventType: 'notification.digest',
        title: 'สรุปการแจ้งเตือนประจำวัน · 2 รายการ',
      }) as unknown,
    });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['n-1', 'n-2'] } },
      data: { digestId: 'digest-1' },
    });
    expect(prisma.notificationDeliveryLog.updateMany).toHaveBeenCalledWith({
      where: {
        notificationId: { in: ['n-1', 'n-2'] },
        channel: 'in_app',
        status: 'queued',
      },
      data: { status: 'sent', sentAt: MON_0800 },
    });
    expect(notifications.deliverEmail).toHaveBeenCalledTimes(1);
    // CD-51 — the digest goes to Teams too (a no-op while the channel is off)
    expect(notifications.queueTeams).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
    );
  });

  it('before the hour, or already claimed today by another tick, nothing is sent', async () => {
    const early = sweepHarness({ preference, held });
    await expect(early.service.sweep(MON_0759)).resolves.toBe(0);
    expect(early.prisma.notification.create).not.toHaveBeenCalled();

    const raced = sweepHarness({ preference, held, claimed: 0 });
    await expect(raced.service.sweep(MON_0800)).resolves.toBe(0);
    expect(raced.prisma.notification.create).not.toHaveBeenCalled();
  });

  it('email off for the category: the digest is in-app only', async () => {
    const { service, notifications } = sweepHarness({
      preference: {
        ...preference,
        categorySettings: { approval: { email: false, frequency: 'daily' } },
      },
      held,
    });
    await service.sweep(MON_0800);
    expect(notifications.deliverEmail).not.toHaveBeenCalled();
  });
});
