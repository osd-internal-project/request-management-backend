import { Global, Module } from '@nestjs/common';
import { ApiKeyAdminService } from './api-key-admin.service';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';
import { RemotePrincipalGuard } from './remote-principal.guard';
import { RemotePrincipalService } from './remote-principal.service';
import { ApprovalContextClient } from './approval-context.client';

@Global()
@Module({
  providers: [
    ApiKeyRepository,
    ApiKeyService,
    ApiKeyAdminService,
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
  exports: [
    /* For `PrincipalHttpModule`'s admin controller. */
    ApiKeyAdminService,
    ApiKeyService,
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
})
export class PrincipalModule {}
