import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockSmartConnector, SMART_CONNECTORS } from './smart-connector';
import { SmartIngestService } from './smart-ingest.service';
import { CONNECTOR_KINDS } from './smart-rules';
import { SmartSweepService } from './smart-sweep.service';
import {
  SmartProspectRepository,
  SmartSourceRepository,
  SmartSweepRunRepository,
} from './smart.repositories';
import { SmartService } from './smart.service';

/**
 * CD-16 AI SMART — outside leads swept into a staging list (CD-289).
 * `SMART_CONNECTOR_MODE=mock` (default) answers every connector kind with
 * made-up rows; `off` has none, so only pushed and imported sources work.
 * Real connectors join the map as providers are contracted.
 */
@Module({
  providers: [
    {
      provide: SMART_CONNECTORS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const mode = config.get<string>('smart.connectorMode') ?? 'mock';
        if (mode === 'off') return new Map();
        if (mode !== 'mock') {
          throw new Error(
            `SMART_CONNECTOR_MODE=${mode} ไม่รู้จัก — ใช้ mock หรือ off`,
          );
        }
        return new Map(
          CONNECTOR_KINDS.map((kind) => [kind, new MockSmartConnector(kind)]),
        );
      },
    },
    SmartSourceRepository,
    SmartSweepRunRepository,
    SmartProspectRepository,
    SmartIngestService,
    SmartSweepService,
    SmartService,
  ],
  exports: [
    SmartIngestService,
    SmartService,
    SmartProspectRepository,
    SmartSourceRepository,
  ],
})
export class SmartModule {}
