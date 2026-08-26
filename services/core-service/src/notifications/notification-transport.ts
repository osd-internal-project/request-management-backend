import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OutboundMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/**
 * How a notification leaves this system (D-34).
 *
 * An interface rather than a direct SMTP call, because the full notification
 * service is a later sprint and must be able to replace this without Request
 * or Approval noticing.
 */
export abstract class NotificationTransport {
  abstract readonly channel: 'email';
  abstract send(message: OutboundMessage): Promise<void>;
}

/**
 * The stand-in used until Infra supplies SMTP settings (open question B).
 *
 * It logs and reports success, so the delivery log records an attempt and the
 * rest of SUP-03 is testable. **Nothing is actually delivered.** This is
 * deliberately visible in the logs rather than silent: a notification system
 * that quietly drops mail is worse than one that obviously does not have a
 * mail server yet.
 */
@Injectable()
export class LoggingEmailTransport extends NotificationTransport {
  readonly channel = 'email' as const;
  private readonly logger = new Logger(LoggingEmailTransport.name);

  constructor(private readonly config: ConfigService) {
    super();
  }

  get isConfigured(): boolean {
    return Boolean(this.config.get<string>('notifications.smtpHost'));
  }

  send(message: OutboundMessage): Promise<void> {
    this.logger.warn(
      `email NOT SENT (no SMTP configured — open question B): ` +
        `to=${message.to} subject="${message.subject}"`,
    );
    return Promise.resolve();
  }
}
