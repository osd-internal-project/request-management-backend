import { ConfigService } from '@nestjs/config';
import { keyringFromEnv, type Principal } from '@request-management/share';
import { openSecret } from '../pm/config-rules';
import { LineSettingsService } from './line-settings.service';

const KEY = keyringFromEnv({ CONFIG_SECRET_KEY: 'test-config-secret' });
const admin = {
  userId: 'admin-1',
  username: 'admin',
  isServiceAccount: false,
  activeCompanyId: 'company-1',
} as Principal; // only the fields the service reads

function setup() {
  let row: Record<string, unknown> | null = null;
  const repo = {
    findFirst: jest.fn(() => Promise.resolve(row)),
    upsert: jest.fn(
      ({
        create,
        update,
      }: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        row = { ...(row ?? create), ...update, updatedAt: new Date() };
        return Promise.resolve(row);
      },
    ),
  };
  const tx = {
    execute: jest.fn((work: (prisma: unknown) => Promise<unknown>) =>
      work({}),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new LineSettingsService(
    repo as never,
    tx as never,
    new ConfigService({
      projectConfig: { secret: KEY },
      line: { publicUrl: 'https://ctd.test/' },
    }),
    audit as never,
  );
  return { service, audit, row: () => row };
}

describe('LINE settings', () => {
  it('seals the secret, never returns it, and keeps it when left blank', async () => {
    const { service, row } = setup();
    const saved = await service.update(
      {
        login_channel_id: '2001234567',
        login_channel_secret: 'channel-secret',
        oa_basic_id: '@osd',
      },
      admin,
    );
    expect(saved).toEqual({
      login_channel_id: '2001234567',
      login_channel_secret_set: true,
      oa_basic_id: '@osd',
      callback_url: 'https://ctd.test/api/public/line/callback',
      updated_at: expect.any(String),
    });
    expect(JSON.stringify(saved)).not.toContain('channel-secret');
    const sealed = row()?.loginChannelSecretEnc as string;
    expect(openSecret(sealed, KEY)).toBe('channel-secret');

    await service.update({ oa_basic_id: '@osd2', login_channel_secret: '' }, admin);
    expect(row()?.loginChannelSecretEnc).toBe(sealed);
    await expect(service.channelFor('company-1')).resolves.toEqual({
      channelId: '2001234567',
      channelSecret: 'channel-secret',
      oaBasicId: '@osd2',
    });
  });

  it('audits whether the secret changed, never its value', async () => {
    const { service, audit } = setup();
    await service.update(
      { login_channel_id: '2001234567', login_channel_secret: 'channel-secret' },
      admin,
    );
    const entry = JSON.stringify(audit.record.mock.calls[0]);
    expect(entry).toContain('"secretChanged":true');
    expect(entry).not.toContain('channel-secret');
  });

  it('has no channel until both id and secret are set', async () => {
    const { service } = setup();
    await service.update({ login_channel_id: '2001234567' }, admin);
    await expect(service.channelFor('company-1')).resolves.toBeNull();
  });
});
