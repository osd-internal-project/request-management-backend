import { Module } from '@nestjs/common';
import { ServiceAssetsController } from './support.controller';
import { SupportModule } from './support.module';

/** The screen-facing routes of {@link SupportModule}. */
@Module({
  imports: [SupportModule],
  controllers: [ServiceAssetsController],
})
export class SupportHttpModule {}
