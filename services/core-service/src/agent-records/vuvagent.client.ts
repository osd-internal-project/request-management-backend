import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../pm/config-rules';
import { addressProblems } from '../webhook/webhook-rules';
import type { AgentAction } from './agent-actions';
import { OutboundConnectionRepository } from './outbound-connection.repository';

/** Vuvagent only queues the run; a call that hangs is a call that failed. */
const DISPATCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export interface DownloadedFile {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

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
  companyId: string;
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
 *   {"agent_record_id": "…", "organization_id": "{companyId}", "topic": "…"}
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
    const connection = await this.connectionOf(companyId, action);
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

  /**
   * A file the agent links to in its answer (the proposal .docx, a link that
   * expires). Only from the connection's own origin, so a callback cannot make
   * CTD fetch an address of its choosing.
   */
  async download(
    companyId: string,
    action: AgentAction,
    url: string,
    maxBytes: number,
  ): Promise<DownloadedFile> {
    const connection = await this.connectionOf(companyId, action);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new VuvagentDispatchError(null, `ลิงก์ไฟล์ไม่ถูกต้อง: ${url}`);
    }
    if (target.origin !== new URL(connection.baseUrl).origin) {
      throw new VuvagentDispatchError(
        null,
        `ลิงก์ไฟล์ไม่ได้อยู่ที่ ${connection.baseUrl}`,
      );
    }
    const problems = await addressProblems(
      target.href,
      this.config.get<string[]>('webhook.privateHosts') ?? [],
    );
    if (problems.length) {
      throw new VuvagentDispatchError(null, problems.join(', '));
    }

    const response = await fetch(target, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    }).catch((cause: unknown) => {
      throw new VuvagentDispatchError(null, String(cause));
    });
    if (!response.ok) {
      throw new VuvagentDispatchError(
        response.status,
        `ดาวน์โหลดไฟล์ไม่ได้: HTTP ${response.status}`,
      );
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      throw new VuvagentDispatchError(null, 'ไฟล์ใหญ่เกินที่รับได้');
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new VuvagentDispatchError(null, 'ไฟล์ใหญ่เกินที่รับได้');
    }

    const type = response.headers.get('content-type')?.split(';')[0].trim();
    return {
      fileName:
        /filename="?([^";]+)"?/i.exec(
          response.headers.get('content-disposition') ?? '',
        )?.[1] ?? 'proposal.docx',
      // Vuvagent's links only ever carry a .docx; a generic type means that
      mimeType:
        !type || type === 'application/octet-stream' ? DOCX_MIME : type,
      buffer,
    };
  }

  private async connectionOf(
    companyId: string,
    action: AgentAction,
  ): Promise<ConnectionRow> {
    const connection = (await this.connections.findFirst({
      where: { companyId, action, active: true },
      select: {
        companyId: true,
        action: true,
        baseUrl: true,
        secretEnc: true,
        endpointId: true,
      },
    })) as ConnectionRow | null;
    if (!connection) {
      throw new VuvagentDispatchError(
        null,
        `ยังไม่ได้ตั้งการเชื่อมต่อของงาน ${action} ที่หน้า Integrations`,
      );
    }
    return connection;
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
      body: JSON.stringify({ ...body, organization_id: connection.companyId }),
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
