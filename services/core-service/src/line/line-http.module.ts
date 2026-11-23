import { Module } from '@nestjs/common';
import { LineLinkController } from './line-link.controller';
import { LineModule } from './line.module';
import { LineSettingsController } from './line-settings.controller';

@Module({
  imports: [LineModule],
  controllers: [LineLinkController, LineSettingsController],
})
export class LineHttpModule {}
