import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { keyringFromEnv, type Principal } from '@request-management/share';
import { sealSecret } from '../pm/config-rules';
import { LineLinkService } from './line-link.service';
import { LineLoginClient } from './line-login.client';
import { signState } from './line-rules';
import { LineSettingsService } from './line-settings.service';

const KEY = keyringFromEnv({ CONFIG_SECRET_KEY: 'test-config-secret' });
const STATE_SECRET = 'test-line-state';
const config = new ConfigService({
  projectConfig: { secret: KEY },
  line: { publicUrl: 'https://ctd.test', stateSecret: STATE_SECRET },
});

const actor = {
  userId: 'user-1',
  username: 'nont',
  isServiceAccount: false,
  activeCompanyId: 'company-1',
} as Principal; // only the fields the service reads

function setup(options: { configured?: boolean } = {}) {
  const setting =
    options.configured === false
      ? null
      : {
          companyId: 'company-1',
          loginChannelId: '2001234567',
          loginChannelSecretEnc: sealSecret('channel-secret', KEY),
          oaBasicId: '@osd',
          updatedAt: new Date(),
        };
  const settingRepo = { findFirst: jest.fn(() => Promise.resolve(setting)) };
  const rows: Record<string, unknown>[] = [];
  const accounts = {
    rows,
    findFirst: jest.fn(({ where }: { where: { userId: string } }) =>
      Promise.resolve(rows.find((row) => row.userId === where.userId) ?? null),
    ),
    upsert: jest.fn(
      ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const taken = rows.find(
          (row) =>
            row.lineUserId === create.lineUserId &&
            row.userId !== create.userId,
        );
        if (taken) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const index = rows.findIndex((row) => row.userId === create.userId);
        if (index >= 0) rows[index] = { ...rows[index], ...update };
        else rows.push({ id: `row-${rows.length}`, ...create });
        return Promise.resolve(null);
      },
    ),
    member: jest.fn(
      (_companyId: string, by: { email: string } | { userId: string }) =>
        Promise.resolve(
          ('email' in by ? by.email === 'nont@osd.co.th' : by.userId === 'user-1')
            ? {
                id: 'user-1',
                email: 'nont@osd.co.th',
                displayName: 'นนท์',
                lineAccounts: rows.filter((row) => row.userId === 'user-1'),
              }
            : null,
        ),
    ),
    delete: jest.fn(({ where }: { where: { id: string } }) => {
      rows.splice(
        rows.findIndex((row) => row.id === where.id),
        1,
      );
      return Promise.resolve(null);
    }),
  };
  const tx = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
      work({}),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const fetcher = jest.fn((url: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          url.endsWith('/token')
            ? { id_token: 'id-token' }
            : { sub: 'U-line-nont', name: 'Nont', picture: 'https://p/1' },
        ),
      ),
    ),
  );
  const client = new LineLoginClient();
  client.useFetch(fetcher);
  const settings = new LineSettingsService(
    settingRepo as never,
    tx as never,
    config,
    audit as never,
  );
  const service = new LineLinkService(
    accounts as never,
    settings,
    client,
    tx as never,
    config,
    audit as never,
  );
  return { service, accounts, audit, fetcher };
}

const state = (userId = 'user-1') =>
  signState({ userId, companyId: 'company-1' }, STATE_SECRET);

