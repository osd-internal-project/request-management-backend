import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { PmModule } from './pm.module';
import {
  ProjectsController,
  ProjectPortfolioController,
  ProjectReleasesController,
  ProjectRisksController,
  ProjectTasksController,
} from './projects.controller';
import { TaskWorkService } from './task-work.service';
import { ProgressService } from './progress.service';
import { BudgetService } from './budget.service';
import { ChangeRequestsService } from './change-requests.service';
import { ProjectRisksService } from './project-risks.service';
import { ProjectIssuesService } from './project-issues.service';
import { CustomerLogsService } from './customer-logs.service';
import { PaymentsService } from './payments.service';
import { CloseoutService } from './closeout.service';
import { StatusReportsService } from './status-reports.service';
import { TestsService } from './tests.service';
import { ReadinessService } from './readiness.service';
import { AsBuiltService } from './as-built.service';
import { AcceptanceService } from './acceptance.service';
import { UatService } from './uat.service';
import { InstallationsService } from './installations.service';
import { SurveysService } from './surveys.service';
import { DevPlanService } from './dev-plan.service';
import { DefectsService } from './defects.service';
import { ReleasesService } from './releases.service';
import { SoftwareDocsService } from './software-docs.service';
import { TaskEvidenceService } from './task-evidence.service';
import { DesignsService } from './designs.service';
import { TechPlanService } from './tech-plan.service';

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
    ProjectPortfolioController,
    ProjectReleasesController,
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
    CustomerLogsService,
    PaymentsService,
    CloseoutService,
    StatusReportsService,
    TestsService,
    ReadinessService,
    AsBuiltService,
    AcceptanceService,
    UatService,
    InstallationsService,
    SurveysService,
    DevPlanService,
    DefectsService,
    ReleasesService,
    SoftwareDocsService,
    TaskEvidenceService,
    DesignsService,
    TechPlanService,
  ],
})
export class PmHttpModule {}
