import { Module } from '@nestjs/common';
import { ProcessFlowLogRepository } from './process-log.repository';
import { ProcessLogService } from './process-log.service';

/** End-to-End process log — domain half, shared by core and external. */
@Module({
  providers: [ProcessFlowLogRepository, ProcessLogService],
  exports: [ProcessLogService],
})
export class ProcessLogModule {}
