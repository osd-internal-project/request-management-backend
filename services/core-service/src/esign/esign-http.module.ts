import { Module } from '@nestjs/common';
import { EsignController, EsignPublicController } from './esign.controller';
import { EsignModule } from './esign.module';

/** The routes of {@link EsignModule} — core-service only. */
@Module({
  imports: [EsignModule],
  controllers: [EsignController, EsignPublicController],
})
export class EsignHttpModule {}
