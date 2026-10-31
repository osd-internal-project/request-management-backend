import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../pm/config-rules';
import { addressProblems } from '../webhook/webhook-rules';
import type { AgentAction } from './agent-actions';
import { OutboundConnectionRepository } from './outbound-connection.repository';

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

/** One agent: its URL, sealed key and endpoint id. */
interface ConnectionRow {
  action: string | null;
  baseUrl: string;
  secretEnc: string;
  endpointId: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: number | null;
  ms: number;
  problem: string | null;
}

/**
 * ประตูเดียวที่ core ออกไปหา Vuvagent — ส่งงานแล้วจบ. ที่ Vuvagent หนึ่งงานคือหนึ่ง
 * agent: URL, key และ endpoint id มาจากแถว `outbound_connections` ของบริษัทสำหรับ
 * งานนั้น (แท็บ "การเชื่อมต่อที่เราเรียก" หน้า Integrations):
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
    private readonly connections: OutboundConnectionRepository,
    private readonly config: ConfigService,
  ) {}

  async dispatch(
    companyId: string,
    action: AgentAction,
    body: { agent_record_id: string } & Record<string, unknown>,
  ): Promise<void> {
    const connection = (await this.connections.findFirst({
      where: { companyId, action, active: true },
      select: { action: true, baseUrl: true, secretEnc: true, endpointId: true },
    })) as ConnectionRow | null;
    if (!connection) {
      throw new VuvagentDispatchError(
        null,
        `ยังไม่ได้ตั้งการเชื่อมต่อของงาน ${action} ที่หน้า Integrations`,
      );
    }
    const response = await this.post(connection, body);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new VuvagentDispatchError(
        response.status,
        `HTTP ${response.status} ${detail}`.trim().slice(0, 300),
      );
    }
  }

  /**
   * One real call with `connection_test: true`. Vuvagent has no health route,
   * so the playbook should end early on that flag; 401/403 means the key is wrong.
   */
  async test(connection: ConnectionRow): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const response = await this.post(connection, {
        agent_record_id: null,
        connection_test: true,
      });
      return {
        ok: response.ok,
        status: response.status,
        ms: Date.now() - started,
        problem: response.ok
          ? null
          : response.status === 401 || response.status === 403
            ? 'Vuvagent ไม่รับ key นี้'
            : `HTTP ${response.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        status:
          error instanceof VuvagentDispatchError ? error.statusCode : null,
        ms: Date.now() - started,
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async post(
    connection: ConnectionRow,
    body: Record<string, unknown>,
  ): Promise<Response> {
    if (!connection.endpointId) {
      throw new VuvagentDispatchError(
        null,
        `ยังไม่ได้ตั้ง endpoint ของงาน ${connection.action ?? ''} ที่หน้า Integrations`,
      );
    }

    const apiKey = openSecret(connection.secretEnc, this.sealKey());
    if (apiKey === null) {
      throw new VuvagentDispatchError(
        null,
        'ถอดรหัส x-api-key ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ให้ใส่ key ใหม่ที่หน้า Integrations',
      );
    }

    const url = `${connection.baseUrl.replace(/\/$/, '')}/v1/endpoints/${encodeURIComponent(connection.endpointId)}`;
    // checked again at call time: a name that later points inside is refused here
    const problems = await addressProblems(
      url,
      this.config.get<string[]>('webhook.privateHosts') ?? [],
    );
    if (problems.length) {
      throw new VuvagentDispatchError(null, problems.join(', '));
    }

    return fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(body),
    }).catch((cause: unknown) => {
      throw new VuvagentDispatchError(null, String(cause));
    });
  }

  private sealKey(): string {
    const key = this.config.get<string>('projectConfig.secret');
    if (!key)
      throw new VuvagentDispatchError(null, 'CONFIG_SECRET_KEY is not set');
    return key;
  }
}
