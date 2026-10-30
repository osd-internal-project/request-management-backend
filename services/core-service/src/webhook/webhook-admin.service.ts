import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import { IntegrationAdminService } from '../principal/integration-admin.service';
import {
  WEBHOOK_EXAMPLES,
  type WebhookExample,
} from '../principal/api-examples.generated';
import {
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from './webhook.repository';
import {
  addressProblems,
  eventProblems,
  newWebhookSecret,
  urlProblems,
  WEBHOOK_EVENTS,
  WEBHOOK_PING,
} from './webhook-rules';
import {
  CreateWebhookDto,
  UpdateWebhookDto,
  WebhookDeliveryRowDto,
  WebhookRowDto,
  WebhookWithSecretDto,
} from './dto/webhook.dto';

const DELIVERY_PAGE = 50;

interface SubscriptionRow {
  id: string;
  companyId: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  integrationId: string | null;
  secretEnc: string;
  createdAt: Date;
  createdBy: string;
}

/**
 * G-07 — the admin screen for outbound webhooks. Every route is pinned to the
 * caller's active company; another company's webhook answers 404 (SCOPE-03).
 * The secret leaves in the answer to create / rotate / reveal, never in audit.
 */
@Injectable()
export class WebhookAdminService {
  constructor(
    private readonly subscriptions: WebhookSubscriptionRepository,
    private readonly deliveries: WebhookDeliveryRepository,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
    private readonly integrations: IntegrationAdminService,
  ) {}

  events() {
    return WEBHOOK_EVENTS.map((code) => ({ code }));
  }

  /** Delivery bodies for the named events; none named = every event. */
  examples(events: readonly string[]): WebhookExample[] {
    if (!events.length) return [...WEBHOOK_EXAMPLES];
    const problems = eventProblems(events);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems.join(' · '),
        problems.map((reason) => ({ field: 'events', reason })),
      );
    }
    return WEBHOOK_EXAMPLES.filter((example) => events.includes(example.event));
  }

  async list(actor: Principal): Promise<WebhookRowDto[]> {
    const rows = (await this.subscriptions.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: { createdAt: 'desc' },
    })) as SubscriptionRow[];
    return rows.map(toRow);
  }

  async create(
    dto: CreateWebhookDto,
    actor: Principal,
  ): Promise<WebhookWithSecretDto> {
    const events = [...new Set(dto.events)];
    await this.assertValid(dto.url, events);
    const integrationId = await this.integrationOf(dto.integration_id, actor);
    const secret = newWebhookSecret();
    const row = (await this.subscriptions.create({
      data: {
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        url: dto.url,
        events,
        secretEnc: this.seal(secret),
        integrationId,
        createdBy: actor.userId,
      },
    })) as SubscriptionRow;

    await this.audit.record({
      eventType: 'admin.webhook.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'webhook',
      resourceId: row.id,
      after: { name: row.name, url: row.url, events },
    });
    return { ...toRow(row), secret };
  }

  async update(
    id: string,
    dto: UpdateWebhookDto,
    actor: Principal,
  ): Promise<WebhookRowDto> {
    const found = await this.owned(id, actor);
    const url = dto.url ?? found.url;
    const events = dto.events ? [...new Set(dto.events)] : found.events;
    if (dto.url !== undefined || dto.events !== undefined) {
      await this.assertValid(url, events);
    }
    const row = (await this.subscriptions.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        url,
        events,
        active: dto.active,
        integrationId: await this.integrationOf(dto.integration_id, actor),
      },
    })) as SubscriptionRow;

    await this.audit.record({
      eventType: 'admin.webhook.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'webhook',
      resourceId: id,
      before: summary(found),
      after: summary(row),
    });
    return toRow(row);
  }

  async rotateSecret(
    id: string,
    actor: Principal,
  ): Promise<WebhookWithSecretDto> {
    await this.owned(id, actor);
    const secret = newWebhookSecret();
    const row = (await this.subscriptions.update({
      where: { id },
      data: { secretEnc: this.seal(secret) },
    })) as SubscriptionRow;

    await this.audit.record({
      eventType: 'admin.webhook.secret_rotated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'webhook',
      resourceId: id,
      after: { name: row.name },
    });
    return { ...toRow(row), secret };
  }

  /** secret ปัจจุบัน — ทุกครั้งที่ดูลง audit (ไม่มีตัว secret ในนั้น). */
  async revealSecret(
    id: string,
    actor: Principal,
  ): Promise<{ secret: string }> {
    const found = await this.owned(id, actor);
    const secret = openSecret(found.secretEnc, this.sealKey());
    if (secret === null) {
      throw new AppError(
        'UNPROCESSABLE',
        'ถอดรหัส secret ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ให้กดออก secret ใหม่',
      );
    }
    await this.audit.record({
      eventType: 'admin.webhook.secret_revealed',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'webhook',
      resourceId: id,
      after: { name: found.name },
    });
    return { secret };
  }

  /**
   * ส่งการแจ้งเดิมซ้ำ — แถวใหม่ `pending` ที่ `eventId` เดิม ปลายทางจึงตัดซ้ำด้วย
   * `X-Webhook-Id` ได้; แถวเดิมคงไว้เป็นประวัติ. แถวที่ยังรอส่งอยู่ส่งซ้ำไม่ได้.
   */
  async redeliver(
    id: string,
    deliveryId: string,
    actor: Principal,
  ): Promise<{ queued: true }> {
    const found = await this.owned(id, actor);
    if (!found.active) {
      throw new AppError(
        'UNPROCESSABLE',
        'webhook นี้ปิดอยู่ — เปิดก่อนจึงส่งซ้ำได้',
      );
    }
    const delivery = await this.deliveries.findFirst({
      where: { id: deliveryId, subscriptionId: id },
    });
    if (!delivery) throw new AppError('NOT_FOUND', 'ไม่พบการส่งที่ระบุ');
    if (delivery.status !== 'sent' && delivery.status !== 'dead') {
      throw new AppError(
        'UNPROCESSABLE',
        'รายการนี้ยังอยู่ระหว่างส่ง — รอให้ส่งสำเร็จหรือล้มเหลวก่อน',
      );
    }

    const queued = await this.deliveries.create({
      data: {
        subscriptionId: id,
        eventId: delivery.eventId,
        eventName: delivery.eventName,
        // JSON ที่อ่านมาจากคอลัมน์เดียวกัน (NOT NULL) เขียนกลับได้ตามเดิม
        payload: delivery.payload as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      eventType: 'admin.webhook.redelivered',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'webhook',
      resourceId: id,
      after: {
        deliveryId: queued.id,
        fromDeliveryId: deliveryId,
        eventId: delivery.eventId,
        event: delivery.eventName,
      },
    });
    return { queued: true };
  }

  async listDeliveries(
    id: string,
    actor: Principal,
  ): Promise<WebhookDeliveryRowDto[]> {
    await this.owned(id, actor);
    const rows = await this.deliveries.findMany({
      where: { subscriptionId: id },
      orderBy: { createdAt: 'desc' },
      take: DELIVERY_PAGE,
    });
    return rows.map((row) => ({
      id: row.id,
      event_id: row.eventId,
      event: row.eventName,
      status: row.status,
      attempts: row.attempts,
      last_status_code: row.lastStatusCode,
      last_error: row.lastError,
      next_attempt_at: row.nextAttemptAt.toISOString(),
      sent_at: row.sentAt?.toISOString() ?? null,
      created_at: row.createdAt.toISOString(),
    }));
  }

  /** Queue a `webhook.ping`; the next sweep sends it like any event. */
  async test(id: string, actor: Principal): Promise<{ queued: true }> {
    const found = await this.owned(id, actor);
    if (!found.active) {
      throw new AppError(
        'UNPROCESSABLE',
        'webhook นี้ปิดอยู่ — เปิดก่อนจึงทดสอบได้',
      );
    }
    await this.deliveries.create({
      data: {
        subscriptionId: id,
        eventName: WEBHOOK_PING,
        payload: { company_id: found.companyId, webhook_id: id },
      },
    });
    return { queued: true };
  }

  private async owned(id: string, actor: Principal): Promise<SubscriptionRow> {
    const found = (await this.subscriptions.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as SubscriptionRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ webhook ที่ระบุ');
    return found;
  }

  /** integration ของบริษัทผู้เรียกเท่านั้น — ไม่ระบุ = ไม่แตะ (undefined). */
  private async integrationOf(
    id: string | undefined,
    actor: Principal,
  ): Promise<string | undefined> {
    if (!id) return undefined;
    return (await this.integrations.owned(id, actor)).id;
  }

  private async assertValid(url: string, events: string[]): Promise<void> {
    const privateHosts =
      this.config.get<string[]>('webhook.privateHosts') ?? [];
    const shape = urlProblems(url, privateHosts);
    const problems = [
      ...shape.map((reason) => ({ field: 'url', reason })),
      ...(shape.length
        ? []
        : (await addressProblems(url, privateHosts)).map((reason) => ({
            field: 'url',
            reason,
          }))),
      ...eventProblems(events).map((reason) => ({ field: 'events', reason })),
    ];
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems.map((problem) => problem.reason).join(' · '),
        problems,
      );
    }
  }

  private seal(secret: string): string {
    return sealSecret(secret, this.sealKey());
  }

  private sealKey(): string {
    const key = this.config.get<string>('projectConfig.secret');
    if (!key) throw new Error('CONFIG_SECRET_KEY is not set');
    return key;
  }
}

function toRow(row: SubscriptionRow): WebhookRowDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    events: row.events,
    active: row.active,
    integration_id: row.integrationId,
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy,
  };
}

function summary(row: SubscriptionRow) {
  return {
    name: row.name,
    url: row.url,
    events: row.events,
    active: row.active,
    integrationId: row.integrationId,
  };
}
