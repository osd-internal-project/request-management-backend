import { Global, Module } from '@nestjs/common';
import { ApiKeyAdminService } from './api-key-admin.service';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';
import { RemotePrincipalGuard } from './remote-principal.guard';
import { RemotePrincipalService } from './remote-principal.service';
import { ApprovalContextClient } from './approval-context.client';
import { IntegrationAdminService } from './integration-admin.service';
import { IntegrationRepository } from './integration.repository';
import { IntegrationCallRepository } from './integration-call.repository';
import { IntegrationCallLogService } from './integration-call-log.service';
import { CompanyRepository } from '../crm/product.repositories';

@Global()
@Module({
  providers: [
    ApiKeyRepository,
    ApiKeyService,
    ApiKeyAdminService,
    IntegrationRepository,
    IntegrationAdminService,
    IntegrationCallRepository,
    IntegrationCallLogService,
    CompanyRepository,
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
  exports: [
    /* For `PrincipalHttpModule`'s admin controller. */
    ApiKeyAdminService,
    /* webhook admin ผูก webhook เข้ากับ integration ของบริษัทเดียวกัน */
    IntegrationAdminService,
    /* external-service เขียน log, AiAuditService ลบตาม retention */
    IntegrationCallRepository,
    IntegrationCallLogService,
    ApiKeyService,
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
})
export class PrincipalModule {}
