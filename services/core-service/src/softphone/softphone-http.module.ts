import { Module } from '@nestjs/common';
import { CareContactLookupRepository } from '../care/care.repositories';
import { RequestsModule } from '../requests/requests.module';
import { SoftphoneController } from './softphone.controller';
import { SoftphoneExtensionRepository } from './softphone.repository';
import { SoftphoneService } from './softphone.service';

/** The D-Callcenter softphone: per-user SIP lines and the call log. */
@Module({
  imports: [RequestsModule],
  controllers: [SoftphoneController],
  providers: [
    SoftphoneExtensionRepository,
    CareContactLookupRepository,
    SoftphoneService,
  ],
})
export class SoftphoneHttpModule {}
