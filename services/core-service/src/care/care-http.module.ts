import { Module } from '@nestjs/common';
import { CareController } from './care.controller';
import { CareModule } from './care.module';

/** The screen-facing routes of {@link CareModule}. */
@Module({
  imports: [CareModule],
  controllers: [CareController],
})
export class CareHttpModule {}
