import { Module } from '@nestjs/common';
import { RunNumberAdminController } from './run-number-admin.controller';
import { RunNumberInternalController } from './run-number-internal.controller';
import { RunNumberModule } from './run-number.module';

@Module({
  imports: [RunNumberModule],
  controllers: [RunNumberAdminController, RunNumberInternalController],
})
export class RunNumberHttpModule {}
