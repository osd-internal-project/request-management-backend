import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { NotificationsModule } from '../notifications/notifications.module';
import { PmModule } from '../pm/pm.module';
import { PresalesModule } from '../presales/presales.module';
import { KbAiModule } from './kb-ai.module';
import { KbController } from './kb.controller';
import { KbFieldService } from './kb-field.service';
import { KbLessonService } from './kb-lesson.service';
import { KbArticleRepository, KbCandidateRepository } from './kb.repositories';
import { KbPresalesService } from './kb-presales.service';
import { KbPortalService } from './kb-portal.service';
import { KbReviewService } from './kb-review.service';
import { KbService } from './kb.service';

/** CD-22 KBMS — คลังความรู้ (images and files of articles live in MinIO). */
@Module({
  imports: [
    // CD-265 — the AI log for knowledge owners
    KbAiModule,
    // CD-260 — review notices and the kb.review rule
    NotificationsModule,
    // CD-263 — project lessons, projects and their budgets
    PmModule,
    // CD-264 — Solutions and their answered questions
    PresalesModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [KbController],
  providers: [
    KbService,
    KbReviewService,
    KbPortalService,
    KbFieldService,
    KbLessonService,
    KbArticleRepository,
    KbCandidateRepository,
    KbPresalesService,
  ],
  // CD-261 — the Portal's public routes (support module) read through KbPortalService
  exports: [KbService, KbReviewService, KbPortalService],
})
export class KbModule {}
