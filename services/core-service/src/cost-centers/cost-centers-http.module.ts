import { Module } from '@nestjs/common';
import { CostCentersController } from './cost-centers.controller';
import { CostCentersModule } from './cost-centers.module';

/** The screen-facing routes of {@link CostCentersModule}. */
@Module({
  imports: [CostCentersModule],
  controllers: [CostCentersController],
})
export class CostCentersHttpModule {}
