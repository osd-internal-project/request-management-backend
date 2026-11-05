import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type {
  InboundMail,
  InboxRef,
  MailClient,
  OutgoingMail,
  SentMail,
} from './mail-client';

/**
 * MAIL_MODE=mock — nothing leaves this machine. A reply keeps the thread of
 * the message it answers, as Outlook does, so matching can be tested; a
 * customer's answer is simulated through `CrmEmailService.simulateReply`.
 */
@Injectable()
export class MockMailClient implements MailClient {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockMailClient.name);
  readonly sent: (OutgoingMail & SentMail)[] = [];

  constructor(readonly mailbox: string) {}

  send(mail: OutgoingMail): Promise<SentMail> {
    const thread = mail.replyToGraphId
      ? this.sent.find((m) => m.graphMessageId === mail.replyToGraphId)
      : undefined;
    const result: SentMail = {
      graphMessageId: `mock-${randomUUID()}`,
      internetMessageId: `<${randomUUID()}@mock.mail>`,
      conversationId: thread?.conversationId ?? `mock-conv-${randomUUID()}`,
    };
    this.sent.push({ ...mail, ...result });
    this.logger.log(
      `[mock] mail "${mail.subject}" → ${mail.to.join(', ')} (${mail.attachments?.length ?? 0} attachment(s))`,
    );
    return Promise.resolve(result);
  }

  listInbox(): Promise<InboxRef[]> {
    return Promise.resolve([]);
  }

  read(graphMessageId: string): Promise<InboundMail> {
    return Promise.reject(
      new Error(`mock mailbox has no message ${graphMessageId}`),
    );
  }
}
