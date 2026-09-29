import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { BiAdminController, BiController } from './bi.controller';
import { BiService } from './bi.service';
import { BiDashboardRepository } from './bi-dashboard.repository';
import { DataMartRepository } from './data-mart.repository';
import { DataMartService } from './data-mart.service';

/**
 * CD-92: menu + signed embed URLs for the Metabase dashboards, with the
 * dashboard list and its per-team visibility administered in-app (v2).
 * CD-91: the Data Mart those dashboards read, rebuilt hourly.
 */
@Module({
  controllers: [BiController, BiAdminController],
  providers: [
    BiService,
    BiDashboardRepository,
    DataMartService,
    DataMartRepository,
    PrismaTransactionService,
  ],
})
export class BiModule {}
