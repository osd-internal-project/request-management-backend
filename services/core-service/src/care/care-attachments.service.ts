import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  OBJECT_STORAGE,
  hasPermission,
  type ObjectStorage,
  type Principal,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { safeFileName } from '../requests/attachments.service';
import type { Attachment } from './care.service';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareMessageRepository,
} from './care.repositories';

const MANAGE = 'service.care.manage';
const DEFAULT_INTERVAL_MS = 60_000;
/** LINE allows files up to this; anything bigger is not copied. */
const MAX_BYTES = 25 * 1024 * 1024;
/** Tries before a file LINE will not give is left as an error. */
const MAX_TRIES = 5;

/**
 * CD-285 (CD-23 AI CARE) — files customers send through a channel that only
 * lends them (LINE keeps message content for a while): copied into our
 * storage by core-service, which holds it (external-service, where the LINE
 * webhook lands, has none), and served to the service team from there.
 * Removed with the conversation's texts once past the retention period.
 */
@Injectable()
export class CareAttachmentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CareAttachmentsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly messages: CareMessageRepository,
    private readonly conversations: CareConversationRepository,
    private readonly lookup: CareContactLookupRepository,
    private readonly config: ConfigService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('care.attachmentIntervalMs') ??
      DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'care attachments', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep() {
    const copied = await this.copyPending();
    const cleared = await this.clearExpired();
    return { copied, cleared };
  }

  /** Copy what LINE lent into our storage. */
  async copyPending() {
    const rows = (await this.messages.findMany({
      where: { attachmentsPending: true },
      orderBy: [{ createdAt: 'asc' }],
      take: 50,
      select: { id: true, conversationId: true, attachments: true },
    })) as { id: string; conversationId: string; attachments: unknown }[];
    let copied = 0;
    for (const row of rows) {
      const conversation = (await this.conversations.findFirst({
        where: { id: row.conversationId },
        select: { companyId: true },
      })) as { companyId: string } | null;
      const list = (
        Array.isArray(row.attachments) ? row.attachments : []
      ) as Attachment[];
      const code = conversation
        ? await this.lookup.companyCode(conversation.companyId)
        : null;
      const token = code
        ? this.config.get<string>(`LINE_CHANNEL_ACCESS_TOKEN_${code}`)
        : undefined;
      const next: Attachment[] = [];
      for (const a of list) {
        if (a.source !== 'line' || !a.lineMessageId || a.key || a.error) {
          next.push(a);
          continue;
        }
        if (!token || !conversation) {
          next.push({ ...a, error: 'ไม่มี token ของ LINE สำหรับบริษัทนี้' });
          continue;
        }
        try {
          const response = await fetch(
            `https://api-data.line.me/v2/bot/message/${encodeURIComponent(a.lineMessageId)}/content`,
            { headers: { authorization: `Bearer ${token}` } },
          );
          if (!response.ok) throw new Error(`LINE ${response.status}`);
          const body = Buffer.from(await response.arrayBuffer());
          if (body.length > MAX_BYTES) throw new Error('ไฟล์ใหญ่เกิน 25 MB');
          const contentType =
            response.headers.get('content-type') ?? 'application/octet-stream';
          const key = `care/${conversation.companyId}/${row.conversationId}/${row.id}/${randomUUID()}-${safeFileName(a.name)}`;
          await this.storage.put(key, body, {
            contentType,
            size: body.length,
          });
          next.push({ ...a, key, contentType, size: body.length });
          copied += 1;
        } catch (error) {
          const tries = (a.tries ?? 0) + 1;
          next.push({
            ...a,
            tries,
            ...(tries >= MAX_TRIES
              ? {
                  error: `ดึงไฟล์จาก LINE ไม่สำเร็จ: ${String(error)}`.slice(
                    0,
                    300,
                  ),
                }
              : {}),
          });
        }
      }
      const pending = next.some(
        (a) => a.source === 'line' && !a.key && !a.error,
      );
      await this.messages.update({
        where: { id: row.id },
        data: { attachments: next as object[], attachmentsPending: pending },
      });
    }
    return copied;
  }

  /** Files of conversations whose texts were cleared go too (retention). */
  async clearExpired() {
    let cleared = 0;
    for (const row of await this.messages.filesToClear()) {
      const list = (
        Array.isArray(row.attachments) ? row.attachments : []
      ) as Attachment[];
      const next: Attachment[] = [];
      for (const a of list) {
        if (a.key) {
          await this.storage.remove(a.key).catch(() => undefined);
          cleared += 1;
        }
        const { key: _key, ...rest } = a;
        void _key;
        next.push(rest);
      }
      await this.messages.update({
        where: { id: row.id },
        data: { attachments: next as object[] },
      });
    }
    return cleared;
  }

  /** A stored file of a message, for the service team. */
  async open(
    actor: Principal,
    conversationId: string,
    messageId: string,
    index: number,
  ) {
    if (!hasPermission(actor, MANAGE))
      throw new AppError('FORBIDDEN', 'ดูบทสนทนาได้เฉพาะทีมบริการ');
    const conversation = (await this.conversations.findFirst({
      where: { id: conversationId, companyId: actor.activeCompanyId },
      select: { id: true },
    })) as { id: string } | null;
    const message = conversation
      ? ((await this.messages.findFirst({
          where: { id: messageId, conversationId },
          select: { attachments: true },
        })) as { attachments: unknown } | null)
      : null;
    const list = (
      Array.isArray(message?.attachments) ? message?.attachments : []
    ) as Attachment[];
    const file = list[index];
    if (!file?.key) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์');
    return {
      stream: await this.storage.get(file.key),
      fileName: file.name,
      contentType: file.contentType ?? 'application/octet-stream',
    };
  }
}
