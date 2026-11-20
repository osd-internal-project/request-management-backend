import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  PrismaTransactionService,
  auditActor,
  type Principal,
} from '@request-management/share';
import { LineLoginClient, LineLoginError } from './line-login.client';
import { authorizeUrl, readState, signState } from './line-rules';
import { LineSettingsService } from './line-settings.service';
import { UserLineAccountRepository } from './user-line-account.repository';

export type LinkFailure =
  | 'STATE_INVALID'
  | 'STATE_EXPIRED'
  | 'LINE_DENIED'
  | 'LINE_NOT_CONFIGURED'
  | 'LINE_ERROR'
  | 'LINE_ALREADY_LINKED';

export type LinkResult = { ok: true } | { ok: false; reason: LinkFailure };

export interface CallbackQuery {
  code?: string;
  state?: string;
  error?: string;
  friendship_status_changed?: string;
}

/**
 * Each user links their own LINE to the active company's OA through LINE
 * Login. Per company, because every company's OA is its own Provider and the
 * same person gets a different LINE userId in each.
 */
@Injectable()
export class LineLinkService {
  private readonly logger = new Logger(LineLinkService.name);

  constructor(
    private readonly accounts: UserLineAccountRepository,
    private readonly settings: LineSettingsService,
    private readonly line: LineLoginClient,
    private readonly tx: PrismaTransactionService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
  ) {}

  async status(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [channel, account] = await Promise.all([
      this.settings.channelFor(companyId),
      this.accounts.findFirst({ where: { userId: actor.userId, companyId } }),
    ]);
    return {
      configured: !!channel,
      oa_basic_id: channel?.oaBasicId ?? '',
      linked: account
        ? {
            display_name: account.displayName,
            picture_url: account.pictureUrl,
            is_friend: account.isFriend,
            linked_at: account.linkedAt.toISOString(),
          }
        : null,
    };
  }

  async start(actor: Principal): Promise<{ url: string }> {
    const channel = await this.settings.channelFor(actor.activeCompanyId);
    if (!channel) {
      throw new AppError(
        'LINE_NOT_CONFIGURED',
        'บริษัทนี้ยังไม่ได้ตั้งค่า LINE Login — แจ้งผู้ดูแลระบบ',
      );
    }
    return {
      url: authorizeUrl({
        channelId: channel.channelId,
        redirectUri: this.settings.callbackUrl(),
        state: signState(
          { userId: actor.userId, companyId: actor.activeCompanyId },
          this.stateSecret(),
        ),
      }),
    };
  }

  /** LINE's redirect back. Public: the signed state names the user, LINE's verify names their LINE. */
  async complete(query: CallbackQuery): Promise<LinkResult> {
    const state = readState(query.state ?? '', this.stateSecret());
    if (!state.ok) return state;
    if (query.error || !query.code) return { ok: false, reason: 'LINE_DENIED' };

    const channel = await this.settings.channelFor(state.companyId);
    if (!channel) return { ok: false, reason: 'LINE_NOT_CONFIGURED' };

    let profile;
    try {
      profile = await this.line.profileFor({
        code: query.code,
        redirectUri: this.settings.callbackUrl(),
        channelId: channel.channelId,
        channelSecret: channel.channelSecret,
      });
    } catch (failure) {
      if (!(failure instanceof LineLoginError)) throw failure;
      this.logger.warn(failure.message);
      return { ok: false, reason: 'LINE_ERROR' };
    }

    const key = { userId: state.userId, companyId: state.companyId };
    const friend = query.friendship_status_changed === 'true';
    try {
      await this.tx.execute(async (prisma) => {
        const row = {
          lineUserId: profile.lineUserId,
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          linkedAt: new Date(),
          // LINE only says when the friendship changed on this login; otherwise keep what we knew
          ...(friend ? { isFriend: true } : {}),
        };
        await this.accounts.upsert(
          {
            where: { userId_companyId: key },
            create: { ...key, ...row },
            update: row,
          },
          { prisma },
        );
        await this.audit.record(
          {
            eventType: 'line.linked',
            companyId: state.companyId,
            actorId: state.userId,
            resourceType: 'user_line_account',
            resourceId: state.userId,
            after: { lineUserId: profile.lineUserId, isFriend: friend },
          },
          { prisma },
        );
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return { ok: false, reason: 'LINE_ALREADY_LINKED' };
      }
      throw error;
    }
    return { ok: true };
  }

  async unlink(actor: Principal): Promise<void> {
    const key = { userId: actor.userId, companyId: actor.activeCompanyId };
    await this.tx.execute(async (prisma) => {
      const row = await this.accounts.findFirst({ where: key }, { prisma });
      if (!row) return;
      await this.accounts.delete({ where: { id: row.id } }, { prisma });
      await this.audit.record(
        {
          eventType: 'line.unlinked',
          companyId: key.companyId,
          ...auditActor(actor),
          resourceType: 'user_line_account',
          resourceId: actor.userId,
          before: { lineUserId: row.lineUserId },
        },
        { prisma },
      );
    });
  }

  /**
   * Who a workflow pushes a LINE card to: the company's member by exact email
   * and their LINE in that company. 404 hides people of other companies.
   */
  async recipientFor(companyId: string, email: string) {
    const member = await this.accounts.member(companyId, email);
    if (!member) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้ใช้อีเมลนี้ในบริษัท', [
        { field: 'email', reason: 'not_found' },
      ]);
    }
    const account = member.lineAccounts[0];
    if (!account) {
      throw new AppError('LINE_NOT_LINKED', 'ผู้ใช้นี้ยังไม่ได้ผูก LINE กับบริษัทนี้', [
        { field: 'email', reason: 'line_not_linked' },
      ]);
    }
    return {
      user_id: member.id,
      email: member.email,
      display_name: member.displayName,
      line_user_id: account.lineUserId,
      line_display_name: account.displayName,
      is_friend: account.isFriend,
    };
  }

  private stateSecret(): string {
    const secret = this.config.get<string>('line.stateSecret');
    if (!secret) throw new Error('LINE_STATE_SECRET is not set');
    return secret;
  }
}
