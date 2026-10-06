import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { NotificationsModule } from '../notifications/notifications.module';
import { KbController } from './kb.controller';
import { KbFieldService } from './kb-field.service';
import { KbPortalService } from './kb-portal.service';
import { KbReviewService } from './kb-review.service';
import { KbService } from './kb.service';

/** CD-22 KBMS — คลังความรู้ (images and files of articles live in MinIO). */
@Module({
  imports: [
    // CD-260 — review notices and the kb.review rule
    NotificationsModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [KbController],
  providers: [KbService, KbReviewService, KbPortalService, KbFieldService],
  // CD-261 — the Portal's public routes (support module) read through KbPortalService
  exports: [KbService, KbReviewService, KbPortalService],
})
export class KbModule {}
