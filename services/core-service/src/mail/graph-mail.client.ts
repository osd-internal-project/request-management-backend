import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MailError,
  type InboundMail,
  type InboxRef,
  type MailClient,
  type OutgoingMail,
  type SentMail,
} from './mail-client';

export interface GraphMailSettings {
  readonly tenantId?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const GRAPH = 'https://graph.microsoft.com/v1.0';
/** Ids that survive a draft moving to Sent Items — a reply can still find it. */
const IMMUTABLE = 'IdType="ImmutableId"';
const TIMEOUT_MS = 20_000;

interface GraphMessage {
  id: string;
  internetMessageId?: string | null;
  conversationId?: string | null;
  receivedDateTime?: string;
  subject?: string | null;
  from?: { emailAddress?: { address?: string } } | null;
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  uniqueBody?: { content?: string } | null;
  body?: { content?: string } | null;
}

/**
 * MAIL_MODE=graph — one mailbox through Microsoft Graph with an app token
 * (client credentials, cached until a minute before it lapses):
 *
 * - send: a draft with the attachments, then `send`. A reply is
 *   `createReply` on the customer's message, so Outlook keeps the thread.
 * - inbox: ids and thread ids only (`listInbox`); content is read
 *   (`read`) for a message whose thread the system opened — the rest of the
 *   mailbox is never read, which matters while it is a person's own.
 *
 * Needs `Mail.Send` + `Mail.ReadWrite` (Application, admin consent), held to
 * this one mailbox by an Application Access Policy.
 */
@Injectable()
export class GraphMailClient implements MailClient {
  readonly mode = 'graph' as const;
  private token: { value: string; expiresAt: number } | null = null;
  private fetcher: Fetch = (url, init) => fetch(url, init);

  constructor(private readonly config: ConfigService) {}

  /** Tests swap the network. */
  useFetch(fetcher: Fetch): void {
    this.fetcher = fetcher;
  }

  static missingSettings(
    mailbox: string,
    settings: GraphMailSettings | undefined,
  ): string[] {
    const need: [keyof GraphMailSettings, string][] = [
      ['tenantId', 'MAIL_GRAPH_TENANT_ID'],
      ['clientId', 'MAIL_GRAPH_CLIENT_ID'],
      ['clientSecret', 'MAIL_GRAPH_CLIENT_SECRET'],
    ];
    return [
      ...(mailbox ? [] : ['MAIL_MAILBOX']),
      ...need.filter(([key]) => !settings?.[key]).map(([, name]) => name),
    ];
  }

  get mailbox(): string {
    return this.config.get<string>('mail.mailbox') ?? '';
  }

  private get settings(): GraphMailSettings {
    return this.config.get<GraphMailSettings>('mail.graph') ?? {};
  }

  private get base(): string {
    return `${GRAPH}/users/${encodeURIComponent(this.mailbox)}`;
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    const recipients = {
      toRecipients: mail.to.map(address),
      ccRecipients: (mail.cc ?? []).map(address),
    };
    let draft: GraphMessage;
    if (mail.replyToGraphId) {
      draft = await this.call<GraphMessage>(
        'POST',
        `/messages/${encodeURIComponent(mail.replyToGraphId)}/createReply`,
        {},
      );
      // our text replaces the quoted history Graph put in the draft
      draft = await this.call<GraphMessage>(
        'PATCH',
        `/messages/${encodeURIComponent(draft.id)}`,
        { ...recipients, body: { contentType: 'HTML', content: mail.html } },
      );
      for (const file of mail.attachments ?? []) {
        await this.call(
          'POST',
          `/messages/${encodeURIComponent(draft.id)}/attachments`,
          fileAttachment(file),
        );
      }
    } else {
      draft = await this.call<GraphMessage>('POST', '/messages', {
        subject: mail.subject,
        body: { contentType: 'HTML', content: mail.html },
        ...recipients,
        attachments: (mail.attachments ?? []).map(fileAttachment),
      });
    }
    await this.call('POST', `/messages/${encodeURIComponent(draft.id)}/send`);
    return {
      graphMessageId: draft.id,
      internetMessageId: draft.internetMessageId ?? null,
      conversationId: draft.conversationId ?? null,
    };
  }

