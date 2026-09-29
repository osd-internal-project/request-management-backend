import { Injectable, Logger } from '@nestjs/common';
import type { TeamsClient, TeamsMessage, TeamsRecipient } from './teams-client';

/** TEAMS_MODE=mock — nothing leaves this machine; the log says so. */
@Injectable()
export class MockTeamsClient implements TeamsClient {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockTeamsClient.name);
  /** What was "sent" — for tests and a quick look while developing. */
  readonly sent: { recipient: TeamsRecipient; message: TeamsMessage }[] = [];

  send(recipient: TeamsRecipient, message: TeamsMessage): Promise<void> {
    this.sent.push({ recipient, message });
    if (this.sent.length > 200) this.sent.shift();
    this.logger.log(
      `Teams (mock) NOT SENT: to=${recipient.email} title="${message.title}"`,
    );
    return Promise.resolve();
  }
}
