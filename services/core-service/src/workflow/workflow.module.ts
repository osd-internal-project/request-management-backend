import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpWorkflowClient } from './http-workflow.client';
import { MockWorkflowClient } from './mock-workflow.client';
import { WORKFLOW_CLIENT } from './workflow-client';

/**
 * ประตูของ core ไปหา OSD Workflow — client ล้วน ไม่แตะฐานข้อมูล เพื่อให้
 * feature module import ได้โดยไม่เกิดวงจร (แพตเทิร์นเดียวกับ `OdooModule`);
 * ส่วนที่รู้จัก Lead อยู่ใน `crm/lead-workflow-sync.service.ts`.
 */
@Module({
  providers: [
    MockWorkflowClient,
    HttpWorkflowClient,
    {
      provide: WORKFLOW_CLIENT,
      inject: [ConfigService, MockWorkflowClient, HttpWorkflowClient],
      useFactory: (
        config: ConfigService,
        mock: MockWorkflowClient,
        http: HttpWorkflowClient,
      ) => (config.get<string>('workflow.mode') === 'http' ? http : mock),
    },
  ],
  exports: [WORKFLOW_CLIENT],
})
export class WorkflowModule {}
