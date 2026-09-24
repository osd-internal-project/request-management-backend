import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditWriter } from '@request-management/share';
import { WORKFLOW_CLIENT } from '../workflow/workflow-client';
import type { WorkflowClient } from '../workflow/workflow-client';
import { IntegrationSyncJobRepository } from './integration-job.repository';
import { LeadRepository } from './sales.repositories';

const SYSTEM = 'workflow';
const KIND = 'lead_start';
const MAX_ATTEMPTS = 10;

/** 1m, 2m, 4m … เพดาน 30m — workflow ที่ล่มถูก retry ไม่ใช่ถูกถล่ม. */
function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, 30 * 60_000);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * เปิด instance ของ `lwf-0001` ให้ Lead ทุกใบที่รับเข้ามา — จุดเชื่อมเดียวจาก
 * ฝั่งข้อมูลไปหาฝั่ง process.
 *
 * โครงเหมือน `CustomerErpSyncService` ทุกประการ และด้วยเหตุผลเดียวกัน:
 *
 *   - `kickLead` ยิง **หลังทรานแซกชัน commit** ไม่เคยยิงข้างใน — workflow ที่
 *     ช้าต้องไม่ถือทรานแซกชันฐานข้อมูลค้างไว้;
 *   - ยิงไม่ผ่านก็ลงคิว `integration_sync_jobs` แล้ว sweeper ลองใหม่พร้อม
 *     backoff — **หน้าจอเพิ่ม Lead ต้องไม่พังเพราะ workflow ล่ม** ซึ่งเป็นหลัก
 *     ที่ตามมาจาก "Core owns Data": ข้อมูลเกิดได้โดยไม่ต้องรอ process;
 *   - `leads.workflowInstanceId` เป็น NULL ระหว่างนั้น และ Lead ยังใช้งานได้ปกติ.
 *
 * Idempotent: Lead ที่มี `workflowInstanceId` แล้วจะไม่ถูก start ซ้ำ ไม่ว่าจะ
 * ถูกเรียกจากคิวกี่รอบ.
 */
@Injectable()
export class LeadWorkflowSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeadWorkflowSyncService.name);
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly leads: LeadRepository,
    private readonly jobs: IntegrationSyncJobRepository,
    @Inject(WORKFLOW_CLIENT) private readonly workflow: WorkflowClient,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const retryMs =
      this.config.get<number>('workflow.retryIntervalMs') ?? 300_000;

    // `0` ปิดตัวจับเวลา — เทสต์และสคริปต์ครั้งเดียวบูตได้โดยไม่มีอะไรเดินอยู่ข้างล่าง.
    if (retryMs > 0) {
      this.retryTimer = setInterval(() => void this.processQueue(), retryMs);
      this.retryTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
  }

  /** ยิงแบบไม่รอผล — ผู้เรียกคือเส้นทางสร้าง Lead ซึ่งต้องตอบกลับทันที. */
  kickLead(leadId: string): void {
    void this.startLead(leadId).catch(async (error) => {
      this.logger.warn(
        `workflow start deferred for lead ${leadId}: ${message(error)}`,
      );
      await this.enqueue(leadId, message(error));
    });
  }

  /** Lead หนึ่งใบ → instance หนึ่งตัว. คืน instance id ที่มันมีอยู่ตอนนี้. */
  async startLead(leadId: string): Promise<string | null> {
    const lead = (await this.leads.findFirst({
      where: { id: leadId },
      select: {
        id: true,
        companyId: true,
        name: true,
        workflowInstanceId: true,
      },
    })) as {
      id: string;
      companyId: string;
      name: string;
      workflowInstanceId: string | null;
    } | null;

    if (!lead) return null;
    if (lead.workflowInstanceId) return lead.workflowInstanceId;

    const started = await this.workflow.startLead(lead.id, {
      companyId: lead.companyId,
      leadName: lead.name,
    });

    await this.leads.update({
      where: { id: lead.id },
      data: { workflowInstanceId: started.instanceId },
    });

    await this.audit.record({
      eventType: 'integration.workflow.lead_started',
      companyId: lead.companyId,
      actorId: null,
      resourceType: 'lead',
      resourceId: lead.id,
      after: {
        instanceId: started.instanceId,
        workflowKey: started.workflowKey,
        status: started.status,
      },
    });

    return started.instanceId;
  }

  /** รอบกวาดคิว — เหมือน SAP: ทำทีละใบ ไม่ให้ใบเดียวล้มลากทั้งรอบ. */
  async processQueue(): Promise<void> {
    const due = (await this.jobs.findMany({
      where: {
        system: SYSTEM,
        status: 'pending',
        runAfter: { lte: new Date() },
      },
      orderBy: { runAfter: 'asc' },
      take: 20,
    })) as { id: string; resourceId: string; attempts: number }[];

    for (const job of due) {
      try {
        await this.startLead(job.resourceId);
        await this.jobs.update({
          where: { id: job.id },
          data: {
            status: 'succeeded',
            attempts: job.attempts + 1,
            lastError: null,
          },
        });
      } catch (error) {
        const attempts = job.attempts + 1;
        await this.jobs.update({
          where: { id: job.id },
          data: {
            attempts,
            lastError: message(error),
            ...(attempts >= MAX_ATTEMPTS
              ? { status: 'failed' }
              : { runAfter: new Date(Date.now() + backoffMs(attempts)) }),
          },
        });
      }
    }
  }

  private async enqueue(leadId: string, lastError: string): Promise<void> {
    const pending = (await this.jobs.findFirst({
      where: {
        system: SYSTEM,
        kind: KIND,
        resourceId: leadId,
        status: 'pending',
      },
      select: { id: true },
    })) as { id: string } | null;

    // หนึ่งใบค้างต่อ Lead — `startLead` อ่านสถานะล่าสุดเสมอ ซ้อนใบซ้ำไม่ได้อะไรเพิ่ม.
    if (pending) return;

    await this.jobs.create({
      data: { system: SYSTEM, kind: KIND, resourceId: leadId, lastError },
    });
  }
}
