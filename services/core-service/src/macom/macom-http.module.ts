import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { CrmModule } from '../crm/crm.module';
import { CampaignReceiptsService } from './campaign-receipts.service';
import { ContentFilesService } from './content-files.service';
import { BrandFilesService } from './brand-files.service';
import { MacomController } from './macom.controller';
import { MacomModule } from './macom.module';

/** The screen-facing routes of {@link MacomModule}. */
@Module({
  imports: [
    MacomModule,
    CrmModule,
    // CD-268 receipts — storage for the HTTP half only
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [MacomController],
  providers: [CampaignReceiptsService, ContentFilesService, BrandFilesService],
})
export class MacomHttpModule {}
