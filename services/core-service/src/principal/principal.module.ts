import { Global, Module } from '@nestjs/common';
import { RemotePrincipalGuard } from './remote-principal.guard';
import { RemotePrincipalService } from './remote-principal.service';
import { ApprovalContextClient } from './approval-context.client';

@Global()
@Module({
  providers: [
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
  exports: [
    RemotePrincipalService,
    ApprovalContextClient,
    RemotePrincipalGuard,
  ],
})
export class PrincipalModule {}