describe('LINE link', () => {
  it('start returns the LINE Login URL for the active company', async () => {
    const { service } = setup();
    const { url } = await service.start(actor);
    const params = new URL(url).searchParams;
    expect(params.get('client_id')).toBe('2001234567');
    expect(params.get('redirect_uri')).toBe(
      'https://ctd.test/api/public/line/callback',
    );
  });

  it('start refuses a company with no LINE Login channel', async () => {
    const { service } = setup({ configured: false });
    await expect(service.start(actor)).rejects.toMatchObject({
      code: 'LINE_NOT_CONFIGURED',
    });
  });

  it('callback links the LINE LINE verified, with the channel secret opened', async () => {
    const { service, accounts, audit, fetcher } = setup();
    await expect(
      service.complete({
        code: 'c',
        state: state(),
        friendship_status_changed: 'true',
      }),
    ).resolves.toEqual({ ok: true });
    expect(accounts.rows).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        companyId: 'company-1',
        lineUserId: 'U-line-nont',
        displayName: 'Nont',
        isFriend: true,
      }),
    ]);
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain(
      'client_secret=channel-secret',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'line.linked', actorId: 'user-1' }),
      expect.anything(),
    );
    await expect(service.status(actor)).resolves.toMatchObject({
      configured: true,
      linked: { display_name: 'Nont', is_friend: true },
    });
  });

  it('refuses a LINE already linked to someone else in the company', async () => {
    const { service } = setup();
    await service.complete({ code: 'c', state: state('user-2') });
    await expect(
      service.complete({ code: 'c', state: state('user-1') }),
    ).resolves.toEqual({ ok: false, reason: 'LINE_ALREADY_LINKED' });
  });

  it('answers a forged state without calling LINE', async () => {
    const { service, fetcher } = setup();
    await expect(
      service.complete({ code: 'c', state: 'forged.state' }),
    ).resolves.toEqual({ ok: false, reason: 'STATE_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('answers LINE_DENIED when the user cancelled at LINE', async () => {
    const { service } = setup();
    await expect(
      service.complete({ error: 'access_denied', state: state() }),
    ).resolves.toEqual({ ok: false, reason: 'LINE_DENIED' });
  });

  it('answers LINE_ERROR when LINE refuses the code', async () => {
    const { service, fetcher, accounts } = setup();
    fetcher.mockResolvedValueOnce(new Response('bad', { status: 400 }));
    await expect(
      service.complete({ code: 'c', state: state() }),
    ).resolves.toEqual({ ok: false, reason: 'LINE_ERROR' });
    expect(accounts.rows).toHaveLength(0);
  });

  it('unlink removes the row and records it', async () => {
    const { service, accounts, audit } = setup();
    await service.complete({ code: 'c', state: state() });
    await service.unlink(actor);
    expect(accounts.rows).toHaveLength(0);
    expect(audit.record).toHaveBeenLastCalledWith(
      expect.objectContaining({ eventType: 'line.unlinked' }),
      expect.anything(),
    );
  });

  it('recipientFor answers the member’s LINE in the company', async () => {
    const { service } = setup();
    await service.complete({
      code: 'c',
      state: state(),
      friendship_status_changed: 'true',
    });
    await expect(
      service.recipientFor('company-1', { email: 'nont@osd.co.th' }),
    ).resolves.toEqual({
      user_id: 'user-1',
      email: 'nont@osd.co.th',
      display_name: 'นนท์',
      line_user_id: 'U-line-nont',
      line_display_name: 'Nont',
      is_friend: true,
    });
  });

  it('recipientFor finds the member by the user id an approval step names', async () => {
    const { service, accounts } = setup();
    await service.complete({
      code: 'c',
      state: state(),
      friendship_status_changed: 'true',
    });
    await expect(
      service.recipientFor('company-1', { userId: 'user-1' }),
    ).resolves.toMatchObject({
      user_id: 'user-1',
      email: 'nont@osd.co.th',
      line_user_id: 'U-line-nont',
    });
    expect(accounts.member).toHaveBeenLastCalledWith('company-1', {
      userId: 'user-1',
    });
    await expect(
      service.recipientFor('company-1', { userId: 'user-elsewhere' }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: [{ field: 'user_id', reason: 'not_found' }],
    });
  });

  it('recipientFor tells not-linked from not-a-member', async () => {
    const { service } = setup();
    await expect(
      service.recipientFor('company-1', { email: 'nont@osd.co.th' }),
    ).rejects.toMatchObject({ code: 'LINE_NOT_LINKED' });
    await expect(
      service.recipientFor('company-1', { email: 'stranger@x.com' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
