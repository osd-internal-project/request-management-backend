import { Module } from '@nestjs/common';
import { DeliveryModule as CoreDeliveryModule } from '@request-management/core-service';
import { AuthModule } from '../auth/auth.module';
import { ExternalDeliveryController } from './delivery.controller';

/**
 * `api/v1/delivery/*` — the three services it reads are exported by the
 * Delivery domain module; nothing is declared again. Its timers (goods
 * readiness, retention, hand-over and receivable reminders) are zeroed in
 * this service's config: the clocks are core-service's.
 */
@Module({
  imports: [CoreDeliveryModule, AuthModule],
  controllers: [ExternalDeliveryController],
})
export class DeliveryModule {}
