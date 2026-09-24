import { Module } from '@nestjs/common';
import { CrmModule } from '../crm/crm.module';
import { ErpSyncAdminController } from './erp-sync-admin.controller';

/**
 * The screen-facing routes of the ERP integration layer — the SAP sync queue
 * admin page. Internal port only, like `PrincipalHttpModule`: nothing here is
 * for an outside system to call.
 */
@Module({
  imports: [CrmModule],
  controllers: [ErpSyncAdminController],
})
export class IntegrationHttpModule {}
