import { Module } from '@nestjs/common';
import { LeadFilesController } from './lead-files.controller';
import { LeadFilesModule } from './lead-files.module';

/** Screens only — external-service imports `LeadFilesModule`, never this. */
@Module({
  imports: [LeadFilesModule],
  controllers: [LeadFilesController],
})
export class LeadFilesHttpModule {}
