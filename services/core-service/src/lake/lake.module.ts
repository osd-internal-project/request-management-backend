import { Module } from '@nestjs/common';
import { ErpModule } from '../erp/erp.module';
import { DataLakeService } from './data-lake.service';
import { LakeController } from './lake.controller';
import { LakeRepository } from './lake.repository';

/**
 * CD-90 — the pipe from the application into the Data Lake. Screens only
 * (core-service); external-service never imports it, and its intervals are
 * 0 there regardless.
 */
@Module({
  imports: [ErpModule],
  controllers: [LakeController],
  providers: [DataLakeService, LakeRepository],
})
export class LakeModule {}
