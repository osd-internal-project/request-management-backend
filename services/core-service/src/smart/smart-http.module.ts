import { Module } from '@nestjs/common';
import { SmartController } from './smart.controller';
import { SmartModule } from './smart.module';

/** The screen-facing routes of {@link SmartModule}. */
@Module({
  imports: [SmartModule],
  controllers: [SmartController],
})
export class SmartHttpModule {}
