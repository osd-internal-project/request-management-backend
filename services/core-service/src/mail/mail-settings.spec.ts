import { keyringFromEnv } from '@request-management/share';
import { ConfigService } from '@nestjs/config';
import type { Principal } from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import { GraphMailClient } from './graph-mail.client';
import {
  MailClientsService,
  type MailSettingRow,
} from './mail-clients.service';
import { MailSettingsService } from './mail-settings.service';
import { MockMailClient } from './mock-mail.client';

const KEY = keyringFromEnv({ CONFIG_SECRET_KEY: 'test-config-secret' });
const GUID_T = '11111111-2222-3333-4444-555555555555';
const GUID_C = '66666666-7777-8888-9999-000000000000';

function config(mail: Record<string, unknown> = {}) {
  return new ConfigService({
    projectConfig: { secret: KEY },
    mail: { mode: 'off', mailbox: '', graph: {}, ...mail },
  });
}

function repo(rows: object[] = []) {
  const store = new Map<string, Record<string, unknown>>(
    rows.map((row) => [(row as { companyId: string }).companyId, { ...row }]),
  );
  return {
    store,
    findFirst: jest.fn(({ where }: { where: { companyId: string } }) =>
      Promise.resolve(store.get(where.companyId) ?? null),
    ),
    findMany: jest.fn(({ where }: { where: { mode: string } }) =>
      Promise.resolve(
        [...store.values()].filter((row) => row.mode === where.mode),
      ),
    ),
    upsert: jest.fn(
      ({
        where,
        create,
        update,
      }: {
        where: { companyId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const row = store.get(where.companyId);
        const next = row
          ? { ...row, ...update }
          : { ...create, updatedAt: new Date() };
        store.set(where.companyId, next);
        return Promise.resolve(next);
      },
    ),
    update: jest.fn(
      ({
        where,
        data,
      }: {
        where: { companyId: string };
        data: Record<string, unknown>;
      }) => {
        store.set(where.companyId, { ...store.get(where.companyId), ...data });
        return Promise.resolve(store.get(where.companyId));
      },
    ),
  };
}

const graphRow = (extra: Partial<MailSettingRow> = {}): MailSettingRow => ({
  companyId: 'co-1',
  mode: 'graph',
  mailbox: 'sales@osd.co.th',
  senderName: '',
  tenantId: GUID_T,
  clientId: GUID_C,
  clientSecretEnc: sealSecret('s3cret', KEY),
  ...extra,
});

const admin = {
  userId: 'u-admin',
  email: 'admin@osd.co.th',
  activeCompanyId: 'co-1',
  permissions: ['admin.integration.manage'],
} as unknown as Principal;

describe('mail settings per company (5 พ.ย. 2569)', () => {
  describe('MailClientsService', () => {
    it('a company without a row uses env; with one, its own mailbox', async () => {
      const settings = repo([graphRow()]);
      const clients = new MailClientsService(
        config({ mode: 'mock', mailbox: 'dev@osd.co.th' }),
        settings as never,
      );
      const other = await clients.forCompany('co-2');
      expect(other).toMatchObject({ source: 'env', mode: 'mock' });
      expect(other.client?.mailbox).toBe('dev@osd.co.th');

      const own = await clients.forCompany('co-1');
      expect(own).toMatchObject({
        source: 'company',
        mode: 'graph',
        problem: null,
      });
      expect(own.client).toBeInstanceOf(GraphMailClient);
      expect(own.client?.mailbox).toBe('sales@osd.co.th');
    });

    it('keeps one client per company until its settings change', async () => {
      const settings = repo([graphRow()]);
      const clients = new MailClientsService(config(), settings as never);
      const first = (await clients.forCompany('co-1')).client;
      expect((await clients.forCompany('co-1')).client).toBe(first);
      settings.store.set('co-1', {
        ...graphRow({ mailbox: 'shared@osd.co.th' }),
      });
      const after = (await clients.forCompany('co-1')).client;
      expect(after).not.toBe(first);
      expect(after?.mailbox).toBe('shared@osd.co.th');
    });

    it('a secret sealed under another key is reported, not used', async () => {
      const clients = new MailClientsService(
        config(),
        repo([
          graphRow({ clientSecretEnc: sealSecret('x', keyringFromEnv({ CONFIG_SECRET_KEY: 'other-key' })) }),
        ]) as never,
      );
      const resolved = await clients.forCompany('co-1');
      expect(resolved.client).toBeNull();
      expect(resolved.problem).toContain('CONFIG_SECRET_KEY');
    });

    it('polls each graph mailbox once, env included', async () => {
      const clients = new MailClientsService(
        config({
          mode: 'graph',
          mailbox: 'SALES@osd.co.th',
          graph: { tenantId: 't', clientId: 'c', clientSecret: 's' },
        }),
        repo([
          graphRow(),
          graphRow({ companyId: 'co-3', mailbox: 'lex@lextech.co.th' }),
          graphRow({ companyId: 'co-4', mode: 'mock' }),
        ]) as never,
      );
      const targets = await clients.pollTargets();
      expect(targets.map((target) => target.key).sort()).toEqual([
        'lex@lextech.co.th',
        'sales@osd.co.th',
      ]);
    });

    it('env graph with missing values still refuses to boot', () => {
      const clients = new MailClientsService(
        config({ mode: 'graph', mailbox: 'sales@osd.co.th' }),
        repo() as never,
      );
      expect(() => clients.onModuleInit()).toThrow(/MAIL_GRAPH_TENANT_ID/);
    });
  });

  describe('MailSettingsService', () => {
    function service(rows: object[] = []) {
      const settings = repo(rows);
      const cfg = config();
      const clients = new MailClientsService(cfg, settings as never);
      const audit = { record: jest.fn() };
      return {
        settings,
        audit,
        clients,
        service: new MailSettingsService(
          settings as never,
          clients,
          cfg,
          audit as never,
        ),
      };
    }

    it('seals the secret, never returns it, and audits without it', async () => {
      const h = service();
      const view = await h.service.update(
        {
          mode: 'graph',
          mailbox: 'sales@osd.co.th',
          tenant_id: GUID_T,
          client_id: GUID_C,
          client_secret: 's3cret',
        },
        admin,
      );
      const stored = h.settings.store.get('co-1') as {
        clientSecretEnc: string;
      };
      expect(stored.clientSecretEnc).not.toContain('s3cret');
      expect(openSecret(stored.clientSecretEnc, KEY)).toBe('s3cret');
      expect(view).toMatchObject({
        source: 'company',
        mode: 'graph',
        client_secret_set: true,
        problem: null,
      });
      expect(JSON.stringify(view)).not.toContain('s3cret');
      expect(JSON.stringify(h.audit.record.mock.calls)).not.toContain('s3cret');
    });

    it('a blank secret keeps the saved one; switching the mailbox takes effect at once', async () => {
      const h = service([{ ...graphRow(), updatedAt: new Date() }]);
      const before = (await h.clients.forCompany('co-1')).client;
      await h.service.update(
        { mode: 'graph', mailbox: 'shared@osd.co.th', client_secret: '' },
        admin,
      );
      const stored = h.settings.store.get('co-1') as {
        clientSecretEnc: string;
      };
      expect(openSecret(stored.clientSecretEnc, KEY)).toBe('s3cret');
      const after = (await h.clients.forCompany('co-1')).client;
      expect(after).not.toBe(before);
      expect(after?.mailbox).toBe('shared@osd.co.th');
    });

    it('graph without every value is refused, naming what is missing', async () => {
      const h = service();
      await expect(
        h.service.update({ mode: 'graph', mailbox: 'sales@osd.co.th' }, admin),
      ).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        details: [
          { field: 'tenant_id', reason: 'required_for_graph' },
          { field: 'client_id', reason: 'required_for_graph' },
          { field: 'client_secret', reason: 'required_for_graph' },
        ],
      });
      expect(h.settings.upsert).not.toHaveBeenCalled();
    });

    it('test sends to the person testing, with values not saved yet', async () => {
      const h = service([
        { ...graphRow({ mode: 'off' }), updatedAt: new Date() },
      ]);
      const sent: string[] = [];
      jest
        .spyOn(MockMailClient.prototype, 'send')
        .mockImplementationOnce(function (this: MockMailClient, mail) {
          sent.push(`${this.mailbox} → ${mail.to.join(',')}`);
          return Promise.resolve({
            graphMessageId: 'm',
            internetMessageId: null,
            conversationId: null,
          });
        });
      const result = await h.service.test(
        { mode: 'mock', mailbox: 'dev@osd.co.th' },
        admin,
      );
      expect(result).toMatchObject({
        ok: true,
        mode: 'mock',
        to: 'admin@osd.co.th',
      });
      expect(sent).toEqual(['dev@osd.co.th → admin@osd.co.th']);
      // testing saved nothing but the outcome
      expect(h.settings.store.get('co-1')).toMatchObject({
        mode: 'off',
        lastTestOk: true,
      });
    });

    it('test in off mode says so', async () => {
      const h = service();
      await expect(
        h.service.test({ mode: 'off' }, admin),
      ).rejects.toMatchObject({
        code: 'CRM_EMAIL_UNAVAILABLE',
      });
    });
  });
});
