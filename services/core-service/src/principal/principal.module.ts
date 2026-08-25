import { Global, Module } from '@nestjs/common';
import { RemotePrincipalGuard } from './remote-principal.guard';
import { RemotePrincipalService } from './remote-principal.service';

@Global()
@Module({
  providers: [RemotePrincipalService, RemotePrincipalGuard],
  exports: [RemotePrincipalService, RemotePrincipalGuard],
})
export class PrincipalModule {}
