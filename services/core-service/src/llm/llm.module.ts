import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GatewayLlmClient,
  type LlmGatewaySettings,
} from './gateway-llm.client';
import { LLM_CLIENT } from './llm-client';
import { MockLlmClient } from './mock-llm.client';
import {
  AiAuditPolicyRepository,
  LlmCallRepository,
  LlmModelPriceRepository,
  LlmTaskSettingRepository,
  McpCallRepository,
} from './llm.repositories';
import { LlmService } from './llm.service';
import { McpCallLogService } from './mcp-call-log.service';

/**
 * CD-275 — the LLM Gateway doorway. `LLM_MODE=mock` (default) needs nothing;
 * `LLM_MODE=gateway` needs the gateway's URL and key, and refuses to boot
 * without them rather than failing every AI call later.
 */
@Module({
  providers: [
    MockLlmClient,
    GatewayLlmClient,
    {
      provide: LLM_CLIENT,
      inject: [ConfigService, MockLlmClient, GatewayLlmClient],
      useFactory: (
        config: ConfigService,
        mock: MockLlmClient,
        gateway: GatewayLlmClient,
      ) => {
        const mode = config.get<string>('llm.mode') ?? 'mock';
        if (mode === 'mock') return mock;
        if (mode === 'gateway') {
          const missing = GatewayLlmClient.missingSettings(
            config.get<LlmGatewaySettings>('llm.gateway'),
          );
          if (missing.length) {
            throw new Error(
              `LLM_MODE=gateway แต่ยังไม่ได้ตั้ง ${missing.join(', ')}`,
            );
          }
          return gateway;
        }
        throw new Error(`LLM_MODE=${mode} ไม่รู้จัก — ใช้ mock หรือ gateway`);
      },
    },
    LlmTaskSettingRepository,
    LlmModelPriceRepository,
    LlmCallRepository,
    LlmService,
    // CD-279 — the AI audit log
    McpCallRepository,
    AiAuditPolicyRepository,
    McpCallLogService,
  ],
  exports: [
    LlmService,
    LlmTaskSettingRepository,
    LlmModelPriceRepository,
    LlmCallRepository,
    McpCallRepository,
    AiAuditPolicyRepository,
    McpCallLogService,
  ],
})
export class LlmModule {}
