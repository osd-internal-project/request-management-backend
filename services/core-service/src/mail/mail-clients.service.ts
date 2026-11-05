import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../pm/config-rules';
import { GraphMailClient, type GraphMailSettings } from './graph-mail.client';
import type { MailClient, MailMode } from './mail-client';
import { MailSettingRepository } from './mail-setting.repository';
import { MockMailClient } from './mock-mail.client';

/** Where a company's mailbox came from: its row on the settings screen, or env. */
export type MailSource = 'company' | 'env';

export interface ResolvedMail {
  readonly client: MailClient | null;
  readonly mode: MailMode;
  readonly source: MailSource;
  /** Why a configured mailbox cannot be used (missing value, unreadable secret). */
  readonly problem: string | null;
}

export interface MailSettingRow {
  companyId: string;
  mode: string;
  mailbox: string;
  senderName: string;
  tenantId: string;
  clientId: string;
  clientSecretEnc: string | null;
}

/** One mailbox the poller reads. */
export interface PollTarget {
  readonly key: string;
  readonly client: MailClient;
}

const MOCK_MAILBOX = 'sales@mock.local';

/** The settings screen's names for what env calls MAIL_*. */
const SCREEN_FIELDS: Record<string, string> = {
  MAIL_MAILBOX: 'mailbox',
  MAIL_GRAPH_TENANT_ID: 'tenant id',
  MAIL_GRAPH_CLIENT_ID: 'client id',
  MAIL_GRAPH_CLIENT_SECRET: 'client secret',
};

/**
 * Which mailbox each company sends from (5 พ.ย. 2569). A company's row on the
 * settings screen (`mail_settings`) wins; a company with none uses `MAIL_*`
 * from env, as before. Clients are kept per company and rebuilt only when the
 * settings change, so a Graph token is reused between sends.
 */
@Injectable()
export class MailClientsService implements OnModuleInit {
  private readonly logger = new Logger(MailClientsService.name);
  private readonly cache = new Map<
    string,
    { fingerprint: string; resolved: ResolvedMail }
  >();
  private envResolved: ResolvedMail | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly settings: MailSettingRepository,
  ) {}

  /** env graph with missing values refuses to boot, as it always has. */
  onModuleInit(): void {
    const env = this.fromEnv();
    if (env.mode === 'graph' && env.problem) {
      throw new Error(env.problem);
    }
  }

  async forCompany(companyId: string): Promise<ResolvedMail> {
    const row = (await this.settings.findFirst({
      where: { companyId },
    })) as MailSettingRow | null;
    return row ? this.fromRow(row) : this.fromEnv();
  }

  /** Every mailbox in graph mode — each company's, and env's if it is one. */
  async pollTargets(): Promise<PollTarget[]> {
    const rows = (await this.settings.findMany({
      where: { mode: 'graph' },
    })) as MailSettingRow[];
    const targets: PollTarget[] = [];
    const seen = new Set<string>();
    const add = (resolved: ResolvedMail) => {
      if (resolved.client?.mode !== 'graph') return;
      const key = resolved.client.mailbox.toLowerCase();
      // two companies on one mailbox: read it once
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ key, client: resolved.client });
    };
    rows.forEach((row) => add(this.fromRow(row)));
    add(this.fromEnv());
    return targets;
  }

  /** After the screen saves: the next send builds the client afresh. */
  forget(companyId: string): void {
    this.cache.delete(companyId);
  }

  /** A client for settings not saved yet — the screen's "test" button. */
  clientFor(row: MailSettingRow): ResolvedMail {
    return this.build(row);
  }

  private fromRow(row: MailSettingRow): ResolvedMail {
    const fingerprint = [
      row.mode,
      row.mailbox,
      row.tenantId,
      row.clientId,
      row.clientSecretEnc ?? '',
    ].join('|');
    const cached = this.cache.get(row.companyId);
    if (cached?.fingerprint === fingerprint) return cached.resolved;
    const resolved = this.build(row);
    this.cache.set(row.companyId, { fingerprint, resolved });
    return resolved;
  }

  private build(row: MailSettingRow): ResolvedMail {
    const source: MailSource = 'company';
    if (row.mode === 'mock') {
      return {
        client: new MockMailClient(row.mailbox || MOCK_MAILBOX),
        mode: 'mock',
        source,
        problem: null,
      };
    }
    if (row.mode !== 'graph') {
      return { client: null, mode: 'off', source, problem: null };
    }
    const secretKey = this.config.get<string>('projectConfig.secret');
    const secret =
      row.clientSecretEnc && secretKey
        ? openSecret(row.clientSecretEnc, secretKey)
        : null;
    if (row.clientSecretEnc && secret === null) {
      return {
        client: null,
        mode: 'graph',
        source,
        problem:
          'ถอดรหัส client secret ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ใส่ secret ใหม่ที่หน้าตั้งค่าอีเมล',
      };
    }
    return this.graph(
      row.mailbox,
      {
        tenantId: row.tenantId,
        clientId: row.clientId,
        clientSecret: secret ?? '',
      },
      source,
    );
  }

  private fromEnv(): ResolvedMail {
    if (this.envResolved) return this.envResolved;
    const mode = this.config.get<string>('mail.mode') ?? 'off';
    const mailbox = this.config.get<string>('mail.mailbox') ?? '';
    let resolved: ResolvedMail;
    if (mode === 'mock') {
      resolved = {
        client: new MockMailClient(mailbox || MOCK_MAILBOX),
        mode: 'mock',
        source: 'env',
        problem: null,
      };
    } else if (mode === 'graph') {
      resolved = this.graph(
        mailbox,
        this.config.get<GraphMailSettings>('mail.graph') ?? {},
        'env',
      );
      if (resolved.client) {
        this.logger.log(`env mailbox ${mailbox} via Microsoft Graph`);
      }
    } else if (mode === 'off') {
      resolved = { client: null, mode: 'off', source: 'env', problem: null };
    } else {
      throw new Error(`MAIL_MODE must be off, mock or graph (got ${mode})`);
    }
    this.envResolved = resolved;
    return resolved;
  }

  private graph(
    mailbox: string,
    settings: GraphMailSettings,
    source: MailSource,
  ): ResolvedMail {
    const missing = GraphMailClient.missingSettings(mailbox, settings);
    if (missing.length) {
      return {
        client: null,
        mode: 'graph',
        source,
        problem: `ตั้งค่า Microsoft Graph ไม่ครบ: ${(source === 'env'
          ? missing
          : missing.map((name) => SCREEN_FIELDS[name] ?? name)
        ).join(', ')}`,
      };
    }
    return {
      client: new GraphMailClient({ mailbox, ...settings }),
      mode: 'graph',
      source,
      problem: null,
    };
  }
}
