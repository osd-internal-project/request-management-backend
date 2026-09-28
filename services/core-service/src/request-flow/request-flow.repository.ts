import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  type TxOption,
} from '@request-management/share';
import type { Prisma } from '@prisma/client';
import type {
  AssigneeRule,
  Flow,
  ReceiverRule,
  FlowCondition,
  FlowStep,
  FlowTransition,
} from '../requests/request-flow';
import type { SubRequestTypeRule } from '../requests/submit-rules';

const WITH_PARTS = {
  steps: { orderBy: { sortOrder: 'asc' } },
  transitions: { orderBy: { sortOrder: 'asc' } },
} satisfies Prisma.RequestFlowVersionInclude;

export type FlowVersionRow = Prisma.RequestFlowVersionGetPayload<{
  include: typeof WITH_PARTS;
}>;

/** Published request flows; a version is never updated, only superseded. */
@Injectable()
export class RequestFlowRepository extends BaseRepository<
  PrismaService['requestFlowVersion']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.requestFlowVersion;
  }

  /** The version new requests of this type pin at submit, if any. */
  findLatest(
    companyId: string,
    requestTypeId: string,
    option?: TxOption,
  ): Promise<FlowVersionRow | null> {
    return (option?.prisma ?? this.prisma).requestFlowVersion.findFirst({
      where: { companyId, requestTypeId },
      orderBy: { version: 'desc' },
      include: WITH_PARTS,
    });
  }

  /** What a lifecycle announcement names, read after the move committed. */
  findRequestFacts(requestId: string) {
    return this.prisma.request.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        companyId: true,
        requestNo: true,
        typeCode: true,
        requesterId: true,
        status: true,
        completedAt: true,
      },
    });
  }

  findVersion(id: string, option?: TxOption): Promise<FlowVersionRow | null> {
    return (option?.prisma ?? this.prisma).requestFlowVersion.findUnique({
      where: { id },
      include: WITH_PARTS,
    });
  }

  listVersions(
    companyId: string,
    requestTypeId: string,
  ): Promise<FlowVersionRow[]> {
    return this.prisma.requestFlowVersion.findMany({
      where: { companyId, requestTypeId },
      orderBy: { version: 'desc' },
      include: WITH_PARTS,
    });
  }
}

/** The stored rows as the pure engine reads them. */
export function toFlow(row: FlowVersionRow): Flow {
  return {
    steps: row.steps.map((step): FlowStep => ({
      code: step.code,
      name: step.name,
      sortOrder: step.sortOrder,
      formSchema: step.formSchema,
      // JSON columns written only through the publish DTOs, so their shape is known.
      subRequestTypes: Array.isArray(step.subRequestTypes)
        ? (step.subRequestTypes as unknown as SubRequestTypeRule[])
        : [],
      requiresApproval: step.requiresApproval,
      assigneeRule: (step.assigneeRule as AssigneeRule | null) ?? null,
      slaHours: step.slaHours,
      scopeStatus: step.scopeStatus,
      receiverRule: (step.receiverRule as ReceiverRule | null) ?? null,
      returnToStepCode: step.returnToStepCode,
      approvalLevels: step.approvalLevels,
      requiredDocs: Array.isArray(step.requiredDocs)
        ? (step.requiredDocs as unknown as FlowStep['requiredDocs'])
        : [],
    })),
    transitions: row.transitions.map((exit): FlowTransition => ({
      fromStepCode: exit.fromStepCode,
      toStepCode: exit.toStepCode,
      sortOrder: exit.sortOrder,
      condition: (exit.condition as FlowCondition | null) ?? null,
      backward: exit.backward,
    })),
    schemaVersion: row.schemaVersion,
  };
}
