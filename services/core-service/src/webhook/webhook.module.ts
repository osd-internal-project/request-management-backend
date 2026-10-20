import { Module } from '@nestjs/common';
import { WebhookDeliveryService } from './webhook-delivery.service';
import {
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from './webhook.repository';

/** G-07 — domain half: queue on every event, send on core-service's clock. */
@Module({
  providers: [
    WebhookSubscriptionRepository,
    WebhookDeliveryRepository,
    WebhookDeliveryService,
  ],
  exports: [
    WebhookSubscriptionRepository,
    WebhookDeliveryRepository,
    WebhookDeliveryService,
  ],
})
export class WebhookModule {}
