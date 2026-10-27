import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { sealSecret } from '../pm/config-rules';
import {
  WorkflowStartRepository,
  WorkflowTriggerRepository,
} from './workflow-trigger.repository';
import {
  sampleVariables,
  triggerProblems,
  WORKFLOW_TRIGGER_EVENTS,
} from './workflow-trigger-rules';
import {
  CreateWorkflowTriggerDto,
  UpdateWorkflowTriggerDto,
  WorkflowStartRowDto,
  WorkflowTriggerEventDto,
  WorkflowTriggerRowDto,
} from './dto/workflow-trigger.dto';

const START_PAGE = 50;

interface TriggerRow {
  id: string;
  companyId: string;
  name: string;
  eventKey: string;
  typeCodes: string[];
  channelId: string;
  channelKeyEnc: string;
  organizationId: string;
  workspaceId: string;
  active: boolean;
  createdAt: Date;
  createdBy: string;
}

interface StartRow {
  id: string;
  eventKey: string;
  resourceType: string;
  resourceId: string;
  variables: unknown;
  status: string;
  attempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  instanceId: string | null;
  workflowKey: string | null;
  nextAttemptAt: Date;
  startedAt: Date | null;
  createdAt: Date;
}

/**
 * The admin screen "เหตุการณ์ → workflow" (22 ต.ค. 2569). Every route is pinned
 * to the caller's active company; another company's trigger answers 404
 * (SCOPE-03). The channel key goes in and never comes out — not in a row,
 * not in audit.
 */
@Injectable()
export class WorkflowTriggerAdminService {
  constructor(
    private readonly triggers: WorkflowTriggerRepository,
    private readonly starts: WorkflowStartRepository,
    private readonly audit: AuditWriter,
    private readonly config: ConfigService,
  ) {}

  events(): WorkflowTriggerEventDto[] {
    return Object.entries(WORKFLOW_TRIGGER_EVENTS).map(([key, spec]) => ({
      key,
      label: spec.label,
      variables: [...spec.variables],
      filters_by_type: spec.filter !== null,
      filter_kind: spec.filter?.kind ?? null,
    }));
  }

