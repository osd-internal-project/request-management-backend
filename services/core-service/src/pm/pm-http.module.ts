import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { PmModule } from './pm.module';
import { DeliveryDocsState } from '../delivery/delivery-docs.state';
import {
  ProjectsController,
  ProjectPortfolioController,
  ProjectReleasesController,
  ProjectConfigsController,
  ProjectWorkloadController,
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
import { IntakeService } from './intake.service';
import { SalesHandoverRepository } from '../crm/handover.repositories';
import { AsBuiltService } from './as-built.service';
import { AcceptanceService } from './acceptance.service';
import { UatService } from './uat.service';
import { InstallationsService } from './installations.service';
import { SurveysService } from './surveys.service';
import { DevPlanService } from './dev-plan.service';
import { DefectsService } from './defects.service';
import { ReleasesService } from './releases.service';
import { SoftwareDocsService } from './software-docs.service';
import { ConfigsService } from './configs.service';
import { IntegrationsService } from './integrations.service';
import { TechChangesService } from './tech-changes.service';
import { ProjectCostsService } from './project-costs.service';
import { ResourcesService } from './resources.service';
import { ErpModule } from '../erp/erp.module';
import { HrModule } from '../hr/hr.module';
import { SupportModule } from '../support/support.module';
import { CompanyRepository } from '../crm/product.repositories';
import { TaskEvidenceService } from './task-evidence.service';
import { DesignsService } from './designs.service';
import { TechPlanService } from './tech-plan.service';

/** The screen-facing routes of {@link PmModule}. */
@Module({
  imports: [
    PmModule,
    // CD-190 — actual costs: the ERP and approved timesheets
    ErpModule,
    HrModule,
    // CD-236 — acceptance fills the installed base
    SupportModule,
    // CD-182 milestone evidence — storage for the HTTP half only
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  // CD-254 — Delivery confirms installation against the readiness check
  exports: [ReadinessService],
  controllers: [
    ProjectsController,
    ProjectTasksController,
    ProjectRisksController,
    ProjectPortfolioController,
    ProjectReleasesController,
    ProjectConfigsController,
    ProjectWorkloadController,
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
    // CD-251 — the delivery pack, for the readiness check (no module cycle)
    DeliveryDocsState,
    ReadinessService,
    // CD-176 — receiving the work; the CD-84 handover read where it lies
    IntakeService,
    SalesHandoverRepository,
    AsBuiltService,
    AcceptanceService,
    UatService,
    InstallationsService,
    SurveysService,
    DevPlanService,
    DefectsService,
    ReleasesService,
    SoftwareDocsService,
    ConfigsService,
    IntegrationsService,
    TechChangesService,
    ProjectCostsService,
    ResourcesService,
    CompanyRepository,
    TaskEvidenceService,
    DesignsService,
    TechPlanService,
  ],
})
export class PmHttpModule {}
