import { NotificationsService } from '../notifications.service';
import { MockTeamsClient } from './mock-teams.client';
import {
  BotFrameworkTeamsClient,
  adaptiveCard,
} from './teams-botframework.client';
import { TeamsPermanentError, type TeamsClient } from './teams-client';
import {
  TEAMS_MAX_ATTEMPTS,
  TeamsDeliveryService,
} from './teams-delivery.service';

const config = (values: Record<string, unknown>) =>
  ({ get: jest.fn((key: string) => values[key]) }) as never;

interface LogRow {
  id: string;
  channel: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  target: string;
  error?: string | null;
  sentAt?: Date | null;
  notification: { userId: string; title: string; body: string };
}

function workerHarness(client: TeamsClient | null, email = 'a@osd.co.th') {
  const rows: LogRow[] = [
    {
      id: 'log-1',
      channel: 'teams',
      status: 'queued',
      attempts: 0,
      nextAttemptAt: null,
      target: 'user-1',
      notification: { userId: 'user-1', title: 'รออนุมัติ', body: 'REQ-1' },
    },
  ];
  const due = (row: LogRow, now: Date) =>
    row.status === 'queued' &&
    (!row.nextAttemptAt || row.nextAttemptAt.getTime() <= now.getTime());
  let now = new Date();
  const prisma = {
    notificationDeliveryLog: {
      findMany: jest.fn(() =>
        Promise.resolve(rows.filter((row) => due(row, now))),
      ),
      updateMany: jest.fn(
        (args: {
          where: { id: string; attempts: number };
          data: Partial<LogRow>;
        }) => {
          const hit = rows.filter(
            (row) =>
              row.id === args.where.id &&
              row.status === 'queued' &&
              row.attempts === args.where.attempts,
          );
          hit.forEach((row) => Object.assign(row, args.data));
          return Promise.resolve({ count: hit.length });
        },
      ),
      update: jest.fn(
        (args: { where: { id: string }; data: Partial<LogRow> }) => {
          const row = rows.find((r) => r.id === args.where.id) as LogRow;
          Object.assign(row, args.data);
          return Promise.resolve(row);
        },
      ),
    },
    user: {
      findUnique: jest.fn(() => Promise.resolve(email ? { email } : null)),
    },
  };
  const service = new TeamsDeliveryService(
    prisma as never,
    config({ 'teams.publicWebUrl': 'https://ctd.osd.co.th/' }),
    client,
  );
  return {
    service,
    rows,
    at: (next: Date) => {
      now = next;
      return next;
    },
  };
}

