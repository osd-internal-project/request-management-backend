import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageModule, type StorageOptions } from '@request-management/share';
import { PmModule } from '../pm/pm.module';
import { DeliveryModule } from './delivery.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryDocsService } from './delivery-docs.service';

/** The screen-facing routes of {@link DeliveryModule}. */
@Module({
  imports: [
    DeliveryModule,
    // CD-251 — milestones of the project
    PmModule,
    // CD-251 delivery documents — storage for the HTTP half only
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  controllers: [DeliveryController],
  providers: [DeliveryDocsService],
})
export class DeliveryHttpModule {}
