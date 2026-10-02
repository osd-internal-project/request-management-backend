import { Module } from '@nestjs/common';
import { HrModule } from './hr.module';
import { HrController } from './hr.controller';

/** The screen-facing routes of {@link HrModule}. */
@Module({
  imports: [HrModule],
  controllers: [HrController],
})
export class HrHttpModule {}
