/**
 * ประตูเดียวที่ core ออกไปหา OSD Workflow (workflowable) — ไม่มีที่อื่นในโค้ด
 * ที่รู้จัก URL, header หรือรูปร่าง payload ของมัน.
 *
 * PO 10 ก.ย. 2569 — "Workflow owns Process, Core owns Data": core ไม่เคยถาม
 * workflow ว่า "เลื่อนได้ไหม" มันแค่ **บอกว่าเกิดอะไรขึ้นกับข้อมูล** แล้ว
 * workflow ตัดสินใจเองว่าจะทำอะไรต่อ. `start` = "Lead ใบใหม่เกิดแล้ว".
 */
export interface WorkflowStarted {
  readonly instanceId: string;
  readonly workflowKey: string;
  readonly status: string;
}

export interface WorkflowClient {
  readonly mode: 'mock' | 'http';

  /**
   * เปิด instance ของ `lwf-0001` ให้ Lead หนึ่งใบ.
   *
   * ผ่าน **channel API** (`application-api/channels/{id}/start` + `x-api-key`)
   * ซึ่งเป็นทางที่แพลตฟอร์มออกแบบไว้ให้แอปภายนอกเรียก — ไม่ใช่ console API.
   */
  startLead(
    leadId: string,
    variables?: Record<string, unknown>,
  ): Promise<WorkflowStarted>;

  /**
   * เปิด instance ของ workflow ที่ channel ใดก็ได้ (หน้า admin/workflow-triggers).
   * `startLead` ยังอยู่สำหรับทางเดิมที่อ่าน channel จาก env.
   */
  start(
    channel: WorkflowChannel,
    variables: Record<string, unknown>,
  ): Promise<WorkflowStarted>;
}

/** One Application API channel of OSD Workflow — from a `workflow_triggers` row. */
export interface WorkflowChannel {
  readonly channelId: string;
  /** `x-api-key`, opened from `channelKeyEnc` just before the call. */
  readonly channelKey: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

/** A start OSD Workflow refused (`statusCode`) or that never reached it (null). */
export class WorkflowStartError extends Error {
  constructor(
    readonly statusCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowStartError';
  }
}

export const WORKFLOW_CLIENT = Symbol('WORKFLOW_CLIENT');
