import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PrismaTransactionService,
  StorageModule,
  type StorageOptions,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { EventsModule } from '../events/events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EsignLayoutsService } from './esign-layouts.service';
import { ESIGN_SENDER, MockEsignSender } from './esign-sender';
import { EsignService } from './esign.service';
import {
  EsignEnvelopeRepository,
  EsignEventRepository,
  EsignLayoutRepository,
  EsignSignerRepository,
} from './esign.repositories';

/**
 * CD-14 ระบบลงนามอิเล็กทรอนิกส์ — the central signing service. It stores
 * PDFs, so it brings its own storage; only core-service imports it (the
 * public signing routes are core-service's, see `EsignPublicController`).
 */
@Module({
  imports: [
    EventsModule,
    NotificationsModule,
    StorageModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<StorageOptions>('storage'),
    }),
  ],
  providers: [
    EsignLayoutRepository,
    EsignEnvelopeRepository,
    EsignSignerRepository,
    EsignEventRepository,
    EsignLayoutsService,
    EsignService,
    CompanyMemberRepository,
    PrismaTransactionService,
    { provide: ESIGN_SENDER, useClass: MockEsignSender },
  ],
  exports: [EsignService, EsignLayoutsService],
})
export class EsignModule {}
