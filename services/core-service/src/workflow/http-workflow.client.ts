import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import type {
  WorkflowChannel,
  WorkflowClient,
  WorkflowStarted,
} from './workflow-client';
import { WorkflowStartError } from './workflow-client';

/** Starting only opens an instance; a call that hangs is a call that failed. */
const START_TIMEOUT_MS = 15_000;

/**
 * ตัวจริง (WORKFLOW_MODE=http) — OSD Workflow (`WORKFLOW_BASE_URL`, ตอนนี้
 * https://events.osd.co.th/workflow/api/v1).
 *
 * สัญญาที่ยิงทดสอบมาแล้ว 10 ก.ย. 2569 (และ 21 ต.ค. บนเครื่องใหม่):
 *
 * ```
 * POST /api/v1/application-api/channels/{channelId}/start
 *   x-api-key: <channel access key>
 *   x-organization-id: osd
 *   x-workspace-id: default
 *   {"variables": { ... }}
 * → 201 {"instanceId":"…","workflowKey":"ctd-flow-s1","status":"ACTIVE"}
 * ```
 *
 * **คีย์ไม่เคยอยู่ในโค้ด** — `startLead` อ่านจาก `WORKFLOW_CHANNEL_KEY`;
 * `start` ได้ channel จากแถว `workflow_triggers` (key เข้ารหัสไว้) และหมุนได้
 * จากหน้าจอ Channels โดยไม่ต้อง deploy.
 *
 * ยังไม่มีเมธอดส่ง signal ในนี้โดยตั้งใจ: `POST /workflow-instances/{id}/signal`
 * อยู่บน **console API** ซึ่งรับเฉพาะ Bearer (channel key ตอบ 401 — ยิงยืนยัน
 * แล้ว) จึงต้องมี Keycloak service account อีกใบ และยังไม่ทราบรูปร่าง body.
 * อย่าเดา — เติมเมื่อได้สัญญาจริง.
 */
@Injectable()
export class HttpWorkflowClient implements WorkflowClient {
  readonly mode = 'http' as const;
  private readonly logger = new Logger(HttpWorkflowClient.name);

  constructor(private readonly config: ConfigService) {}

  async startLead(
    leadId: string,
    variables: Record<string, unknown> = {},
  ): Promise<WorkflowStarted> {
    const channel: WorkflowChannel = {
      channelId: this.setting('workflow.channelId'),
      channelKey: this.setting('workflow.channelKey'),
      organizationId: this.setting('workflow.organizationId'),
      workspaceId: this.setting('workflow.workspaceId'),
    };
    try {
      return await this.start(channel, { leadId, ...variables });
    } catch (error) {
      if (!(error instanceof WorkflowStartError)) throw error;
      this.logger.warn(`start for lead ${leadId} failed: ${error.message}`);
      throw new AppError(
        'UPSTREAM_ERROR',
        error.statusCode === null
          ? 'ติดต่อ OSD Workflow ไม่ได้'
          : 'OSD Workflow ปฏิเสธคำขอเปิด instance',
        [{ field: 'workflow', reason: error.message }],
      );
    }
  }

  async start(
    channel: WorkflowChannel,
    variables: Record<string, unknown>,
  ): Promise<WorkflowStarted> {
    const baseUrl = this.setting('workflow.baseUrl');
    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/application-api/channels/${encodeURIComponent(channel.channelId)}/start`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
        headers: {
          'content-type': 'application/json',
          'x-api-key': channel.channelKey,
          'x-organization-id': channel.organizationId,
          'x-workspace-id': channel.workspaceId,
        },
        body: JSON.stringify({ variables }),
      },
    ).catch((cause: unknown) => {
      throw new WorkflowStartError(null, String(cause));
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new WorkflowStartError(
        response.status,
        `HTTP ${response.status} ${detail}`.trim().slice(0, 300),
      );
    }

    const body = (await response.json()) as Partial<WorkflowStarted>;
    if (!body.instanceId) {
      throw new WorkflowStartError(
        response.status,
        'OSD Workflow ไม่ได้คืน instanceId',
      );
    }

    return {
      instanceId: body.instanceId,
      workflowKey: body.workflowKey ?? '',
      status: body.status ?? 'ACTIVE',
    };
  }

  /** ตั้งค่าไม่ครบ = ตั้งใจปิดไว้ผิด ๆ — ล้มดังกว่าปล่อยให้ยิงไปที่ URL ว่าง. */
  private setting(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) {
      throw new AppError('UPSTREAM_ERROR', 'ยังไม่ได้ตั้งค่า OSD Workflow', [
        { field: key, reason: 'missing' },
      ]);
    }
    return value;
  }
}
