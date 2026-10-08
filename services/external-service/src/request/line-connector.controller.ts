import {
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { AppError, Public } from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  ApiKeyService,
  CareService,
  CustomerIntakeService,
  RequestsService,
} from '@request-management/core-service';
import {
  careMessages,
  lineSignatureValid,
  messageField,
  textMessages,
  type LineEvent,
} from './line-connector';

/**
 * CD-66 — LINE connector (user decision 29 ก.ย. 2569: the web form first,
 * LINE as a connector). A text message to the company's LINE OA raises a
 * request through the company's `line` channel and is answered with the
 * request number and the status link.
 *
 * **`@Public()` — a stated exception.** LINE cannot send our API key; the
 * webhook is authenticated by LINE's signature over the raw body with the
 * channel secret, checked before anything else. A company without
 * `LINE_CHANNEL_SECRET_<CODE>` configured answers 404, as does one whose
 * `line` channel is not set up — the route discloses nothing.
 *
 * Off until configured: see docs/customer-intake.md for the LINE side
 * (webhook URL, secrets).
 *
 * CD-285 — once the company's AI CARE channel is on, LINE is a conversation
 * instead: every message (text, image, file, voice, video, sticker,
 * location) joins the sender's AI CARE conversation, and AI CARE's answer
 * goes back with the reply token (free) — or a push when the token has run
 * out. Images and files are copied in by core-service (LINE lends them).
 */
@Controller('request/intake/line')
export class LineConnectorController {
  private readonly logger = new Logger(LineConnectorController.name);

  constructor(
    private readonly intake: CustomerIntakeService,
    private readonly requests: RequestsService,
    private readonly keys: ApiKeyService,
    private readonly config: ConfigService,
    private readonly care: CareService,
  ) {}