describe('CD-51 TeamsDeliveryService', () => {
  it('sends a queued message with a link back and records it as sent to the email', async () => {
    const client = new MockTeamsClient();
    const h = workerHarness(client);
    expect(await h.service.deliverDue()).toEqual({
      sent: 1,
      failed: 0,
      retrying: 0,
    });
    expect(h.rows[0]).toMatchObject({
      status: 'sent',
      target: 'a@osd.co.th',
      attempts: 1,
      nextAttemptAt: null,
    });
    expect(client.sent[0]).toEqual({
      recipient: { userId: 'user-1', email: 'a@osd.co.th' },
      message: {
        title: 'รออนุมัติ',
        body: 'REQ-1',
        link: 'https://ctd.osd.co.th/pages/notifications',
      },
    });
    // nothing left — a second tick sends nothing twice
    expect((await h.service.deliverDue()).sent).toBe(0);
  });

  it('a passing failure backs off and retries; after the last try it is failed', async () => {
    const send = jest.fn(() => Promise.reject(new Error('HTTP 429')));
    const h = workerHarness({ mode: 'mock', send });
    const start = h.at(new Date('2026-09-29T08:00:00Z'));

    expect(await h.service.deliverDue(start)).toMatchObject({ retrying: 1 });
    expect(h.rows[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(h.rows[0].nextAttemptAt?.getTime()).toBe(start.getTime() + 60_000);
    expect(h.rows[0].error).toBe('HTTP 429');

    // not due yet — left alone
    expect(await h.service.deliverDue(start)).toMatchObject({ retrying: 0 });

    let clock = start.getTime();
    for (let attempt = 2; attempt <= TEAMS_MAX_ATTEMPTS; attempt += 1) {
      clock = (h.rows[0].nextAttemptAt as Date).getTime();
      await h.service.deliverDue(h.at(new Date(clock)));
    }
    expect(send).toHaveBeenCalledTimes(TEAMS_MAX_ATTEMPTS);
    expect(h.rows[0]).toMatchObject({ status: 'failed', attempts: 5 });
  });

  it('a permanent error fails at once; a person without email never reaches Teams', async () => {
    const permanent = workerHarness({
      mode: 'mock',
      send: () =>
        Promise.reject(
          new TeamsPermanentError('ไม่พบ a@osd.co.th ใน Microsoft 365'),
        ),
    });
    expect(await permanent.service.deliverDue()).toMatchObject({ failed: 1 });
    expect(permanent.rows[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'ไม่พบ a@osd.co.th ใน Microsoft 365',
    });

    const send = jest.fn();
    const noEmail = workerHarness({ mode: 'mock', send }, '');
    expect(await noEmail.service.deliverDue()).toMatchObject({ failed: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing when the channel is off', async () => {
    const h = workerHarness(null);
    expect(await h.service.deliverDue()).toEqual({
      sent: 0,
      failed: 0,
      retrying: 0,
    });
    expect(h.rows[0].status).toBe('queued');
  });
});

describe('CD-51 NotificationsService queues Teams', () => {
  function emitHarness(teams: TeamsClient | null, teamsEnabled?: boolean) {
    const logs: Record<string, unknown>[] = [];
    const prisma = {
      notificationTemplate: {
        findUnique: jest.fn(() => Promise.resolve(null)),
      },
      notificationPreference: {
        findUnique: jest.fn(() =>
          Promise.resolve(
            teamsEnabled === undefined
              ? null
              : { emailEnabled: false, teamsEnabled, categorySettings: null },
          ),
        ),
      },
      notification: {
        create: jest.fn(() => Promise.resolve({ id: 'n-1' })),
      },
      notificationDeliveryLog: {
        create: jest.fn((args: { data: Record<string, unknown> }) => {
          logs.push(args.data);
          return Promise.resolve({});
        }),
      },
      user: { findUnique: jest.fn(() => Promise.resolve(null)) },
      company: { findUnique: jest.fn(() => Promise.resolve(null)) },
    };
    const service = new NotificationsService(
      prisma as never,
      { isConfigured: false, send: jest.fn() } as never,
      teams,
    );
    return { service, logs };
  }

  const stale = (service: NotificationsService) =>
    service.opportunityStale(
      'owner-1',
      'osd',
      { id: 'opp-1', opportunityCode: 'OPP-1', title: 'ดีล' },
      14,
    );

  it('queues one teams row when the channel is on and the person has not turned it off', async () => {
    const on = emitHarness(new MockTeamsClient());
    await stale(on.service);
    expect(on.logs.map((log) => [log.channel, log.status])).toEqual([
      ['in_app', 'sent'],
      // (no email row: this person has no address)
      ['teams', 'queued'],
    ]);

    const optedOut = emitHarness(new MockTeamsClient(), false);
    await stale(optedOut.service);
    expect(optedOut.logs.map((log) => log.channel)).toEqual(['in_app']);

    const off = emitHarness(null);
    await stale(off.service);
    expect(off.logs.map((log) => log.channel)).not.toContain('teams');
  });

  it('preferences say whether Teams exists at all', async () => {
    const off = emitHarness(null);
    const view = await off.service.getPreferences({
      userId: 'u',
      activeCompanyId: 'osd',
    } as never);
    expect(view).toMatchObject({ teams: true, teams_available: false });
  });
});

describe('CD-51 BotFrameworkTeamsClient', () => {
  function botHarness(options: { found?: boolean; installed?: boolean } = {}) {
    const links = new Map<string, { conversationId: string }>();
    const prisma = {
      teamsChatLink: {
        findUnique: jest.fn((args: { where: { userId: string } }) =>
          Promise.resolve(links.get(args.where.userId) ?? null),
        ),
        upsert: jest.fn(
          (args: { create: { userId: string; conversationId: string } }) => {
            links.set(args.create.userId, args.create);
            return Promise.resolve({});
          },
        ),
        deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      },
    };
    const client = new BotFrameworkTeamsClient(
      config({
        'teams.bot': {
          tenantId: 'tenant-1',
          appId: 'app-1',
          appPassword: 'secret',
          serviceUrl: 'https://smba.example/apac',
        },
      }),
      prisma as never,
    );
    const calls: { url: string; body?: string }[] = [];
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    client.useFetch((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.includes('login.microsoftonline.com')) {
        return json(200, { access_token: 'tok', expires_in: 3600 });
      }
      if (url.startsWith('https://graph.microsoft.com')) {
        return json(200, {
          value: options.found === false ? [] : [{ id: 'aad-1' }],
        });
      }
      if (url.endsWith('/v3/conversations')) {
        return options.installed === false
          ? json(403, { error: 'not installed' })
          : json(201, { id: 'a:conv-1' });
      }
      return json(201, { id: 'activity-1' });
    });
    return { client, calls, links };
  }

  const recipient = { userId: 'user-1', email: "o'brien@osd.co.th" };
  const message = { title: 'หัวข้อ', body: 'เนื้อหา', link: 'https://x/y' };

  it('finds the person, opens the 1:1 chat once, and sends an Adaptive Card', async () => {
    const { client, calls, links } = botHarness();
    await client.send(recipient, message);
    await client.send(recipient, message);

    // one token per scope (cached), one lookup, one conversation, two sends
    expect(calls.filter((c) => c.url.includes('login.')).length).toBe(2);
    const lookup = calls.filter((c) => c.url.startsWith('https://graph'));
    expect(lookup).toHaveLength(1);
    expect(decodeURIComponent(lookup[0].url)).toContain(
      "mail eq 'o''brien@osd.co.th'",
    );
    const opened = calls.filter((c) => c.url.endsWith('/v3/conversations'));
    expect(opened).toHaveLength(1);
    expect(JSON.parse(opened[0].body as string)).toMatchObject({
      isGroup: false,
      bot: { id: '28:app-1' },
      members: [{ id: 'aad-1' }],
      channelData: { tenant: { id: 'tenant-1' } },
    });
    const sends = calls.filter((c) => c.url.includes('/activities'));
    expect(sends).toHaveLength(2);
    expect(sends[0].url).toBe(
      'https://smba.example/apac/v3/conversations/a%3Aconv-1/activities',
    );
    const sent = JSON.parse(sends[0].body as string) as {
      attachments: { content: unknown }[];
    };
    expect(sent.attachments[0].content).toEqual(adaptiveCard(message));
    expect(links.get('user-1')).toMatchObject({ conversationId: 'a:conv-1' });
  });

  it('someone missing from Microsoft 365, or without the app, is a permanent failure', async () => {
    await expect(
      botHarness({ found: false }).client.send(recipient, message),
    ).rejects.toBeInstanceOf(TeamsPermanentError);
    await expect(
      botHarness({ installed: false }).client.send(recipient, message),
    ).rejects.toBeInstanceOf(TeamsPermanentError);
  });

  it('names every missing setting', () => {
    expect(BotFrameworkTeamsClient.missingSettings({ tenantId: 't' })).toEqual([
      'TEAMS_BOT_APP_ID',
      'TEAMS_BOT_APP_PASSWORD',
      'TEAMS_SERVICE_URL',
    ]);
  });
});
