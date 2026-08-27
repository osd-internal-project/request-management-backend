import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, DomainEventName } from './event-catalog';

type Handler = (event: DomainEvent) => void | Promise<void>;

/**
 * §11.8 — in-process publication of the domain events.
 *
 * A deliberate stand-in for a broker, not a pretence of one: D-34 puts the
 * full notification service outside this codebase, and this keeps the *shape*
 * of that boundary — named events, typed payloads, idempotent consumers — so
 * swapping in a real transport later changes the transport and nothing else.
 *
 * **Publishing never fails the thing being published about.** An approval that
 * succeeded and then threw because a subscriber was broken would be a worse
 * bug than a missing notification, so handler errors are logged and swallowed.
 *
 * Emitted *after* the transaction commits, never inside it: a subscriber that
 * read the database mid-transaction would not see the change it was told
 * about, and one that ran on a transaction that later rolled back would have
 * announced something that never happened.
 */
@Injectable()
export class DomainEventsService {
  private readonly logger = new Logger(DomainEventsService.name);
  private readonly handlers = new Map<DomainEventName, Handler[]>();

  on(name: DomainEventName, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }

  async emit(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.name) ?? [];

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        this.logger.error(
          `subscriber for ${event.name} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
