import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SlaController } from './sla.controller';
import { SlaConfigService } from './sla-config.service';
import { SlaMonitorService } from './sla-monitor.service';
import { SlaService } from './sla.service';

/** S3 — the minimum clock from §09. */
@Module({
  imports: [NotificationsModule],
  controllers: [SlaController],
  providers: [SlaConfigService, SlaMonitorService, SlaService],
  exports: [SlaMonitorService, SlaService],
})
export class SlaModule {}
