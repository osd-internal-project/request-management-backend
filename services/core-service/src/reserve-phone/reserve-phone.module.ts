import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockReservePhoneClient } from './mock-reserve-phone.client';
import { RESERVE_PHONE_CLIENT } from './reserve-phone-client';

/**
 * CD-78 — the doorway to Reserve-phone. Pure client, no database, so the CRM
 * module imports it without a cycle; the reservations of a deal live with the
 * deal (crm/phone-reservations.service.ts).
 */
@Module({
  providers: [
    MockReservePhoneClient,
    {
      provide: RESERVE_PHONE_CLIENT,
      inject: [ConfigService, MockReservePhoneClient],
      useFactory: (config: ConfigService, mock: MockReservePhoneClient) => {
        const mode = config.get<string>('reservePhone.mode') ?? 'mock';
        if (mode === 'mock') return mock;
        // Fail at boot, loudly — see reserve-phone-client.ts.
        throw new Error(
          `RESERVE_PHONE_MODE=${mode} — ยังไม่มีตัวเชื่อม Reserve-phone ตัวจริง (ใช้ mock ไปก่อน, docs/reserve-phone.md)`,
        );
      },
    },
  ],
  exports: [RESERVE_PHONE_CLIENT],
})
export class ReservePhoneModule {}
