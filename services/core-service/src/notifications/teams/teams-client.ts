/**
 * CD-51 — how a notification reaches a person in Microsoft Teams (user
 * decision 29 ก.ย. 2569: a bot's 1:1 chat with each recipient, not a team
 * channel). Behind an interface like the email transport (D-34):
 *
 *   TEAMS_MODE=off (default) — no Teams channel; nothing is queued.
 *   TEAMS_MODE=mock          — logs and succeeds, for development.
 *   TEAMS_MODE=botframework  — the real one (teams-botframework.client.ts):
 *                              an Azure bot registration, admin-consented,
 *                              its Teams app deployed to the users.
 */

export const TEAMS_CLIENT = 'TEAMS_CLIENT';

export type TeamsMode = 'off' | 'mock' | 'botframework';

export interface TeamsRecipient {
  readonly userId: string;
  /** Microsoft 365 sign-in or mail address — how the bot finds the person. */
  readonly email: string;
}

export interface TeamsMessage {
  readonly title: string;
  readonly body: string;
  /** "Open in Connect the Dot" — absent when no public URL is configured. */
  readonly link: string | null;
}

/**
 * Will not succeed on a retry — the person is not in Microsoft 365, or the
 * bot's app is not installed for them. The worker marks the send failed at
 * once instead of backing off.
 */
export class TeamsPermanentError extends Error {}

export interface TeamsClient {
  readonly mode: Exclude<TeamsMode, 'off'>;
  send(recipient: TeamsRecipient, message: TeamsMessage): Promise<void>;
}
