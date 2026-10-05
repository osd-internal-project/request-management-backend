import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { NotificationsModule } from '../notifications/notifications.module';
import { KbController } from './kb.controller';
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
  providers: [KbService, KbReviewService],
  exports: [KbService, KbReviewService],
})
export class KbModule {}
