import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AuditWriter } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { LeadRepository } from '../crm/sales.repositories';
import { DomainEventsService } from '../events/domain-events.service';
import type { DomainEvent } from '../events/event-catalog';
import { openSecret } from '../pm/config-rules';
import {
  WORKFLOW_CLIENT,
  WorkflowStartError,
  type WorkflowClient,
} from '../workflow/workflow-client';
import {
  ClaimedStart,
  WorkflowStartRepository,
  WorkflowTriggerRepository,
} from './workflow-trigger.repository';
import {
  matchesTypes,
  nextAttemptDelayMs,
  startOf,
  TRIGGER_EVENT_KEYS,
} from './workflow-trigger-rules';

const BATCH = 20;
const LEASE_MS = 5 * 60_000;
const MAX_ERROR = 500;

/**
 * เหตุการณ์ใน CTD → เริ่ม workflow (22 ต.ค. 2569).
 *
 * Every event a trigger may listen to becomes a start row per active trigger
 * of its company (both processes — an event raised through the external API
 * is emitted in external-service). The timer that calls OSD Workflow runs in
 * core-service only; external-service sets `workflowTrigger.intervalMs` to 0.
 *
 * At-least-once, like the webhook outbox: a document starts a trigger's
 * workflow once (`@@unique([triggerId, resourceType, resourceId])`), and a
 * start that fails is retried on the webhook ladder, then `dead`.
 */
@Injectable()
export class WorkflowTriggerDispatchService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WorkflowTriggerDispatchService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly triggers: WorkflowTriggerRepository,
    private readonly starts: WorkflowStartRepository,
    private readonly leads: LeadRepository,
    private readonly events: DomainEventsService,
    @Inject(WORKFLOW_CLIENT) private readonly workflow: WorkflowClient,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    for (const name of TRIGGER_EVENT_KEYS) {
      this.events.on(name as DomainEvent['name'], (event) =>
        this.enqueue(event)
          .then(() => undefined)
          .catch((error: Error) =>
            this.logger.warn(
              `workflow trigger ${event.name} not queued: ${error.message}`,
            ),
          ),
      );
    }
    const interval = this.config.get<number>('workflowTrigger.intervalMs') ?? 0;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'workflow trigger starts', () =>
        this.sweep(),
      ),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pending start per active trigger of the company that listens to the event. */
  async enqueue(event: Pick<DomainEvent, 'name' | 'payload'>): Promise<number> {
    const start = startOf(event);
    if (!start) return 0;
    const payload = event.payload as unknown as Record<string, unknown>;
    const companyId = String(payload.company_id);
    const listening = (
      await this.triggers.listeningTo(companyId, event.name)
    ).filter((trigger) => matchesTypes(trigger.typeCodes, payload));
    if (listening.length === 0) return 0;
    const { count } = await this.starts.createMany({
      data: listening.map((trigger) => ({
        triggerId: trigger.id,
        companyId,
        eventKey: event.name,
        resourceType: start.resourceType,
        resourceId: start.resourceId,
        variables: start.variables,
      })),
      // the same event delivered twice must not start the workflow twice
      skipDuplicates: true,
    });
    return count;
  }

  /** Has the company moved `lead.created` to this screen? (then the env path stands down) */
  async handlesLeadCreated(companyId: string): Promise<boolean> {
    const found = await this.triggers.findFirst({
      where: { companyId, eventKey: 'lead.created', active: true },
      select: { id: true },
    });
    return found !== null;
  }

  /** Start what is due; returns how many rows were attempted. */
  async sweep(): Promise<number> {
    const due = await this.starts.claimDue(BATCH, LEASE_MS);
    for (const start of due) await this.deliver(start);
    return due.length;
  }

  private async deliver(start: ClaimedStart): Promise<void> {
    const trigger = await this.triggers.findUnique({
      where: { id: start.triggerId },
    });
    if (!trigger?.active) {
      await this.dead(start.id, null, 'trigger ถูกปิดแล้ว');
      return;
    }
    const channelKey = openSecret(
      trigger.channelKeyEnc,
      this.config.get<string>('projectConfig.secret') ?? '',
    );
    if (channelKey === null) {
      await this.dead(
        start.id,
        null,
        'ถอดรหัส channel key ไม่ได้ — CONFIG_SECRET_KEY อาจถูกเปลี่ยน ต้องใส่ key ใหม่',
      );
      return;
    }

    try {
      const started = await this.workflow.start(
        {
          channelId: trigger.channelId,
          channelKey,
          organizationId: trigger.organizationId,
          workspaceId: trigger.workspaceId,
        },
        (start.variables ?? {}) as Record<string, unknown>,
      );
      await this.starts.update({
        where: { id: start.id },
        data: {
          status: 'started',
          instanceId: started.instanceId,
          workflowKey: started.workflowKey || null,
          lastStatusCode: null,
          lastError: null,
          startedAt: new Date(),
        },
      });
      await this.afterStart(start, started.instanceId);
      await this.audit.record({
        eventType: 'integration.workflow.started',
        companyId: start.companyId,
        actorId: null,
        resourceType: start.resourceType,
        resourceId: start.resourceId,
        after: {
          triggerId: start.triggerId,
          eventKey: start.eventKey,
          instanceId: started.instanceId,
          workflowKey: started.workflowKey,
        },
      });
    } catch (error) {
      const statusCode =
        error instanceof WorkflowStartError ? error.statusCode : null;
      await this.retryOrDie(
        start,
        statusCode,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * A lead started from here still carries its instance on the lead, as the
   * env path always did: `crm/leads/:id/facts|stage` and the lead page read it.
   */
  private async afterStart(
    start: ClaimedStart,
    instanceId: string,
  ): Promise<void> {
    if (start.eventKey !== 'lead.created' || start.resourceType !== 'lead')
      return;
    await this.leads
      .updateMany({
        where: {
          id: start.resourceId,
          companyId: start.companyId,
          workflowInstanceId: null,
        },
        data: { workflowInstanceId: instanceId },
      })
      .catch((error: Error) =>
        this.logger.warn(
          `lead ${start.resourceId} instance not kept: ${error.message}`,
        ),
      );
  }

  private async retryOrDie(
    start: ClaimedStart,
    statusCode: number | null,
    reason: string,
  ): Promise<void> {
    const delay = nextAttemptDelayMs(start.attempts);
    if (delay === null) {
      await this.dead(start.id, statusCode, reason);
      return;
    }
    await this.starts.update({
      where: { id: start.id },
      data: {
        status: 'pending',
        nextAttemptAt: new Date(Date.now() + delay),
        lastStatusCode: statusCode,
        lastError: reason.slice(0, MAX_ERROR),
      },
    });
  }

  private dead(id: string, statusCode: number | null, reason: string) {
    return this.starts.update({
      where: { id },
      data: {
        status: 'dead',
        lastStatusCode: statusCode,
        lastError: reason.slice(0, MAX_ERROR),
      } satisfies Prisma.WorkflowStartUpdateInput,
    });
  }
}
