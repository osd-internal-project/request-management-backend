import { Module } from '@nestjs/common';
import { FormBindingRegistry } from './form-binding.registry';
import { FormOptionSources } from './form-option-sources';
import { PrismaTransactionService } from '@request-management/share';
import { RequestsService } from './requests.service';
import { RequestFlowAdminService } from './request-flow-admin.service';
import { BottleneckService } from '../reports/bottleneck.service';
import { SlaComplianceService } from '../reports/sla-compliance.service';
import { RequestRepository } from './request.repository';
import { AttachmentRepository } from './attachment.repository';
import { RequestTypeRepository } from './request-type.repository';
import { RequestCommentRepository } from './request-comment.repository';
import { RunNumberClientModule } from '../run-number/run-number-client.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SlaModule } from '../sla/sla.module';
import { AccessModule } from '../access/access.module';
import { RequestFlowModule } from '../request-flow/request-flow.module';

/** S3 — Platform Request (§16 หน้าที่ 2–4, A2). */
@Module({
  imports: [
    RunNumberClientModule,
    AccessModule,
    ApprovalsModule,
    NotificationsModule,
    SlaModule,
    RequestFlowModule,
  ],
  providers: [
    RequestsService,
    RequestFlowAdminService,
    FormBindingRegistry,
    FormOptionSources,
    BottleneckService,
    SlaComplianceService,
    RequestRepository,
    AttachmentRepository,
    RequestTypeRepository,
    RequestCommentRepository,
    PrismaTransactionService,
  ],
  /*
    `RequestRepository` is exported alongside the service for the external
    API's one need the service cannot meet: turning a document number into an
    id. A chatbot is handed `REQ-OSD-PS01-26090001` by a person, never a uuid.
  */
  exports: [
    RequestsService,
    FormBindingRegistry,
    FormOptionSources,
    RequestFlowAdminService,
    RequestRepository,
    BottleneckService,
    SlaComplianceService,
  ],
})
export class RequestsModule {}
