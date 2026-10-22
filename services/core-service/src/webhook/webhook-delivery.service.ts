import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { backgroundTick } from '../common/background-tick';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { openSecret } from '../pm/config-rules';
import {
  ClaimedDelivery,
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from './webhook.repository';
import {
  addressProblems,
  DELIVERY_TIMEOUT_MS,
  nextAttemptDelayMs,
  signWebhook,
  standardSignature,
} from './webhook-rules';

const BATCH = 20;
const LEASE_MS = 5 * 60_000;
const MAX_ERROR = 500;

/** What the admin reads in `last_error` — a redirect says where, since it is never followed. */
function failureOf(response: Response): string {
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400) {
    return `HTTP ${response.status} — ปลายทาง redirect ไป ${location ?? '(ไม่ระบุ)'} ระบบไม่ตาม redirect เพื่อกัน SSRF ให้แก้ URL เป็นปลายทางจริง`;
  }
  return `HTTP ${response.status}`;
}

/**
 * G-07 — outbound webhooks.
 *
 * Every domain event becomes an outbox row per subscription listening to it
 * (both processes: an event raised through the external API is emitted in
 * external-service). The timer that sends them runs in core-service only;
 * external-service sets `webhook.intervalMs` to 0, as for every other clock.
 *
 * At-least-once and best-effort: the event is emitted after the commit, so a
 * process dying between the two loses it; receivers dedupe on `X-Webhook-Id`
 * and reconcile through the API.
 */
@Injectable()
export class WebhookDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly subscriptions: WebhookSubscriptionRepository,
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly events: DomainEventsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    for (const name of Object.values(DOMAIN_EVENTS)) {
      this.events.on(name, (event) =>
        this.enqueue(event.name, event.payload)
          .then(() => undefined)
          .catch((error: Error) =>
            this.logger.warn(
              `webhook ${event.name} not queued: ${error.message}`,
            ),
          ),
      );
    }
    const interval = this.config.get<number>('webhook.intervalMs') ?? 0;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'G-07 webhook delivery', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pending row per active subscription of the company that listens to `eventName`. */
  async enqueue(
    eventName: string,
    payload: { company_id: string },
  ): Promise<number> {
    const subs = await this.subscriptions.listeningTo(
      payload.company_id,
      eventName,
    );
    if (subs.length === 0) return 0;
    const { count } = await this.deliveries.createMany({
      data: subs.map((sub) => ({
        subscriptionId: sub.id,
        eventName,
        payload,
      })),
    });
    return count;
  }

  /** Send what is due; returns how many rows were attempted. */
  async sweep(): Promise<number> {
    const due = await this.deliveries.claimDue(BATCH, LEASE_MS);
    for (const delivery of due) await this.deliver(delivery);
    return due.length;
  }

  private async deliver(delivery: ClaimedDelivery): Promise<void> {
    const sub = await this.subscriptions.findUnique({
      where: { id: delivery.subscriptionId },
    });
    if (!sub?.active) {
      await this.finish(delivery.id, 'dead', null, 'subscription ถูกปิดแล้ว');
      return;
    }
    const secret = openSecret(
      sub.secretEnc,
      this.config.get<string>('projectConfig.secret') ?? '',
    );
    if (secret === null) {
      await this.finish(
        delivery.id,
        'dead',
        null,
        'ถอดรหัส secret ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ต้องออก secret ใหม่',
      );
      return;
    }
    const privateHosts =
      this.config.get<string[]>('webhook.privateHosts') ?? [];
    const refused = await addressProblems(sub.url, privateHosts);
    if (refused.length) {
      await this.retryOrDie(delivery, null, refused.join('; '));
      return;
    }

    const body = JSON.stringify({
      id: delivery.eventId,
      event: delivery.eventName,
      created_at: delivery.createdAt.toISOString(),
      data: delivery.payload,
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await fetch(sub.url, {
        method: 'POST',
        // a redirect could point inside after the address check passed
        redirect: 'manual',
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'request-management-webhook/1',
          'X-Webhook-Id': delivery.eventId,
          'X-Webhook-Event': delivery.eventName,
          'X-Webhook-Timestamp': timestamp,
          'X-Webhook-Signature': signWebhook(secret, timestamp, body),
          // Standard Webhooks — ผู้รับใช้ library มาตรฐาน verify ได้; header เดิมคงไว้
          'webhook-id': delivery.eventId,
          'webhook-timestamp': timestamp,
          'webhook-signature': standardSignature(
            secret,
            delivery.eventId,
            timestamp,
            body,
          ),
        },
        body,
      });
      // an unread body keeps the socket out of the pool until GC
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        await this.finish(delivery.id, 'sent', response.status, null);
      } else {
        await this.retryOrDie(delivery, response.status, failureOf(response));
      }
    } catch (error) {
      await this.retryOrDie(
        delivery,
        null,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async retryOrDie(
    delivery: ClaimedDelivery,
    statusCode: number | null,
    reason: string,
  ): Promise<void> {
    const delay = nextAttemptDelayMs(delivery.attempts);
    if (delay === null) {
      await this.finish(delivery.id, 'dead', statusCode, reason);
      return;
    }
    await this.deliveries.update({
      where: { id: delivery.id },
      data: {
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + delay),
        lastStatusCode: statusCode,
        lastError: reason.slice(0, MAX_ERROR),
      },
    });
  }

  private finish(
    id: string,
    status: 'sent' | 'dead',
    statusCode: number | null,
    reason: string | null,
  ) {
    return this.deliveries.update({
      where: { id },
      data: {
        status,
        lastStatusCode: statusCode,
        lastError: reason?.slice(0, MAX_ERROR) ?? null,
        sentAt: status === 'sent' ? new Date() : undefined,
      },
    });
  }
}
