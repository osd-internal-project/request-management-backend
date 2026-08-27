import { Module } from '@nestjs/common';
import { PrismaTransactionService } from '@request-management/share';
import { BiAdminController, BiController } from './bi.controller';
import { BiService } from './bi.service';
import { BiDashboardRepository } from './bi-dashboard.repository';

/**
 * CD-92: menu + signed embed URLs for the Metabase dashboards, with the
 * dashboard list and its per-team visibility administered in-app (v2).
 */
@Module({
  controllers: [BiController, BiAdminController],
  providers: [BiService, BiDashboardRepository, PrismaTransactionService],
})
export class BiModule {}
