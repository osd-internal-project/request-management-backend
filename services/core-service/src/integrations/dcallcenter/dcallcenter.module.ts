import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import {
  DCALLCENTER_CLIENT,
  type DCallcenterClient,
} from './dcallcenter-client';
import { MockDCallcenterClient } from './mock-dcallcenter.client';

/** A call centre that is switched off: dialling refuses, plainly. */
const OFF: DCallcenterClient = {
  mode: 'off',
  placeCall: () =>
    Promise.reject(
      new AppError(
        'CONFLICT',
        'ยังไม่ได้เชื่อม D-Callcenter (DCALLCENTER_MODE=off)',
      ),
    ),
};

/**
 * CD-292 — D-Callcenter, shared by AI SMART (outbound) and AI CARE (CD-287).
 * `DCALLCENTER_MODE=mock` (default) | `off`.
 */
@Module({
  providers: [
    MockDCallcenterClient,
    {
      provide: DCALLCENTER_CLIENT,
      inject: [ConfigService, MockDCallcenterClient],
      useFactory: (config: ConfigService, mock: MockDCallcenterClient) => {
        const mode = config.get<string>('dcallcenter.mode') ?? 'mock';
        if (mode === 'mock') return mock;
        if (mode === 'off') return OFF;
        throw new Error(
          `DCALLCENTER_MODE=${mode} ไม่รู้จัก — ใช้ mock หรือ off (ตัวเชื่อมจริงรอสเปก D-Callcenter)`,
        );
      },
    },
  ],
  exports: [DCALLCENTER_CLIENT],
})
export class DCallcenterModule {}
