import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ERP_CLIENT } from './erp-client';
import { MockSapClient } from './mock-sap.client';

/**
 * The integration layer's doorway to the ERP (SAP, D-30). Pure client — no
 * database access here, so feature modules can import it without a
 * dependency cycle; the queue and the customer-shaped orchestration live with
 * the data they touch (crm/customer-erp-sync.service.ts).
 */
@Module({
  providers: [
    MockSapClient,
    {
      provide: ERP_CLIENT,
      inject: [ConfigService, MockSapClient],
      useFactory: (config: ConfigService, mock: MockSapClient) => {
        const mode = config.get<string>('erp.mode') ?? 'mock';
        // Fail at boot, loudly: a silently-mocked production would show fake
        // BP numbers and receivables as if they came from SAP.
        if (mode !== 'mock') {
          throw new Error(
            `ERP_MODE=${mode} ยังไม่รองรับ — driver SAP จริงรอสรุปวิธีเชื่อม (OData/BAPI); ใช้ ERP_MODE=mock ไปก่อน`,
          );
        }
        return mock;
      },
    },
  ],
  exports: [ERP_CLIENT],
})
export class ErpModule {}
