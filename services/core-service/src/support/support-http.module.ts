import { Module } from '@nestjs/common';
import {
  ServiceAssetsController,
  ServiceEntitlementsController,
} from './support.controller';
import { SupportModule } from './support.module';

/** The screen-facing routes of {@link SupportModule}. */
@Module({
  imports: [SupportModule],
  controllers: [ServiceAssetsController, ServiceEntitlementsController],
})
export class SupportHttpModule {}
