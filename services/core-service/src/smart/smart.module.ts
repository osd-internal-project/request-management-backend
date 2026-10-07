import { Module } from '@nestjs/common';
import { ContactPreferencesModule } from '../contact-preferences/contact-preferences.module';
import { CrmModule } from '../crm/crm.module';
import { CompanyRepository } from '../crm/product.repositories';
import { KbArticleRepository } from '../kb/kb.repositories';
import { WorkCalendarRepository } from '../pm/project.repositories';
import { SmartCallsService } from './smart-calls.service';
import { DCallcenterModule } from '../integrations/dcallcenter/dcallcenter.module';
import { SmartDialerService } from './smart-dialer.service';
import { SmartHandoffService } from './smart-handoff.service';
import { AccessModule } from '../access/access.module';
import { RequestsModule } from '../requests/requests.module';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { LeadRepository } from '../crm/sales.repositories';
import { LlmModule } from '../llm/llm.module';
import { SmartScreeningService } from './smart-screening.service';
import { ConfigService } from '@nestjs/config';
import { MockSmartConnector, SMART_CONNECTORS } from './smart-connector';
import { SmartIngestService } from './smart-ingest.service';
import { CONNECTOR_KINDS } from './smart-rules';
import { SmartSweepService } from './smart-sweep.service';
import {
  SmartCallListRepository,
  SmartCallRepository,
  SmartCallPolicyRepository,
  SmartCallTargetRepository,
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
  // CD-290 — screening matches CRM and sends through the campaign screening
  imports: [
    CrmModule,
    LlmModule,
    ContactPreferencesModule,
    DCallcenterModule,
    // CD-293 — the handoff request, and who raises it
    RequestsModule,
    AccessModule,
  ],
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
    SmartScreeningService,
    LeadRepository,
    // CD-291 — call lists and the checks before every call
    SmartCallPolicyRepository,
    SmartCallListRepository,
    SmartCallTargetRepository,
    SmartCallsService,
    KbArticleRepository,
    CompanyRepository,
    WorkCalendarRepository,
    // CD-292 — dialling through D-Callcenter
    SmartCallRepository,
    SmartDialerService,
    // CD-293 — to the sales axis
    SmartHandoffService,
    CrmConfigRepository,
  ],
  exports: [
    SmartHandoffService,
    SmartDialerService,
    SmartCallsService,
    SmartScreeningService,
    SmartIngestService,
    SmartService,
    SmartProspectRepository,
    SmartSourceRepository,
  ],
})
export class SmartModule {}