  async listInbox(since: Date): Promise<InboxRef[]> {
    // OData wants %20, not the `+` URLSearchParams writes for a space
    const query = Object.entries({
      $filter: `receivedDateTime ge ${since.toISOString()}`,
      $orderby: 'receivedDateTime asc',
      $select: 'id,internetMessageId,conversationId,receivedDateTime',
      $top: '50',
    })
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');
    let next: string | null =
      `${this.base}/mailFolders/inbox/messages?${query}`;
    const found: InboxRef[] = [];
    // a few pages at most per sweep; the rest comes on the next one
    for (let page = 0; next && page < 10; page += 1) {
      const body: { value: GraphMessage[]; '@odata.nextLink'?: string } =
        await this.call('GET', next);
      for (const message of body.value) {
        found.push({
          graphMessageId: message.id,
          internetMessageId: message.internetMessageId ?? null,
          conversationId: message.conversationId ?? null,
          receivedAt: new Date(message.receivedDateTime ?? Date.now()),
        });
      }
      next = body['@odata.nextLink'] ?? null;
    }
    return found;
  }

  async read(graphMessageId: string): Promise<InboundMail> {
    const id = encodeURIComponent(graphMessageId);
    const message = await this.call<GraphMessage>(
      'GET',
      `/messages/${id}?$select=id,internetMessageId,conversationId,receivedDateTime,subject,from,toRecipients,ccRecipients,uniqueBody,body`,
      undefined,
      'outlook.body-content-type="text"',
    );
    const files = await this.call<{
      value: { name?: string; contentType?: string; size?: number }[];
    }>('GET', `/messages/${id}/attachments?$select=name,contentType,size`);
    return {
      graphMessageId: message.id,
      internetMessageId: message.internetMessageId ?? null,
      conversationId: message.conversationId ?? null,
      receivedAt: new Date(message.receivedDateTime ?? Date.now()),
      from: message.from?.emailAddress?.address ?? '',
      to: addresses(message.toRecipients),
      cc: addresses(message.ccRecipients),
      subject: message.subject ?? '',
      text: message.uniqueBody?.content ?? message.body?.content ?? '',
      attachments: files.value.map((file) => ({
        name: file.name ?? '',
        contentType: file.contentType ?? 'application/octet-stream',
        size: file.size ?? 0,
      })),
    };
  }

  private async call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    prefer?: string,
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    const response = await this.fetcher(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        prefer: [IMMUTABLE, prefer].filter(Boolean).join(', '),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MailError(
        `Graph ${method} ${path.split('?')[0]} → ${response.status} ${detail.slice(0, 300)}`,
        response.status,
      );
    }
    if (response.status === 202 || response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const { tenantId, clientId, clientSecret } = this.settings;
    const missing = GraphMailClient.missingSettings(
      this.mailbox,
      this.settings,
    );
    if (missing.length) {
      throw new MailError(
        `MAIL_MODE=graph ยังไม่ได้ตั้ง ${missing.join(', ')}`,
      );
    }
    const response = await this.fetcher(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId!)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId!,
          client_secret: clientSecret!,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new MailError(
        `ขอ token ของ Microsoft Graph ไม่ได้ (${response.status})`,
        response.status,
      );
    }
    const token = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      value: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
    };
    return token.access_token;
  }
}

const address = (value: string) => ({ emailAddress: { address: value } });

const addresses = (list: GraphMessage['toRecipients']) =>
  (list ?? [])
    .map((entry) => entry.emailAddress?.address ?? '')
    .filter(Boolean);

const fileAttachment = (file: {
  name: string;
  contentType: string;
  contentBase64: string;
}) => ({
  '@odata.type': '#microsoft.graph.fileAttachment',
  name: file.name,
  contentType: file.contentType,
  contentBytes: file.contentBase64,
});
