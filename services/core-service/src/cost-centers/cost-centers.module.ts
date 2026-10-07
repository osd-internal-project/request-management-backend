import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { RequestsModule } from '../requests/requests.module';
import { CostCenterRepository } from './cost-center.repository';
import { CostCentersService } from './cost-centers.service';

/** Cost Center master; registers `cost_centers` as a form option source. */
@Module({
  imports: [RequestsModule],
  providers: [CostCentersService, CostCenterRepository, PrismaTransactionService],
  exports: [CostCentersService],
})
export class CostCentersModule {}
