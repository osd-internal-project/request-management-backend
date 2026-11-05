import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MAIL_CLIENT, type MailClient } from './mail-client';
import { SalesMailService } from './sales-mail.service';

/**
 * Reads the mailbox for customers' answers (MAIL_MODE=graph). Each sweep
 * lists the inbox since the last message seen — ids and thread ids only —
 * and opens a message only when its thread is one the system started; the
 * rest of the mailbox (a developer's own, for now) is never read.
 *
 * core-service only: external-service sets the interval to 0 (one clock).
 */
@Injectable()
export class SalesMailPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SalesMailPollerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cursor: Date;

  constructor(
    @Optional() @Inject(MAIL_CLIENT) private readonly mail: MailClient | null,
    private readonly sales: SalesMailService,
    private readonly config: ConfigService,
  ) {
    const hours = this.config.get<number>('mail.pollLookbackHours') ?? 24;
    this.cursor = new Date(Date.now() - hours * 3_600_000);
  }

  onModuleInit(): void {
    const interval = this.config.get<number>('mail.pollIntervalMs') ?? 0;
    // the mock has no inbox: answers are simulated straight into ingest
    if (!this.mail || this.mail.mode !== 'graph' || interval <= 0) return;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; returns how many answers were stored. */
  async sweep(): Promise<number> {
    if (!this.mail || this.running) return 0;
    this.running = true;
    let stored = 0;
    try {
      const refs = await this.mail.listInbox(this.cursor);
      const known = await this.sales.knownThreads(
        refs
          .map((ref) => ref.conversationId)
          .filter((id): id is string => !!id),
      );
      for (const ref of refs) {
        if (ref.receivedAt > this.cursor) this.cursor = ref.receivedAt;
        if (!ref.conversationId || !known.has(ref.conversationId)) continue;
        if (await this.sales.alreadyStored(ref.internetMessageId)) continue;
        try {
          const row = await this.sales.ingest(
            await this.mail.read(ref.graphMessageId),
          );
          if (row) stored += 1;
        } catch (failure) {
          this.logger.warn(
            `message ${ref.graphMessageId} not ingested: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
      }
    } catch (failure) {
      this.logger.warn(
        `inbox sweep failed: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    } finally {
      this.running = false;
    }
    return stored;
  }
}
