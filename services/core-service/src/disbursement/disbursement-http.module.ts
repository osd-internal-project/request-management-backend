import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { DisbursementFilesController } from './disbursement-files.controller';
import { DisbursementFilesService } from './disbursement-files.service';
import { DisbursementsController } from './disbursement.controller';
import { DisbursementModule } from './disbursement.module';

/** The screen-facing routes of {@link DisbursementModule}; evidence files need storage. */
@Module({
  imports: [
    DisbursementModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  providers: [DisbursementFilesService],
  controllers: [DisbursementsController, DisbursementFilesController],
})
export class DisbursementHttpModule {}
