import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';
import { Prisma, type WorkflowDefinition } from '@prisma/client';

/**
 * The include every full read uses — declared once so the type below and the
 * query that produces it cannot drift.
 */
const FULL_INCLUDE = {
  states: { orderBy: { sortOrder: 'asc' } },
  actions: {
    orderBy: { sortOrder: 'asc' },
    include: { dataMaps: true },
  },
} as const satisfies Prisma.WorkflowDefinitionInclude;

/** A definition with everything needed to validate, render or deploy it. */
export type FullDefinition = Prisma.WorkflowDefinitionGetPayload<{
  include: typeof FULL_INCLUDE;
}>;

/** Every `workflow_definitions` query lives here. */
@Injectable()
export class WorkflowRepository extends BaseRepository<
  PrismaService['workflowDefinition']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.workflowDefinition;
  }

  /** Every version for a company, newest first, for the admin screen's list. */
  findForCompany(
    companyId: string,
    requestTypeId?: string,
    option?: TxOption,
  ): Promise<WorkflowDefinition[]> {
    return this.findMany(
      {
        where: { companyId, ...(requestTypeId ? { requestTypeId } : {}) },
        orderBy: [{ requestTypeId: 'asc' }, { version: 'desc' }],
      },
      option,
    );
  }

  /** One version with its whole graph — what publish and the screen both need. */
  findFull(id: string, option?: TxOption): Promise<FullDefinition | null> {
    const client = option?.prisma ?? this.prisma;

    return client.workflowDefinition.findUnique({
      where: { id },
      include: FULL_INCLUDE,
    });
  }

  /**
   * The version a new request of this type starts on.
   *
   * Published, highest version. A draft must never route real work, which is
   * why this asks for the status rather than just the newest row — the same
   * rule `ApprovalMatrixRepository.findEffective` follows.
   */
  findPublished(
    companyId: string,
    requestTypeId: string,
    option?: TxOption,
  ): Promise<WorkflowDefinition | null> {
    const client = option?.prisma ?? this.prisma;

    return client.workflowDefinition.findFirst({
      where: { companyId, requestTypeId, status: 'published' },
      orderBy: { version: 'desc' },
    });
  }

  /** Highest version so far, or 0 — the next draft is this plus one. */
  async latestVersion(
    companyId: string,
    requestTypeId: string,
    option?: TxOption,
  ): Promise<number> {
    const client = option?.prisma ?? this.prisma;

    const latest = await client.workflowDefinition.findFirst({
      where: { companyId, requestTypeId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    return latest?.version ?? 0;
  }
}

/** Every `workflow_states` query lives here. */
@Injectable()
export class WorkflowStateRepository extends BaseRepository<
  PrismaService['workflowState']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.workflowState;
  }
}

/** Every `workflow_actions` query lives here. */
@Injectable()
export class WorkflowActionRepository extends BaseRepository<
  PrismaService['workflowAction']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.workflowAction;
  }

  /**
   * The buttons out of one state, in screen order.
   *
   * What the action list asks on every request detail view, so it reads the
   * published definition's rows rather than the engine — an HTTP call per page
   * view to answer "which buttons" would be a page that fails when Flowable
   * hiccups.
   */
  findForState(definitionId: string, fromStateKey: string, option?: TxOption) {
    return this.findMany(
      {
        where: { definitionId, fromStateKey },
        orderBy: { sortOrder: 'asc' },
        include: { dataMaps: true },
      },
      option,
    );
  }
}

/** Every `workflow_instances` query lives here. */
@Injectable()
export class WorkflowInstanceRepository extends BaseRepository<
  PrismaService['workflowInstance']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.workflowInstance;
  }

  findByRequest(requestId: string, option?: TxOption) {
    return this.findUnique({ where: { requestId } }, option);
  }

  /** The callback's only way in: Flowable knows the process, not our ids. */
  findByProcessInstance(processInstanceId: string, option?: TxOption) {
    return this.findUnique(
      { where: { flowableProcessInstanceId: processInstanceId } },
      option,
    );
  }
}
