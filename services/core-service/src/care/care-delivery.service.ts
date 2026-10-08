import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import { MAX_TEXT } from './care-rules';
import {
  CareContactLookupRepository,
  CareConversationRepository,
  CareMessageRepository,
} from './care.repositories';

/** Tries for a message LINE refused before it stays failed. */
const MAX_ATTEMPTS = 5;

interface OutRow {
  id: string;
}

/**
 * CD-284 (CD-23 AI CARE) — what a person (or a notice the team triggered)
 * says to a customer reaches them on the channel the conversation is on.
 * LINE is pushed at once with the company's channel token (CD-66); every
 * other channel's connector reads the outbox (`care/outbox`) and reports
 * each message sent or failed. AI CARE's own answers need none of this —
 * they go back in the reply to the connector's own call.
 */
@Injectable()
export class CareDeliveryService {
  private readonly logger = new Logger(CareDeliveryService.name);

  constructor(
    private readonly conversations: CareConversationRepository,
    private readonly messages: CareMessageRepository,
    private readonly lookup: CareContactLookupRepository,
    private readonly config: ConfigService,
  ) {}

  /** A message to send out: stored as pending, then tried at once (LINE). */
  async send(input: {
    conversationId: string;
    text: string;
    author: 'agent' | 'system';
    authorUserId?: string | null;
  }) {
    const text = input.text.trim().slice(0, MAX_TEXT);
    if (!text) throw new AppError('VALIDATION_FAILED', 'ข้อความว่าง');
    const message = (await this.messages.create({
      data: {
        conversationId: input.conversationId,
        direction: 'out',
        author: input.author,
        authorUserId: input.authorUserId ?? null,
        text,
        delivery: 'pending',
      },
    })) as OutRow;
    await this.conversations.update({
      where: { id: input.conversationId },
      data: { messages: { increment: 1 }, lastMessageAt: new Date() },
    });
    await this.tryLine(message.id);
    return message.id;
  }

  /** Pending messages for a channel's connector, oldest first. */
  outbox(companyId: string, channel: string, limit = 50) {
    return this.messages.outbox(companyId, channel, limit);
  }

  /** The connector says whether a message reached the customer. */
  async acknowledge(
    companyId: string,
    messageId: string,
    result: { ok: boolean; error?: string },
  ) {
    const row = await this.messages.withConversation(messageId);
    if (!row || row.companyId !== companyId || !row.delivery)
      throw new AppError('NOT_FOUND', 'ไม่พบข้อความที่ต้องส่ง');
    await this.messages.update({
      where: { id: messageId },
      data: result.ok
        ? { delivery: 'sent', deliveredAt: new Date(), deliveryError: null }
        : {
            delivery: 'failed',
            deliveryAttempts: { increment: 1 },
            deliveryError: (result.error ?? 'ส่งไม่สำเร็จ').slice(0, 500),
          },
    });
  }

  /** LINE messages not yet through: tried again (the care sweep). */
  async retry() {
    let sent = 0;
    for (const id of await this.messages.lineToRetry(MAX_ATTEMPTS))
      if (await this.tryLine(id)) sent += 1;
    return sent;
  }

  /** Push to LINE when the conversation is on LINE and the company has a token. */
  private async tryLine(messageId: string): Promise<boolean> {
    const row = await this.messages.withConversation(messageId);
    if (!row || row.channel !== 'line' || !row.text) return false;
    const code = await this.lookup.companyCode(row.companyId);
    const token = code
      ? this.config.get<string>(`LINE_CHANNEL_ACCESS_TOKEN_${code}`)
      : undefined;
    // no token: the message waits in the outbox for a connector
    if (!token) return false;
    let error: string | null = null;
    try {
      const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: row.senderRef,
          messages: [{ type: 'text', text: row.text.slice(0, 5000) }],
        }),
      });
      if (!response.ok) error = `LINE ${response.status}`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    await this.messages.update({
      where: { id: messageId },
      data: error
        ? {
            delivery: 'failed',
            deliveryAttempts: { increment: 1 },
            deliveryError: error.slice(0, 500),
          }
        : {
            delivery: 'sent',
            deliveredAt: new Date(),
            deliveryAttempts: { increment: 1 },
            deliveryError: null,
          },
    });
    if (error) this.logger.warn(`care LINE push ${messageId}: ${error}`);
    return !error;
  }
}