  @Post(':companyCode')
  @Public()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async webhook(
    @Param('companyCode') companyCode: string,
    @Headers('x-line-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const code = companyCode.toUpperCase();
    const secret = this.config.get<string>(`LINE_CHANNEL_SECRET_${code}`) ?? '';
    if (
      !secret ||
      !req.rawBody ||
      !lineSignatureValid(req.rawBody, signature, secret)
    ) {
      throw new AppError('NOT_FOUND', 'Not found');
    }
    const body = req.body as { events?: LineEvent[] };

    // CD-285 — AI CARE on: LINE is a conversation
    const careCompany = await this.intake.companyIdOfCode(code, 'ai_care');
    if (careCompany && (await this.care.takesLine(careCompany))) {
      await this.toCare(code, careCompany, body.events ?? []);
      return { ok: true };
    }

    const companyId = await this.intake.companyIdOfCode(code, 'line');
    if (!companyId) throw new AppError('NOT_FOUND', 'Not found');

    const messages = textMessages(body.events ?? []);
    if (!messages.length) return { ok: true };

    const authorization = `Bearer ${await this.keys.integrationToken()}`;
    const actor = connectorPrincipal(companyId);
    const offered = await this.channelType(companyId);

    for (const message of messages) {
      let reply: string;
      try {
        if (!offered) throw new Error('no request type with a text field');
        const done = await this.intake.submitChannel(
          'line',
          companyId,
          {
            type_code: offered.code,
            form_data: { [offered.field]: message.text },
            contact: {
              name: await this.displayName(code, message.userId),
              line_user_id: message.userId,
            },
          },
          actor,
          authorization,
        );
        reply = `รับคำขอแล้ว เลขที่ ${done.request_no ?? '-'}\nติดตามสถานะ: ${this.statusUrl(done.status_token)}`;
      } catch (error) {
        this.logger.warn(
          `LINE ${code}: request not raised — ${(error as Error).message}`,
        );
        reply =
          'ขออภัย ยังรับคำขอทาง LINE ไม่ได้ในขณะนี้ กรุณาติดต่อเจ้าหน้าที่';
      }
      if (message.replyToken) await this.reply(code, message.replyToken, reply);
    }
    return { ok: true };
  }

  /** CD-285 — each message into the sender's AI CARE conversation, answered. */
  private async toCare(code: string, companyId: string, events: LineEvent[]) {
    const names = new Map<string, string>();
    for (const message of careMessages(events)) {
      try {
        if (!names.has(message.userId))
          names.set(
            message.userId,
            await this.displayName(code, message.userId),
          );
        const result = await this.care.receive(companyId, {
          channel: 'line',
          senderRef: message.userId,
          senderName: names.get(message.userId),
          text: message.text ?? undefined,
          attachments: message.attachment ? [message.attachment] : [],
          at: message.at,
        });
        if (result.reply?.text)
          await this.replyOrPush(
            code,
            message.replyToken,
            message.userId,
            result.reply.text,
          );
      } catch (error) {
        this.logger.warn(
          `LINE ${code}: AI CARE message not taken — ${(error as Error).message}`,
        );
      }
    }
  }

  /** The reply token first (it costs nothing); a push when it has run out. */
  private async replyOrPush(
    code: string,
    replyToken: string | null,
    userId: string,
    text: string,
  ) {
    const token = this.config.get<string>(`LINE_CHANNEL_ACCESS_TOKEN_${code}`);
    if (!token) return;
    const send = (url: string, body: Record<string, unknown>) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...body,
          messages: [{ type: 'text', text: text.slice(0, 5000) }],
        }),
      }).then(
        (response) => response.ok,
        () => false,
      );
    if (
      replyToken &&
      (await send('https://api.line.me/v2/bot/message/reply', { replyToken }))
    )
      return;
    if (
      !(await send('https://api.line.me/v2/bot/message/push', { to: userId }))
    )
      this.logger.warn(`LINE ${code}: answer not delivered to ${userId}`);
  }

  /** The line channel's first request type, and the field a message goes into. */
  private async channelType(companyId: string) {
    const channels = await this.intake.listAdmin(
      connectorPrincipal(companyId),
      companyId,
    );
    const line = channels.find((row) => row.channel === 'line');
    const types = await this.requests.channelTypes(
      companyId,
      line?.type_codes ?? [],
    );
    for (const type of types) {
      const field = messageField(type.fields);
      if (field) return { code: type.code, field };
    }
    return null;
  }

  private statusUrl(token: string): string {
    const base = this.config.get<string>('PUBLIC_WEB_URL') ?? '';
    return `${base.replace(/\/$/, '')}/f/status/${token}`;
  }

  private async displayName(code: string, userId: string): Promise<string> {
    const token = this.config.get<string>(`LINE_CHANNEL_ACCESS_TOKEN_${code}`);
    if (!token) return 'ผู้ใช้ LINE';
    try {
      const response = await fetch(
        `https://api.line.me/v2/bot/profile/${encodeURIComponent(userId)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!response.ok) return 'ผู้ใช้ LINE';
      const profile = (await response.json()) as { displayName?: string };
      return profile.displayName?.slice(0, 255) || 'ผู้ใช้ LINE';
    } catch {
      return 'ผู้ใช้ LINE';
    }
  }

  private async reply(code: string, replyToken: string, text: string) {
    const token = this.config.get<string>(`LINE_CHANNEL_ACCESS_TOKEN_${code}`);
    if (!token) return;
    try {
      await fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          replyToken,
          messages: [{ type: 'text', text: text.slice(0, 5000) }],
        }),
      });
    } catch (error) {
      this.logger.warn(
        `LINE ${code}: reply failed — ${(error as Error).message}`,
      );
    }
  }
}

/** The connector acting for one company — a system actor, no user row. */
function connectorPrincipal(companyId: string): Principal {
  return {
    userId: 'system:line-connector',
    username: 'line-connector',
    displayName: 'LINE connector',
    isServiceAccount: true,
    activeCompanyId: companyId,
    orgUnitId: null,
    ledUnitIds: [],
    scopedUnitIds: [],
    companies: [],
    permissions: [],
  } as unknown as Principal;
}