  async list(actor: Principal): Promise<WorkflowTriggerRowDto[]> {
    const rows = (await this.triggers.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: { createdAt: 'desc' },
    })) as TriggerRow[];
    const last = await Promise.all(
      rows.map(
        (row) =>
          this.starts.findFirst({
            where: { triggerId: row.id },
            orderBy: { createdAt: 'desc' },
            select: { status: true, createdAt: true, lastError: true },
          }) as Promise<{
            status: string;
            createdAt: Date;
            lastError: string | null;
          } | null>,
      ),
    );
    return rows.map((row, i) => toRow(row, last[i]));
  }

  async create(
    dto: CreateWorkflowTriggerDto,
    actor: Principal,
  ): Promise<WorkflowTriggerRowDto> {
    const typeCodes = [...new Set(dto.type_codes ?? [])];
    this.assertValid({
      eventKey: dto.event_key,
      typeCodes,
      channelId: dto.channel_id,
    });
    const row = (await this.triggers.create({
      data: {
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        eventKey: dto.event_key,
        typeCodes,
        channelId: dto.channel_id,
        channelKeyEnc: this.seal(dto.channel_key),
        organizationId: dto.organization_id ?? this.defaultOf('organizationId'),
        workspaceId: dto.workspace_id ?? this.defaultOf('workspaceId'),
        createdBy: actor.userId,
      },
    })) as TriggerRow;

    await this.audit.record({
      eventType: 'admin.workflow_trigger.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'workflow_trigger',
      resourceId: row.id,
      after: summary(row),
    });
    return toRow(row, null);
  }

  async update(
    id: string,
    dto: UpdateWorkflowTriggerDto,
    actor: Principal,
  ): Promise<WorkflowTriggerRowDto> {
    const found = await this.owned(id, actor);
    const eventKey = dto.event_key ?? found.eventKey;
    const typeCodes = dto.type_codes
      ? [...new Set(dto.type_codes)]
      : found.typeCodes;
    this.assertValid({
      eventKey,
      typeCodes,
      channelId: dto.channel_id ?? found.channelId,
    });
    const row = (await this.triggers.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        eventKey,
        typeCodes,
        channelId: dto.channel_id,
        channelKeyEnc: dto.channel_key ? this.seal(dto.channel_key) : undefined,
        organizationId: dto.organization_id,
        workspaceId: dto.workspace_id,
        active: dto.active,
      },
    })) as TriggerRow;

    await this.audit.record({
      eventType: dto.channel_key
        ? 'admin.workflow_trigger.key_rotated'
        : 'admin.workflow_trigger.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'workflow_trigger',
      resourceId: id,
      before: summary(found),
      after: summary(row),
    });
    return toRow(row, null);
  }

  async listStarts(
    id: string,
    actor: Principal,
  ): Promise<WorkflowStartRowDto[]> {
    await this.owned(id, actor);
    const rows = (await this.starts.findMany({
      where: { triggerId: id },
      orderBy: { createdAt: 'desc' },
      take: START_PAGE,
    })) as StartRow[];
    return rows.map(toStartRow);
  }

  /** A `dead` start goes back on the queue; the next sweep tries it again. */
  async retry(
    id: string,
    startId: string,
    actor: Principal,
  ): Promise<WorkflowStartRowDto> {
    await this.owned(id, actor);
    const found = (await this.starts.findFirst({
      where: { id: startId, triggerId: id },
    })) as StartRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบรายการที่ระบุ');
    if (found.status !== 'dead') {
      throw new AppError(
        'UNPROCESSABLE',
        'ลองใหม่ได้เฉพาะรายการที่ล้มแล้ว (dead)',
      );
    }
    const row = (await this.starts.update({
      where: { id: startId },
      data: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        lastError: null,
      },
    })) as StartRow;
    await this.audit.record({
      eventType: 'admin.workflow_trigger.start_retried',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'workflow_trigger',
      resourceId: id,
      after: {
        startId,
        resourceType: found.resourceType,
        resourceId: found.resourceId,
      },
    });
    return toStartRow(row);
  }

  /**
   * Queue one real start with sample variables — OSD Workflow has no dry run,
   * so this opens an actual instance (the screen asks before it calls this).
   */
  async test(id: string, actor: Principal): Promise<WorkflowStartRowDto> {
    const found = await this.owned(id, actor);
    if (!found.active) {
      throw new AppError(
        'UNPROCESSABLE',
        'รายการนี้ปิดอยู่ — เปิดก่อนจึงทดสอบได้',
      );
    }
    const row = (await this.starts.create({
      data: {
        triggerId: id,
        companyId: found.companyId,
        eventKey: found.eventKey,
        resourceType: 'test',
        resourceId: randomUUID(),
        variables: sampleVariables(found.eventKey, found.companyId),
      },
    })) as StartRow;
    await this.audit.record({
      eventType: 'admin.workflow_trigger.tested',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'workflow_trigger',
      resourceId: id,
      after: { startId: row.id },
    });
    return toStartRow(row);
  }

  private async owned(id: string, actor: Principal): Promise<TriggerRow> {
    const found = (await this.triggers.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as TriggerRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบรายการที่ระบุ');
    return found;
  }

  private assertValid(input: Parameters<typeof triggerProblems>[0]): void {
    const problems = triggerProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems.map((problem) => problem.reason).join(' · '),
        problems,
      );
    }
  }

  private defaultOf(key: 'organizationId' | 'workspaceId'): string {
    return (
      this.config.get<string>(`workflow.${key}`) ||
      (key === 'organizationId' ? 'osd' : 'default')
    );
  }

  private seal(key: string): string {
    const secret = this.config.get<string>('projectConfig.secret');
    if (!secret) throw new Error('CONFIG_SECRET_KEY is not set');
    return sealSecret(key.trim(), secret);
  }
}

function toRow(
  row: TriggerRow,
  last: { status: string; createdAt: Date; lastError: string | null } | null,
): WorkflowTriggerRowDto {
  return {
    id: row.id,
    name: row.name,
    event_key: row.eventKey,
    type_codes: row.typeCodes,
    channel_id: row.channelId,
    organization_id: row.organizationId,
    workspace_id: row.workspaceId,
    has_channel_key: Boolean(row.channelKeyEnc),
    active: row.active,
    last_start: last
      ? {
          status: last.status,
          created_at: last.createdAt.toISOString(),
          last_error: last.lastError,
        }
      : null,
    created_at: row.createdAt.toISOString(),
    created_by: row.createdBy,
  };
}

function toStartRow(row: StartRow): WorkflowStartRowDto {
  return {
    id: row.id,
    event_key: row.eventKey,
    resource_type: row.resourceType,
    resource_id: row.resourceId,
    variables: (row.variables ?? {}) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    last_status_code: row.lastStatusCode,
    last_error: row.lastError,
    instance_id: row.instanceId,
    workflow_key: row.workflowKey,
    next_attempt_at: row.nextAttemptAt.toISOString(),
    started_at: row.startedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  };
}

/** What audit keeps — never the key. */
function summary(row: TriggerRow) {
  return {
    name: row.name,
    eventKey: row.eventKey,
    typeCodes: row.typeCodes,
    channelId: row.channelId,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    active: row.active,
  };
}
