import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../pm/config-rules';
import { addressProblems } from '../webhook/webhook-rules';
import type { AgentAction } from './agent-actions';
import { IntegrationEndpointRepository } from './integration-endpoint.repository';

/** Vuvagent only queues the run; a call that hangs is a call that failed. */
const DISPATCH_TIMEOUT_MS = 15_000;

/** A dispatch Vuvagent refused (`statusCode`) or that never reached it (null). */
export class VuvagentDispatchError extends Error {
  constructor(
    readonly statusCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'VuvagentDispatchError';
  }
}

interface EndpointRow {
  baseUrl: string;
  endpointId: string;
  apiKeyEnc: string;
}

/**
 * ประตูเดียวที่ core ออกไปหา Vuvagent — ส่งงานแล้วจบ. ปลายทางมาจากแถว
 * `integration_endpoints` ของบริษัท (แท็บ "Endpoint ที่เราเรียก" หน้า Integrations):
 *
 * ```
 * POST {baseUrl}/v1/endpoints/{endpointId}
 *   x-api-key: sk-aily-…
 *   {"agent_record_id": "…", "topic": "…"}
 * → 202 {"sessionId": "…"}
 * ```
 *
 * Vuvagent ปิดงานเองผ่าน `PATCH agent-records/:id` บน external API.
 */
@Injectable()
export class VuvagentClient {
  constructor(
    private readonly endpoints: IntegrationEndpointRepository,
    private readonly config: ConfigService,
  ) {}

  async dispatch(
    companyId: string,
    action: AgentAction,
    body: { agent_record_id: string } & Record<string, unknown>,
  ): Promise<void> {
    const endpoint = (await this.endpoints.findFirst({
      where: { companyId, action, active: true },
      select: { baseUrl: true, endpointId: true, apiKeyEnc: true },
    })) as EndpointRow | null;
    if (!endpoint) {
      throw new VuvagentDispatchError(
        null,
        `ยังไม่ได้ตั้ง endpoint ของ ${action} ที่หน้า Integrations`,
      );
    }

    const apiKey = openSecret(endpoint.apiKeyEnc, this.sealKey());
    if (apiKey === null) {
      throw new VuvagentDispatchError(
        null,
        'ถอดรหัส x-api-key ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ให้ใส่ key ใหม่ที่หน้า Integrations',
      );
    }

    const url = `${endpoint.baseUrl.replace(/\/$/, '')}/v1/endpoints/${encodeURIComponent(endpoint.endpointId)}`;
    // checked again at call time: a name that later points inside is refused here
    const problems = await addressProblems(
      url,
      this.config.get<string[]>('webhook.privateHosts') ?? [],
    );
    if (problems.length) {
      throw new VuvagentDispatchError(null, problems.join(', '));
    }

    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    }).catch((cause: unknown) => {
      throw new VuvagentDispatchError(null, String(cause));
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new VuvagentDispatchError(
        response.status,
        `HTTP ${response.status} ${detail}`.trim().slice(0, 300),
      );
    }
  }

  private sealKey(): string {
    const key = this.config.get<string>('projectConfig.secret');
    if (!key)
      throw new VuvagentDispatchError(null, 'CONFIG_SECRET_KEY is not set');
    return key;
  }
}
