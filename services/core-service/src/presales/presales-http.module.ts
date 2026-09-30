import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { PresalesModule } from './presales.module';
import { SolutionsController } from './solutions.controller';
import { SolutionsService } from './solutions.service';
import { RequirementsService } from './requirements.service';
import { SolutionApprovalService } from './solution-approval.service';
import { ClarificationsService } from './clarifications.service';
import { RisksService } from './risks.service';
import { DemosService } from './demos.service';
import { TorService } from './tor.service';

/** The screen-facing routes of {@link PresalesModule} (see `src/index.ts`). */
@Module({
  imports: [
    PresalesModule,
    // Design files — storage for the HTTP half only, like CD-75's photos.
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [SolutionsController],
  providers: [
    SolutionsService,
    RequirementsService,
    SolutionApprovalService,
    ClarificationsService,
    RisksService,
    DemosService,
    TorService,
  ],
})
export class PresalesHttpModule {}
