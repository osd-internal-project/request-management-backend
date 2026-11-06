/**
 * งานขายอัตโนมัติ (5 พ.ย. 2569) — the one way out to a mailbox. Like the
 * Teams client (CD-51) it sits behind an interface chosen by env:
 *
 *   MAIL_MODE=off (default) — no mailbox; sending answers 409.
 *   MAIL_MODE=mock          — nothing leaves the machine; a reply can be
 *                             simulated from the admin route.
 *   MAIL_MODE=graph         — Microsoft Graph, client credentials, one mailbox
 *                             (MAIL_MAILBOX: the shared mailbox, or a
 *                             developer's own while IT sets that up).
 */
export type MailMode = 'off' | 'mock' | 'graph';

export interface MailAttachment {
  readonly name: string;
  readonly contentType: string;
  /** base64 of the file. */
  readonly contentBase64: string;
}

export interface OutgoingMail {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly html: string;
  readonly attachments?: readonly MailAttachment[];
  /**
   * Graph id of a message in this mailbox to answer: the reply lands in the
   * customer's thread. Null = a new conversation.
   */
  readonly replyToGraphId?: string | null;
}

export interface SentMail {
  readonly graphMessageId: string;
  readonly internetMessageId: string | null;
  readonly conversationId: string | null;
}

/** What the inbox listing gives — enough to match a thread, no content. */
export interface InboxRef {
  readonly graphMessageId: string;
  readonly internetMessageId: string | null;
  readonly conversationId: string | null;
  readonly receivedAt: Date;
}

export interface InboundMail extends InboxRef {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** The new part of the message (quoted history left out), as plain text. */
  readonly text: string;
  readonly attachments: readonly {
    name: string;
    contentType: string;
    size: number;
  }[];
}

export interface MailClient {
  readonly mode: Exclude<MailMode, 'off'>;
  readonly mailbox: string;
  send(mail: OutgoingMail): Promise<SentMail>;
  /** Inbox messages received at or after `since`, oldest first. */
  listInbox(since: Date): Promise<InboxRef[]>;
  /** One message's content — called only for a message in a known thread. */
  read(graphMessageId: string): Promise<InboundMail>;
}

/** The mailbox refused for good (bad address, no rights) — no retry. */
export class MailError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'MailError';
  }
}
