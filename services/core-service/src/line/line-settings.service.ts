import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditWriter,
  PrismaTransactionService,
  auditActor,
  type Principal,
  type SecretKeyring,
} from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import type { UpdateLineSettingsDto } from './dto/line-settings.dto';
import { callbackUrl } from './line-rules';
import { LineSettingRepository } from './line-setting.repository';

/** What linking needs from a company's setting, the secret already opened. */
export interface LineChannel {
  channelId: string;
  channelSecret: string;
  oaBasicId: string;
}

/**
 * ตั้งค่า LINE Login ต่อบริษัท — the channel each user signs in with to link
 * their LINE. Sealed with CONFIG_SECRET_KEY like `mail_settings`; the secret
 * is never returned and a blank one keeps the saved value.
 */
@Injectable()
export class LineSettingsService {
  constructor(
    private readonly settings: LineSettingRepository,
    private readonly tx: PrismaTransactionService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
  ) {}

  async get(actor: Principal) {
    const row = await this.settings.findFirst({
      where: { companyId: actor.activeCompanyId },
    });
    return {
      login_channel_id: row?.loginChannelId ?? '',
      login_channel_secret_set: !!row?.loginChannelSecretEnc,
      oa_basic_id: row?.oaBasicId ?? '',
      callback_url: this.callbackUrl(),
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  async update(dto: UpdateLineSettingsDto, actor: Principal) {
    const companyId = actor.activeCompanyId;
    const secret = dto.login_channel_secret?.trim();
    await this.tx.execute(async (prisma) => {
      const current = await this.settings.findFirst(
        { where: { companyId } },
        { prisma },
      );
      const next = {
        loginChannelId: (
          dto.login_channel_id ??
          current?.loginChannelId ??
          ''
        ).trim(),
        loginChannelSecretEnc: secret
          ? this.seal(secret)
          : (current?.loginChannelSecretEnc ?? null),
        oaBasicId: (dto.oa_basic_id ?? current?.oaBasicId ?? '').trim(),
        updatedBy: actor.userId,
      };
      await this.settings.upsert(
        { where: { companyId }, create: { companyId, ...next }, update: next },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'admin.line_settings.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'line_settings',
          resourceId: companyId,
          // never the secret — only whether it changed
          ...(current
            ? {
                before: {
                  loginChannelId: current.loginChannelId,
                  oaBasicId: current.oaBasicId,
                },
              }
            : {}),
          after: {
            loginChannelId: next.loginChannelId,
            oaBasicId: next.oaBasicId,
            secretChanged: !!secret,
          },
        },
        { prisma },
      );
    });
    return this.get(actor);
  }

  /** The company's channel ready to use, or null when it is not fully set (or its secret cannot be opened). */
  async channelFor(companyId: string): Promise<LineChannel | null> {
    const row = await this.settings.findFirst({ where: { companyId } });
    if (!row?.loginChannelId || !row.loginChannelSecretEnc) return null;
    const channelSecret = openSecret(
      row.loginChannelSecretEnc,
      this.config.get<SecretKeyring>('projectConfig.secret'),
    );
    if (!channelSecret) return null;
    return {
      channelId: row.loginChannelId,
      channelSecret,
      oaBasicId: row.oaBasicId,
    };
  }

  /** The URL to register as the channel's callback in LINE Developers. */
  callbackUrl(): string {
    return callbackUrl(this.config.get<string>('line.publicUrl') ?? '');
  }

  private seal(value: string): string {
    const ring = this.config.get<SecretKeyring>('projectConfig.secret');
    if (!ring) throw new Error('CONFIG_SECRET_KEY is not set');
    return sealSecret(value, ring);
  }
}
