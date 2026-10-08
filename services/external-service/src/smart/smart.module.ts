import { Module } from '@nestjs/common';
import { SmartModule as CoreSmartModule } from '@request-management/core-service';
import { ExternalSmartIngestController } from './smart-ingest.controller';
import { ExternalSmartCallbackController } from './smart-callback.controller';

/** `api/v1/smart/*` — a vendor pushes swept leads (CD-289). */
@Module({
  imports: [CoreSmartModule],
  controllers: [ExternalSmartIngestController, ExternalSmartCallbackController],
})
export class SmartApiModule {}
