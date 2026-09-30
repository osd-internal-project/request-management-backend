import { Injectable, Logger } from '@nestjs/common';

/**
 * CD-166 / CD-167 — how an external signer is reached: the signing link,
 * and the one-time code. A port, so SMTP or an SMS gateway plugs in without
 * touching the signing steps (the same shape as the Teams and SAP clients).
 */
export interface EsignSender {
  /** Which channels this sender can deliver on. */
  readonly channels: readonly ('email' | 'sms')[];
  sendLink(
    to: { name: string; email: string | null; phone: string | null },
    message: {
      title: string;
      link: string;
      expiresAt: Date;
      note: string | null;
    },
  ): Promise<void>;
  sendCode(
    channel: 'email' | 'sms',
    address: string,
    message: { title: string; code: string; expiresAt: Date },
  ): Promise<void>;
}

export const ESIGN_SENDER = Symbol('ESIGN_SENDER');

/**
 * Until SMTP / SMS are set up (IT): nothing leaves the building. The link is
 * shown once to whoever sent the envelope; the code is written to the log —
 * for development only, so it is refused under NODE_ENV=production.
 */
@Injectable()
export class MockEsignSender implements EsignSender {
  private readonly logger = new Logger('EsignSender(mock)');
  readonly channels = ['email', 'sms'] as const;

  sendLink(
    to: { name: string; email: string | null; phone: string | null },
    message: { title: string },
  ): Promise<void> {
    this.logger.log(
      `signing link for "${message.title}" to ${to.name} — not sent (mock): the sender copies it from the screen`,
    );
    return Promise.resolve();
  }

  sendCode(
    channel: 'email' | 'sms',
    address: string,
    message: { title: string; code: string },
  ): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      return Promise.reject(
        new Error(
          'ยังไม่ได้ตั้งช่องส่งรหัส (ESIGN_SENDER_MODE) — ส่งรหัสไม่ได้',
        ),
      );
    }
    this.logger.warn(
      `[dev only] one-time code for "${message.title}" via ${channel} to ${address}: ${message.code}`,
    );
    return Promise.resolve();
  }
}
