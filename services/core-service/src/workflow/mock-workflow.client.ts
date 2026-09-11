import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { WorkflowClient, WorkflowStarted } from './workflow-client';

/**
 * สแตนด์อินในหน่วยความจำ (WORKFLOW_MODE=mock, ค่าตั้งต้น) — ทุกสภาพแวดล้อม
 * ทำงานได้โดยไม่ต้องมี OSD Workflow จริง เหมือน `MockOdooClient`.
 *
 * คืน instance id ปลอมที่หน้าตาเหมือนของจริง เพื่อให้เส้นทางเก็บ
 * `leads.workflowInstanceId` ถูกเดินจริงในเทสต์และในเครื่อง dev.
 */
@Injectable()
export class MockWorkflowClient implements WorkflowClient {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger(MockWorkflowClient.name);

  startLead(leadId: string): Promise<WorkflowStarted> {
    const instanceId = randomUUID();
    this.logger.log(`mock start lwf-0001 for lead ${leadId} → ${instanceId}`);
    return Promise.resolve({
      instanceId,
      workflowKey: 'lwf-0001',
      status: 'ACTIVE',
    });
  }
}
