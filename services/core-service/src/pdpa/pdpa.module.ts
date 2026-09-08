import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PDPA_CLIENT } from './pdpa-client';
import { MockPdpaClient } from './mock-pdpa.client';
import { HttpPdpaClient } from './http-pdpa.client';

/** CM-05/D-35 — pure client, no database; feature modules import freely. */
@Module({
  providers: [
    MockPdpaClient,
    HttpPdpaClient,
    {
      provide: PDPA_CLIENT,
      inject: [ConfigService, MockPdpaClient, HttpPdpaClient],
      useFactory: (
        config: ConfigService,
        mock: MockPdpaClient,
        http: HttpPdpaClient,
      ) => (config.get<string>('pdpa.mode') === 'http' ? http : mock),
    },
  ],
  exports: [PDPA_CLIENT],
})
export class PdpaModule {}
