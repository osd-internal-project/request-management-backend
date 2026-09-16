import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SlaConfigService } from './sla-config.service';
import { SlaMonitorService } from './sla-monitor.service';
import { SlaService } from './sla.service';

/** S3 — the minimum clock from §09. */
@Module({
  imports: [NotificationsModule],
  providers: [SlaConfigService, SlaMonitorService, SlaService],
  /* `SlaConfigService` is exported for `SlaHttpModule`'s controller. */
  exports: [SlaMonitorService, SlaService, SlaConfigService],
})
export class SlaModule {}
