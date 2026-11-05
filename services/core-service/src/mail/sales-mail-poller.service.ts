import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailClientsService, type PollTarget } from './mail-clients.service';
import { SalesMailService } from './sales-mail.service';

/**
 * Reads each graph mailbox for customers' answers. Each sweep
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
  /** Last message seen, per mailbox. */
  private readonly cursors = new Map<string, Date>();
  private readonly lookbackMs: number;

  constructor(
    private readonly clients: MailClientsService,
    private readonly sales: SalesMailService,
    private readonly config: ConfigService,
  ) {
    const hours = this.config.get<number>('mail.pollLookbackHours') ?? 24;
    this.lookbackMs = hours * 3_600_000;
  }

  onModuleInit(): void {
    const interval = this.config.get<number>('mail.pollIntervalMs') ?? 0;
    // a mailbox can be set on screen at any time, so the clock always runs
    if (interval <= 0) return;
    this.timer = setInterval(() => void this.sweep(), interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over every graph mailbox; returns how many answers were stored. */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let stored = 0;
    try {
      for (const target of await this.clients.pollTargets()) {
        stored += await this.sweepOne(target);
      }
    } catch (failure) {
      this.logger.warn(`inbox sweep failed: ${describe(failure)}`);
    } finally {
      this.running = false;
    }
    return stored;
  }

  private async sweepOne(target: PollTarget): Promise<number> {
    const mail = target.client;
    let cursor =
      this.cursors.get(target.key) ?? new Date(Date.now() - this.lookbackMs);
    let stored = 0;
    try {
      const refs = await mail.listInbox(cursor);
      const known = await this.sales.knownThreads(
        refs
          .map((ref) => ref.conversationId)
          .filter((id): id is string => !!id),
      );
      for (const ref of refs) {
        if (ref.receivedAt > cursor) cursor = ref.receivedAt;
        if (!ref.conversationId || !known.has(ref.conversationId)) continue;
        if (await this.sales.alreadyStored(ref.internetMessageId)) continue;
        try {
          const row = await this.sales.ingest(
            await mail.read(ref.graphMessageId),
            mail.mailbox,
          );
          if (row) stored += 1;
        } catch (failure) {
          this.logger.warn(
            `message ${ref.graphMessageId} not ingested: ${describe(failure)}`,
          );
        }
      }
    } catch (failure) {
      this.logger.warn(`inbox ${target.key} not read: ${describe(failure)}`);
    }
    this.cursors.set(target.key, cursor);
    return stored;
  }
}

const describe = (failure: unknown) =>
  failure instanceof Error ? failure.message : String(failure);
