import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  auditActor,
  AuditWriter,
  PrismaService,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma, type WorkflowDefinition } from '@prisma/client';
import { buildBpmn } from './bpmn-builder';
import {
  assertPublishable,
  type ActionInput,
  type StateInput,
} from './workflow-rules';
import { WorkflowRepository, type FullDefinition } from './workflow.repository';
import { FlowableClient } from './flowable.client';
import { ACTIONS } from '../requests/available-actions';
import { CreateWorkflowDto, SaveWorkflowGraphDto } from './dto/workflow.dto';

/** The authorities an action may claim — read from the one table that has them. */
const AUTHORITIES: readonly string[] = [
  ...new Set(ACTIONS.map((spec) => spec.authority)),
];

/**
 * Assembling and publishing the route a request type travels.
 *
 * The counterpart to `ApprovalMatrixService`, and it borrows that class's one
 * hard rule: **a published version is immutable**. There is no update path for
 * one, on purpose — editing means publishing N+1, which is what lets a request
 * already running keep the route it started on (§7). Silently editing a live
 * route would re-judge work in flight.
 *
 * What is different is where the truth lives. The matrix is read out of the
 * database at decision time; a workflow is *also* deployed to Flowable, and
 * that copy is generated, never authored. These tables stay the source of
 * truth and `bpmn-builder.ts` projects them.
 */
@Injectable()
export class WorkflowService {
  constructor(
    private readonly definitions: WorkflowRepository,
    private readonly flowable: FlowableClient,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
  ) {}

  list(
    companyId: string,
    requestTypeId?: string,
  ): Promise<WorkflowDefinition[]> {
    return this.definitions.findForCompany(companyId, requestTypeId);
  }

  /** One version with its whole graph — what the screen loads to edit. */
  async findOne(id: string, actor: Principal): Promise<FullDefinition> {
    const definition = await this.definitions.findFull(id);

    if (!definition) {
      throw new AppError('NOT_FOUND', 'ไม่พบผังงานที่ระบุ');
    }

    // The row carries the company, so membership is checked against the row
    // rather than trusted from the query string.
    resolveTargetCompany(actor, definition.companyId);

    return definition;
  }

