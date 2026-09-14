import { Global, Module } from '@nestjs/common';
import { ApiKeyAdminController } from './api-key-admin.controller';
import { ApiKeyAdminService } from './api-key-admin.service';
import { ApiKeyRepository } from './api-key.repository';
import { ApiKeyService } from './api-key.service';
import { RemotePrincipalGuard } from './remote-principal.guard';
import { RemotePrincipalService } from './remote-principal.service';
import { ApprovalContextClient } from './approval-context.client';

@Global()
@Module({
  controllers: [ApiKeyAdminController],
  providers: [
    ApiKeyRepository,
    ApiKeyService,
    ApiKeyAdminService,
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
  exports: [
    ApiKeyService,
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
})
export class PrincipalModule {}
