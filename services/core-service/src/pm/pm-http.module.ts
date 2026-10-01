import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { PmModule } from './pm.module';
import {
  ProjectsController,
  ProjectRisksController,
  ProjectTasksController,
} from './projects.controller';
import { TaskWorkService } from './task-work.service';
import { ProgressService } from './progress.service';
import { BudgetService } from './budget.service';
import { ChangeRequestsService } from './change-requests.service';
import { ProjectRisksService } from './project-risks.service';
import { ProjectIssuesService } from './project-issues.service';

/** The screen-facing routes of {@link PmModule}. */
@Module({
  imports: [
    PmModule,
    // CD-182 milestone evidence — storage for the HTTP half only
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [
    ProjectsController,
    ProjectTasksController,
    ProjectRisksController,
  ],
  providers: [
    MilestonesService,
    PlanService,
    TaskWorkService,
    ProgressService,
    BudgetService,
    ChangeRequestsService,
    ProjectRisksService,
    ProjectIssuesService,
  ],
})
export class PmHttpModule {}