  /** Opens the next draft version for a type. */
  async create(
    dto: CreateWorkflowDto,
    actor: Principal,
  ): Promise<WorkflowDefinition> {
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const version =
      (await this.definitions.latestVersion(companyId, dto.request_type_id)) +
      1;

    const created = await this.definitions.create({
      data: {
        companyId,
        requestTypeId: dto.request_type_id,
        version,
        name: dto.name,
        status: 'draft',
        createdBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'workflow.definition.created',
      companyId,
      ...auditActor(actor),
      resourceType: 'workflow_definition',
      resourceId: created.id,
      after: { requestTypeId: dto.request_type_id, version, name: dto.name },
    });

    return created;
  }

  /**
   * Replaces the whole graph of a draft.
   *
   * A replace rather than per-row edits because the screen edits a picture: a
   * half-applied picture is a route with an orphan state in it, and the
   * validation that would catch that runs over the whole graph anyway.
   */
  async saveGraph(
    id: string,
    dto: SaveWorkflowGraphDto,
    actor: Principal,
  ): Promise<FullDefinition> {
    const before = await this.findOne(id, actor);

    this.assertDraft(before);
    assertKnownAuthorities(dto.actions);

    await this.prisma.$transaction(async (tx) => {
      // Actions first: they hold the foreign key onto states.
      await tx.workflowAction.deleteMany({ where: { definitionId: id } });
      await tx.workflowState.deleteMany({ where: { definitionId: id } });

      await tx.workflowState.createMany({
        data: dto.states.map((state, index) => ({
          definitionId: id,
          key: state.key,
          name: state.name,
          phase: state.phase,
          kind: state.kind,
          formSchema:
            (state.form_schema as Prisma.InputJsonValue) ?? Prisma.DbNull,
          slaHours: state.sla_hours ?? null,
          isStart: state.is_start ?? false,
          sortOrder: state.sort_order ?? index,
        })),
      });

      for (const [index, action] of dto.actions.entries()) {
        await tx.workflowAction.create({
          data: {
            definitionId: id,
            fromStateKey: action.from_state_key,
            actionKey: action.action_key,
            toStateKey: action.to_state_key,
            label: action.label,
            authority: action.authority,
            formSchema:
              (action.form_schema as Prisma.InputJsonValue) ?? Prisma.DbNull,
            condition: action.condition ?? null,
            confirmRequired: action.confirm_required ?? false,
            sortOrder: action.sort_order ?? index,
            dataMaps: {
              create: (action.data_maps ?? []).map((map) => ({
                sourceField: map.source_field,
                variableName: map.variable_name,
                targetColumn: map.target_column,
              })),
            },
          },
        });
      }

      await tx.workflowDefinition.update({
        where: { id },
        data: { updatedBy: actor.userId },
      });
    });

    await this.audit.record({
      eventType: 'workflow.definition.updated',
      companyId: before.companyId,
      ...auditActor(actor),
      resourceType: 'workflow_definition',
      resourceId: id,
      after: {
        states: dto.states.length,
        actions: dto.actions.length,
      },
    });

    return this.findOne(id, actor);
  }

  /**
   * Validates the graph, generates the BPMN, deploys it, and marks the version
   * published.
   *
   * The deploy is an HTTP call and cannot join the transaction, so it goes
   * first: a definition marked `published` that Flowable never received would
   * route requests into an engine that has never heard of them, whereas a
   * deployment with no published row is inert — nothing starts an instance of
   * it — and republishing is harmless.
   */
  async publish(id: string, actor: Principal): Promise<WorkflowDefinition> {
    const definition = await this.findOne(id, actor);

    this.assertDraft(definition);

    const states = definition.states.map(toStateInput);
    const actions = definition.actions.map(toActionInput);

    assertPublishable(states, actions);

    const processKey = `wf_${definition.requestTypeId}_v${definition.version}`;
    const bpmnXml = buildBpmn(
      { processKey, name: definition.name },
      states,
      definition.actions.map((action) => ({
        fromStateKey: action.fromStateKey,
        actionKey: action.actionKey,
        toStateKey: action.toStateKey,
        condition: action.condition,
      })),
      { callbackUrl: this.callbackUrl, callbackSecret: this.callbackSecret },
    );

    const deployed = await this.flowable.deploy(processKey, bpmnXml);

    const published = await this.definitions.update({
      where: { id },
      data: {
        status: 'published',
        bpmnXml,
        flowableDeploymentId: deployed.deploymentId,
        flowableProcessKey: processKey,
        publishedAt: new Date(),
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'workflow.definition.published',
      companyId: definition.companyId,
      ...auditActor(actor),
      resourceType: 'workflow_definition',
      resourceId: id,
      after: {
        version: definition.version,
        processKey,
        deploymentId: deployed.deploymentId,
        states: states.length,
        actions: actions.length,
      },
    });

    return published;
  }

  private get callbackSecret(): string {
    return this.config.get<string>('flowable.callbackSecret') ?? '';
  }

  private get callbackUrl(): string {
    return (
      this.config.get<string>('flowable.callbackUrl') ??
      'http://localhost:3002/api/v1/internal/workflow/callback'
    );
  }

  /** Published versions are immutable — see the class comment. */
  private assertDraft(definition: WorkflowDefinition): void {
    if (definition.status === 'draft') return;

    throw new AppError(
      'WORKFLOW_PUBLISHED_IMMUTABLE',
      'ผังงานที่เผยแพร่แล้วแก้ไม่ได้ ให้สร้างเวอร์ชันใหม่แทน',
      [{ field: 'status', reason: definition.status }],
    );
  }
}

function toStateInput(state: FullDefinition['states'][number]): StateInput {
  return {
    key: state.key,
    phase: state.phase,
    kind: state.kind,
    isStart: state.isStart,
  };
}

function toActionInput(action: FullDefinition['actions'][number]): ActionInput {
  return {
    fromStateKey: action.fromStateKey,
    actionKey: action.actionKey,
    toStateKey: action.toStateKey,
    authority: action.authority,
    condition: action.condition,
    dataMaps: action.dataMaps,
  };
}

/**
 * An authority the action list does not know is one `hasAuthority` cannot
 * answer, so every button carrying it would be offered to nobody — a route
 * that deploys cleanly and quietly strands every request that reaches it.
 */
function assertKnownAuthorities(
  actions: readonly { action_key: string; authority: string }[],
): void {
  const unknown = actions.filter(
    (action) => !AUTHORITIES.includes(action.authority),
  );

  if (unknown.length) {
    throw new AppError(
      'WORKFLOW_INVALID',
      'ผังงานนี้ยังบันทึกไม่ได้ กรุณาแก้ตามรายการด้านล่าง',
      unknown.map((action) => ({
        field: `actions.${action.action_key}.authority`,
        reason: `ไม่รู้จักสิทธิ์ ${action.authority}`,
      })),
    );
  }
}
