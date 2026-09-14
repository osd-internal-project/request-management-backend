import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import type { WorkflowClient, WorkflowStarted } from './workflow-client';

/**
 * ตัวจริง (WORKFLOW_MODE=http) — OSD Workflow ที่ 192.168.31.52:13001.
 *
 * สัญญาที่ยิงทดสอบมาแล้ว 10 ก.ย. 2569:
 *
 * ```
 * POST /api/v1/application-api/channels/{channelId}/start
 *   x-api-key: <channel access key>
 *   x-organization-id: osd-company
 *   x-workspace-id: default
 *   {"variables": { ... }}
 * → 201 {"instanceId":"…","workflowKey":"lwf-0001","status":"ACTIVE"}
 * ```
 *
 * **คีย์ไม่เคยอยู่ในโค้ด** — มาจาก `WORKFLOW_CHANNEL_KEY` เท่านั้น และหมุนได้
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
    const baseUrl = this.setting('workflow.baseUrl');
    const channelId = this.setting('workflow.channelId');

    const response = await fetch(
      `${baseUrl.replace(/\/$/, '')}/application-api/channels/${encodeURIComponent(channelId)}/start`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.setting('workflow.channelKey'),
          'x-organization-id': this.setting('workflow.organizationId'),
          'x-workspace-id': this.setting('workflow.workspaceId'),
        },
        body: JSON.stringify({ variables: { leadId, ...variables } }),
      },
    ).catch((cause: unknown) => {
      throw new AppError('UPSTREAM_ERROR', 'ติดต่อ OSD Workflow ไม่ได้', [
        { field: 'workflow', reason: String(cause) },
      ]);
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        `start lwf-0001 for lead ${leadId} failed: ${response.status} ${detail}`,
      );
      throw new AppError(
        'UPSTREAM_ERROR',
        'OSD Workflow ปฏิเสธคำขอเปิด instance',
        [{ field: 'workflow', reason: `${response.status}` }],
      );
    }

    const body = (await response.json()) as Partial<WorkflowStarted>;
    if (!body.instanceId) {
      throw new AppError(
        'UPSTREAM_ERROR',
        'OSD Workflow ไม่ได้คืน instanceId',
        [{ field: 'workflow', reason: 'instanceId missing' }],
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
