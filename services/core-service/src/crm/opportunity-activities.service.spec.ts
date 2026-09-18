import { PERMISSIONS_KEY, Principal } from '@request-management/share';
import { OpportunityActivitiesService } from './opportunity-activities.service';
import { OpportunitiesController } from './sales.controllers';

function principal(): Principal {
  return {
    userId: 'me',
    username: 'me',
    isServiceAccount: false,
    displayName: 'ทดสอบ ขาย',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions: ['crm.sales.read', 'crm.sales.manage'],
  } as unknown as Principal;
}

const OPEN = {
  id: 'opp-1',
  opportunityCode: 'OPP-OSD-000001',
  stage: 'proposing',
  customerId: 'cust-1',
};

function harness(
  options: {
    found?: Record<string, unknown> | null;
    activity?: { id: string } | null;
    lastDone?: Date | null;
    nextDue?: Date | null;
    staleAlertedAt?: Date | null;
  } = {},
) {
  const audits: { eventType: string }[] = [];
  const timelineEvents: { eventType: string }[] = [];
  const summaryWrites: Record<string, unknown>[] = [];

  const opportunities = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.found === undefined ? OPEN : options.found),
    ),
  };
  const activities = {
    findMany: jest.fn(() =>
      Promise.resolve([
        { id: 'a1', createdBy: 'me', completedBy: 'me' },
        { id: 'a2', createdBy: 'ghost', completedBy: null },
      ]),
    ),
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.activity === undefined ? { id: 'a1' } : options.activity,
      ),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'a-new' })),
    update: jest.fn(() => Promise.resolve({ id: 'a1' })),
  };
  const members = {
    findMany: jest.fn(() =>
      Promise.resolve([{ id: 'me', displayName: 'ทดสอบ ขาย' }]),
    ),
  };
  const timeline = {
    publish: jest.fn((event: { eventType: string }) => {
      timelineEvents.push(event);
      return Promise.resolve();
    }),
  };
  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };

  // Called in order: last completed, next pending due.
  const activityLookups = [
    options.lastDone === undefined
      ? { completedAt: new Date('2026-09-18T03:00:00Z') }
      : options.lastDone && { completedAt: options.lastDone },
    options.nextDue ? { dueAt: options.nextDue } : null,
  ];
  const tx = {
    opportunityActivity: {
      findFirst: jest.fn(() => Promise.resolve(activityLookups.shift())),
    },
    opportunity: {
      findUnique: jest.fn(() =>
        Promise.resolve({ staleAlertedAt: options.staleAlertedAt ?? null }),
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        summaryWrites.push(args.data);
        return Promise.resolve({});
      }),
    },
  };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
      work(tx),
    ),
  };

  const service = new OpportunityActivitiesService(
    opportunities as never,
    activities as never,
    members as never,
    timeline as never,
    audit as never,
    transactions as never,
  );

  return { service, activities, audits, timelineEvents, summaryWrites };
}

describe('CD-65 กิจกรรมและการติดตามบนโอกาสการขาย', () => {
  it('CD-65 a logged activity without due_at is completed immediately and becomes lastActivityAt', async () => {
    const { service, activities, audits, timelineEvents, summaryWrites } =
      harness({ lastDone: new Date('2026-09-18T03:00:00Z') });

    await service.add(
      'opp-1',
      { type: 'call', subject: ' โทรคุยขอบเขต ' },
      principal(),
    );

    const created = (
      activities.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(created.subject).toBe('โทรคุยขอบเขต');
    expect(created.completedAt).toBeInstanceOf(Date);
    expect(created.completedBy).toBe('me');
    expect(summaryWrites[0].lastActivityAt).toEqual(
      new Date('2026-09-18T03:00:00Z'),
    );
    expect(audits.map((a) => a.eventType)).toEqual([
      'crm.opportunity.activity_logged',
    ]);
    expect(timelineEvents[0].eventType).toBe('opportunity.activity_logged');
  });

  it('CD-65 a follow-up with due_at stays open and sets nextFollowUpAt', async () => {
    const due = new Date('2026-09-25T02:00:00Z');
    const { service, activities, summaryWrites, timelineEvents } = harness({
      lastDone: null,
      nextDue: due,
    });

    await service.add(
      'opp-1',
      { type: 'meeting', subject: 'นัดเดโม', due_at: due.toISOString() },
      principal(),
    );

    const created = (
      activities.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(created.completedAt).toBeNull();
    expect(summaryWrites[0]).toMatchObject({
      lastActivityAt: null,
      nextFollowUpAt: due,
    });
    expect(timelineEvents[0].eventType).toBe(
      'opportunity.follow_up_scheduled',
    );
  });

  it('CD-65 new completed work after a stale alert clears staleAlertedAt', async () => {
    const { service, summaryWrites } = harness({
      staleAlertedAt: new Date('2026-09-10T00:00:00Z'),
      lastDone: new Date('2026-09-18T03:00:00Z'),
    });

    await service.update('opp-1', 'a1', { completed: true }, principal());

    expect(summaryWrites[0]).toHaveProperty('staleAlertedAt', null);
  });

  it('CD-65 an open follow-up alone does not clear a stale alert', async () => {
    const { service, summaryWrites } = harness({
      staleAlertedAt: new Date('2026-09-10T00:00:00Z'),
      lastDone: new Date('2026-09-01T00:00:00Z'),
      nextDue: new Date('2026-09-25T00:00:00Z'),
    });

    await service.add(
      'opp-1',
      { type: 'task', subject: 'ตามใบเสนอราคา', due_at: '2026-09-25T00:00:00Z' },
      principal(),
    );

    expect(summaryWrites[0]).not.toHaveProperty('staleAlertedAt');
  });

  it('CD-65 SCOPE-03 an opportunity outside scope or company answers 404', async () => {
    const { service, activities } = harness({ found: null });

    await expect(
      service.add('opp-x', { type: 'note', subject: 'x' }, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.list('opp-x', principal())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(activities.create).not.toHaveBeenCalled();
  });

  it('CD-65 a closed opportunity refuses new activities but its history stays readable', async () => {
    const { service } = harness({ found: { ...OPEN, stage: 'won' } });

    await expect(
      service.add('opp-1', { type: 'note', subject: 'x' }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const rows = await service.list('opp-1', principal());
    expect(rows).toHaveLength(2);
    // Unknown ids come back as the id — not a made-up name.
    expect(rows[1]).toMatchObject({ createdByName: 'ghost' });
  });

  it('CD-65 an activity of another opportunity answers 404', async () => {
    const { service, activities } = harness({ activity: null });

    await expect(
      service.update('opp-1', 'foreign', { completed: true }, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(activities.update).not.toHaveBeenCalled();
  });

  it('CD-65 ROLE-01 reading needs crm.sales.read, writing needs crm.sales.manage', () => {
    const permissionsOf = (handler: string) =>
      Reflect.getMetadata(
        PERMISSIONS_KEY,
        Object.getOwnPropertyDescriptor(OpportunitiesController.prototype, handler)
          ?.value as object,
      ) as string[];

    expect(permissionsOf('listActivities')).toEqual(['crm.sales.read']);
    expect(permissionsOf('addActivity')).toEqual(['crm.sales.manage']);
    expect(permissionsOf('updateActivity')).toEqual(['crm.sales.manage']);
  });
});
