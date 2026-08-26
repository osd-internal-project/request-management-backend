import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import {
  RequestsController,
  RequestTypeAdminController,
} from './requests.controller';
import { RequestsService } from './requests.service';
import { RequestRepository } from './request.repository';
import { RequestTypeRepository } from './request-type.repository';
import { DocNumberService } from './doc-number.service';
import { ApprovalsModule } from '../approvals/approvals.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SlaModule } from '../sla/sla.module';

/** S3 — Platform Request (§16 หน้าที่ 2–4, A2). */
@Module({
  imports: [ApprovalsModule, NotificationsModule, SlaModule],
  controllers: [RequestsController, RequestTypeAdminController],
  providers: [
    RequestsService,
    RequestRepository,
    RequestTypeRepository,
    DocNumberService,
    PrismaTransactionService,
  ],
  exports: [RequestsService],
})
export class RequestsModule {}
