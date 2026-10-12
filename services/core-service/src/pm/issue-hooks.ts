import { Injectable, Logger } from '@nestjs/common';

type Handler = (issueId: string) => Promise<unknown>;

/**
 * CD-223 — a technical issue was resolved. PM cannot import the knowledge
 * base (KbModule imports PmModule), so the knowledge base subscribes here.
 * Called after the resolution commits; a failing subscriber is logged and
 * never fails the resolution — the knowledge base's sweep catches it later.
 */
@Injectable()
export class IssueResolvedHooks {
  private readonly logger = new Logger(IssueResolvedHooks.name);
  private readonly handlers: Handler[] = [];

  on(handler: Handler): void {
    this.handlers.push(handler);
  }

  async fire(issueId: string): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(issueId);
      } catch (error) {
        this.logger.warn(
          `issue ${issueId} subscriber failed: ${(error as Error).message}`,
        );
      }
    }
  }
}
