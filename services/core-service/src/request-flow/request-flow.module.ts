import { Module } from '@nestjs/common';
import { RequestFlowRepository } from './request-flow.repository';
import { RequestFlowService } from './request-flow.service';

/** Request step flows — imported by both requests and approvals, depends on neither. */
@Module({
  providers: [RequestFlowRepository, RequestFlowService],
  exports: [RequestFlowRepository, RequestFlowService],
})
export class RequestFlowModule {}
