import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * CD-248 — how a customer is reached with their survey link: LINE when the
 * case came in through LINE (CD-66) and the company's channel token is set,
 * else email. A port, like the e-sign sender: SMTP plugs in without touching
 * the survey. Says whether it really left the building — until SMTP exists
 * an email is only logged, and the team copies the link from the job.
 */
export interface SurveyMessage {
  companyCode: string;
  customerName: string;
  subject: string;
  link: string;
  expiresAt: Date;
}

export interface SurveyRecipient {
  name: string | null;
  email: string | null;
  lineUserId: string | null;
}

export interface SurveyDelivery {
  via: 'email' | 'line' | 'none';
  to: string | null;
  delivered: boolean;
}

@Injectable()
export class SurveySender {
  private readonly logger = new Logger(SurveySender.name);

  constructor(private readonly config: ConfigService) {}

  async send(
    to: SurveyRecipient,
    message: SurveyMessage,
  ): Promise<SurveyDelivery> {
    const text = [
      `ขอบคุณที่ใช้บริการ — ${message.subject}`,
      `ช่วยประเมินความพึงพอใจได้ที่ ${message.link}`,
      `(ลิงก์ใช้ได้ถึง ${message.expiresAt.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok' })})`,
    ].join('\n');
    if (to.lineUserId) {
      const token = this.config.get<string>(
        `LINE_CHANNEL_ACCESS_TOKEN_${message.companyCode}`,
      );
      if (token) {
        try {
          const response = await fetch(
            'https://api.line.me/v2/bot/message/push',
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                to: to.lineUserId,
                messages: [{ type: 'text', text: text.slice(0, 5000) }],
              }),
            },
          );
          return { via: 'line', to: 'LINE', delivered: response.ok };
        } catch (error) {
          this.logger.warn(
            `survey LINE push failed: ${(error as Error).message}`,
          );
          return { via: 'line', to: 'LINE', delivered: false };
        }
      }
      this.logger.log(
        'survey via LINE not sent — no channel token for the company',
      );
      return { via: 'line', to: 'LINE', delivered: false };
    }
    if (to.email) {
      // No SMTP yet (as for every outward email here): logged, copied by hand.
      this.logger.log(
        `survey link for "${message.subject}" to ${to.email} — not sent (no SMTP)`,
      );
      return { via: 'email', to: to.email, delivered: false };
    }
    return { via: 'none', to: null, delivered: false };
  }
}
