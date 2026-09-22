import { Module } from '@nestjs/common';
import {
  RunNumberCounterRepository,
  RunNumberSettingRepository,
} from './run-number.repository';
import { RunNumberService } from './run-number.service';
import { RunNumberSettingsService } from './run-number-settings.service';

/** providers เท่านั้น — controller อยู่ใน `RunNumberHttpModule` ตามกฎของ repo. */
@Module({
  providers: [
    RunNumberSettingRepository,
    RunNumberCounterRepository,
    RunNumberService,
    RunNumberSettingsService,
  ],
  exports: [RunNumberService, RunNumberSettingsService],
})
export class RunNumberModule {}
