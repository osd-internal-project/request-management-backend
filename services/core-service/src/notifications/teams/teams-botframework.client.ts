import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@request-management/share';
import {
  TeamsPermanentError,
  type TeamsClient,
  type TeamsMessage,
  type TeamsRecipient,
} from './teams-client';

export interface TeamsBotSettings {
  readonly tenantId?: string;
  readonly appId?: string;
  readonly appPassword?: string;
  /** Bot Connector base, regional, e.g. https://smba.trafficmanager.net/apac/ */
  readonly serviceUrl?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * TEAMS_MODE=botframework — a single-tenant Azure bot sends each person a
 * 1:1 message:
 *
 * 1. an app token (client credentials) for Microsoft Graph and one for the
 *    Bot Connector, cached until a minute before they lapse;
 * 2. the person's Microsoft 365 object id, looked up by email in Graph
 *    (`User.Read.All`, application) — once, then kept in `teams_chat_links`;
 * 3. a 1:1 conversation opened with them through the Bot Connector — needs
 *    the bot's Teams app installed for the person (IT deploys it org-wide);
 * 4. the message, as an Adaptive Card with a link back into the system.
 *
 * A person missing from Microsoft 365, or without the app, is a
 * `TeamsPermanentError`; anything else (throttling, a timeout) is retried by
 * the worker.
 */
@Injectable()
export class BotFrameworkTeamsClient implements TeamsClient {
  readonly mode = 'botframework' as const;
  private readonly tokens = new Map<string, CachedToken>();
  private fetcher: Fetch = (url, init) => fetch(url, init);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Tests swap the network. */
  useFetch(fetcher: Fetch): void {
    this.fetcher = fetcher;
  }

  static missingSettings(settings: TeamsBotSettings | undefined): string[] {
    const need: [keyof TeamsBotSettings, string][] = [
      ['tenantId', 'TEAMS_TENANT_ID'],
      ['appId', 'TEAMS_BOT_APP_ID'],
      ['appPassword', 'TEAMS_BOT_APP_PASSWORD'],
      ['serviceUrl', 'TEAMS_SERVICE_URL'],
    ];
    return need.filter(([key]) => !settings?.[key]).map(([, name]) => name);
  }

  private get settings(): Required<TeamsBotSettings> {
    const found = this.config.get<TeamsBotSettings>('teams.bot') ?? {};
    return {
      tenantId: found.tenantId ?? '',
      appId: found.appId ?? '',
      appPassword: found.appPassword ?? '',
      serviceUrl: (found.serviceUrl ?? '').replace(/\/?$/, '/'),
    };
  }

  async send(recipient: TeamsRecipient, message: TeamsMessage): Promise<void> {
    const conversationId = await this.conversationOf(recipient);
    const response = await this.fetcher(
      `${this.settings.serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`,
      {
        method: 'POST',
        headers: await this.botHeaders(),
        body: JSON.stringify({
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: adaptiveCard(message),
            },
          ],
        }),
      },
    );
    if (response.status === 403 || response.status === 404) {
      // The chat is gone (app uninstalled) — find it again next time.
      await this.prisma.teamsChatLink.deleteMany({
        where: { userId: recipient.userId },
      });
    }
    await ensureOk(response, 'ส่งข้อความเข้า Teams');
  }

  /** The person's 1:1 chat with the bot — cached, or found and opened now. */
  private async conversationOf(recipient: TeamsRecipient): Promise<string> {
    const cached = await this.prisma.teamsChatLink.findUnique({
      where: { userId: recipient.userId },
      select: { conversationId: true },
    });
    if (cached) return cached.conversationId;

    const aadObjectId = await this.lookUpUser(recipient.email);
    const { tenantId, appId, serviceUrl } = this.settings;
    const response = await this.fetcher(`${serviceUrl}v3/conversations`, {
      method: 'POST',
      headers: await this.botHeaders(),
      body: JSON.stringify({
        isGroup: false,
        bot: { id: `28:${appId}` },
        members: [{ id: aadObjectId }],
        tenantId,
        channelData: { tenant: { id: tenantId } },
      }),
    });
    if (response.status === 403 || response.status === 404) {
      throw new TeamsPermanentError(
        'ยังไม่ได้ติดตั้งแอปบอทแจ้งเตือนให้ผู้ใช้นี้ใน Teams',
      );
    }
    await ensureOk(response, 'เปิดแชทกับผู้ใช้ใน Teams');
    const { id } = (await response.json()) as { id: string };
    await this.prisma.teamsChatLink.upsert({
      where: { userId: recipient.userId },
      create: { userId: recipient.userId, aadObjectId, conversationId: id },
      update: { aadObjectId, conversationId: id },
    });
    return id;
  }

  private async lookUpUser(email: string): Promise<string> {
    const quoted = email.replace(/'/g, "''");
    const url =
      'https://graph.microsoft.com/v1.0/users?$select=id&$filter=' +
      encodeURIComponent(
        `mail eq '${quoted}' or userPrincipalName eq '${quoted}'`,
      );
    const response = await this.fetcher(url, {
      headers: {
        authorization: `Bearer ${await this.token('https://graph.microsoft.com/.default')}`,
      },
    });
    await ensureOk(response, 'ค้นผู้ใช้ใน Microsoft 365');
    const { value } = (await response.json()) as { value: { id: string }[] };
    if (!value?.length) {
      throw new TeamsPermanentError(`ไม่พบ ${email} ใน Microsoft 365`);
    }
    return value[0].id;
  }

  private async botHeaders() {
    return {
      authorization: `Bearer ${await this.token('https://api.botframework.com/.default')}`,
      'content-type': 'application/json',
    };
  }

  private async token(scope: string): Promise<string> {
    const cached = this.tokens.get(scope);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const { tenantId, appId, appPassword } = this.settings;
    const response = await this.fetcher(
      `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: appId,
          client_secret: appPassword,
          scope,
        }).toString(),
      },
    );
    await ensureOk(response, 'ขอ token จาก Microsoft Entra');
    const body = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.tokens.set(scope, {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    });
    return body.access_token;
  }
}

async function ensureOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text().catch(() => '')).slice(0, 300);
  throw new Error(
    `${what} ไม่สำเร็จ (HTTP ${response.status}) ${detail}`.trim(),
  );
}

/** Title, body, and one button back into the system. */
export function adaptiveCard(message: TeamsMessage) {
  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: message.title,
        weight: 'Bolder',
        size: 'Medium',
        wrap: true,
      },
      { type: 'TextBlock', text: message.body, wrap: true },
    ],
    actions: message.link
      ? [
          {
            type: 'Action.OpenUrl',
            title: 'เปิดใน Connect the Dot',
            url: message.link,
          },
        ]
      : [],
  };
}
