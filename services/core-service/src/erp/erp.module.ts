import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERP_CLIENT } from './erp-client';
import { MockSapClient } from './mock-sap.client';
import { SapB1Client } from './sap-b1.client';
import type { SapB1Settings } from './sap-b1.client';
import { B1_TRANSPORT, HttpsB1Transport } from './sap-b1.transport';

/**
 * The integration layer's doorway to the ERP (SAP B1, D-30). Pure client — no
 * database access here, so feature modules can import it without a
 * dependency cycle; the queue and the customer-shaped orchestration live with
 * the data they touch (crm/customer-erp-sync.service.ts).
 */
@Module({
  providers: [
    MockSapClient,
    { provide: B1_TRANSPORT, useClass: HttpsB1Transport },
    SapB1Client,
    {
      provide: ERP_CLIENT,
      inject: [ConfigService, MockSapClient, SapB1Client],
      useFactory: (
        config: ConfigService,
        mock: MockSapClient,
        b1: SapB1Client,
      ) => {
        const mode = config.get<string>('erp.mode') ?? 'mock';
        if (mode === 'mock') return mock;
        if (mode === 'sapb1') {
          // Fail at boot, loudly: half a B1 config would fail every sync
          // quietly into the retry queue instead.
          const missing = SapB1Client.missingSettings(
            config.get<SapB1Settings>('erp.b1'),
          );
          if (missing.length) {
            throw new Error(
              `ERP_MODE=sapb1 แต่ยังไม่ได้ตั้ง ${missing.join(', ')}`,
            );
          }
          return b1;
        }
        throw new Error(`ERP_MODE=${mode} ไม่รู้จัก — ใช้ mock หรือ sapb1`);
      },
    },
  ],
  exports: [ERP_CLIENT],
})
export class ErpModule {}
