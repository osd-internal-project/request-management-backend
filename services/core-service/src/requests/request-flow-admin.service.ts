import { Injectable, Optional } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  PrismaTransactionService,
  auditActor,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma } from '@prisma/client';
import { ApprovalsService } from '../approvals/approvals.service';
import { AccessService, type MatrixLevel } from '../access/access.service';
import { RequestFlowRepository } from '../request-flow/request-flow.repository';
import { RequestRepository } from './request.repository';
import { RequestTypeRepository } from './request-type.repository';
import { AFTER_WORK, BEFORE_WORK, stepExit } from './approval-stage';
import {
  assertPublishable,
  asRecord,
  type AssigneeRule,
  type Flow,
  type ReceiverRule,
} from './request-flow';
import { assertPublishableV2, scopeOf } from './request-flow-v2';
import { suggestedFlow } from './request-flow-suggest';
import {
  assertUsableFormSchema,
  assertUsableSubRequestTypes,
} from './submit-rules';
import type { PublishFlowDto } from './dto/request.dto';
import { FormBindingRegistry } from './form-binding.registry';

/** Screen A2's "ขั้นตอน" tab: reads and publishes a type's flow versions. */
@Injectable()
export class RequestFlowAdminService {
  constructor(
    private readonly flows: RequestFlowRepository,
    private readonly types: RequestTypeRepository,
    private readonly requests: RequestRepository,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly access: AccessService,
    @Optional() private readonly bindings?: FormBindingRegistry,
  ) {}

  async list(code: string, actor: Principal, companyId?: string) {
    const type = await this.requireType(code);
    return this.flows.listVersions(
      resolveTargetCompany(actor, companyId),
      type.id,
    );
  }

  /** Validates the whole flow, then writes version N+1 with its steps and exits. */
  async publish(code: string, dto: PublishFlowDto, actor: Principal) {
    const type = await this.requireType(code);
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const flow = flowFromDto(dto);
    const v2 = flow.schemaVersion === 2;

    if (v2) {
      assertReservedCodesUnused(dto);
      assertPublishableV2(flow, knownFields(type.formSchema, dto));
      await this.assertStepsUsableV2(companyId, dto, flow);
    } else {
      assertPublishable(flow, knownFields(type.formSchema, dto));
    }
    await this.assertStepsUsable(type.code, companyId, dto);
    await this.bindings?.assertBound(
      type.code,
      dto.steps.find((step) => step.scope_status === 'draft')?.form_schema ?? type.formSchema,
      companyId,
    );

    const published = await this.transactions.execute(async (prisma) => {
      const latest = await prisma.requestFlowVersion.findFirst({
        where: { companyId, requestTypeId: type.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });

      const created = await prisma.requestFlowVersion.create({
        data: {
          companyId,
          requestTypeId: type.id,
          version: (latest?.version ?? 0) + 1,
          schemaVersion: flow.schemaVersion ?? 1,
          publishedBy: actor.userId,
          steps: {
            create: flow.steps.map((parsed, index) => ({
              ...v2Columns(parsed),
              ...v1Columns(dto.steps[index], parsed),
            })),
          },
          transitions: {
            create: flow.transitions.map((exit) => ({
              fromStepCode: exit.fromStepCode,
              toStepCode: exit.toStepCode,
              sortOrder: exit.sortOrder,
              condition:
                (exit.condition as Prisma.InputJsonValue | null) ??
                Prisma.DbNull,
              backward: exit.backward,
            })),
          },
        },
      });

      await this.audit.record(
        {
          eventType: 'request.flow.published',
          companyId,
          ...auditActor(actor),
          resourceType: 'request_type',
          resourceId: type.id,
          after: {
            version: created.version,
            steps: dto.steps.map((step) => step.code),
          },
        },
        { prisma },
      );

      return created;
    });

    return this.flows.findVersion(published.id);
  }

  /** What the pure check cannot see: forms, checklists, ladders and people. */
  private async assertStepsUsable(
    typeCode: string,
    companyId: string,
    dto: PublishFlowDto,
  ): Promise<void> {
    for (const step of dto.steps) {
      if (step.form_schema) assertUsableFormSchema(step.form_schema);

      const checklist = step.sub_request_types ?? [];
      if (checklist.length) {
        const known = await this.types.findMany({
          where: { code: { in: checklist.map((item) => item.code) } },
          select: { code: true },
        });
        assertUsableSubRequestTypes(
          typeCode,
          checklist,
          known.map((found) => found.code),
        );
      }

      if (step.assignee_rule?.type === 'user') {
        const member = step.assignee_rule.user_id
          ? await this.requests.findReceiver(
              step.assignee_rule.user_id,
              companyId,
            )
          : null;
        if (!member) {
          throw new AppError(
            'VALIDATION_FAILED',
            'ไม่พบผู้รับผิดชอบขั้นนี้ในบริษัท',
            [
              {
                field: `steps.${step.code}.assignee_rule`,
                reason: step.assignee_rule.user_id ?? '',
              },
            ],
          );
        }
      }

      if (step.requires_approval) {
        const subject = stepExit(step.code).subjectOf(typeCode);
        const hasLadder = await this.approvals.hasPublishedMatrix(
          subject,
          companyId,
          '',
        );
        if (!hasLadder) {
          throw new AppError(
            'VALIDATION_FAILED',
            'ขั้นที่ต้องอนุมัติยังไม่มีสายอนุมัติ',
            [
              {
                field: `steps.${step.code}.requires_approval`,
                reason: subject,
              },
            ],
          );
        }
      }
    }
  }

  /** v2: approvers, receivers and a step's documents, which the pure check cannot see. */
  private async assertStepsUsableV2(
    companyId: string,
    dto: PublishFlowDto,
    flow: Flow,
  ): Promise<void> {
    for (const [index, step] of dto.steps.entries()) {
      const parsed = flow.steps[index];
      if (step.required_docs?.length) {
        assertUsableFormSchema(
          step.form_schema ?? PLACEHOLDER_FORM,
          step.required_docs,
        );
      }
      if (step.approval_levels?.length) {
        // `assertPublishableV2` has already narrowed them with `assertValidLevels`.
        await this.access.assertLevelTargetsExist(
          step.approval_levels as unknown as MatrixLevel[],
          companyId,
        );
      }
      const rule = parsed.receiverRule;
      if (
        rule?.type === 'user' &&
        !(await this.isMember(rule.userId, companyId))
      ) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบผู้รับขั้นนี้ในบริษัท', [
          { field: `steps.${step.code}.receiver_rule`, reason: rule.userId },
        ]);
      }
      if (
        rule?.type === 'step' &&
        !flow.steps.some((s) => s.code === rule.stepCode)
      ) {
        throw new AppError('VALIDATION_FAILED', 'ไม่พบขั้นที่อ้างถึง', [
          { field: `steps.${step.code}.receiver_rule`, reason: rule.stepCode },
        ]);
      }
    }
  }

  private async isMember(userId: string, companyId: string): Promise<boolean> {
    return Boolean(
      userId && (await this.requests.findReceiver(userId, companyId)),
    );
  }

  /**
   * "สร้าง flow จากค่าเดิม": a v2 draft built from the type's current settings
   * and effective ladders. Writes nothing — the admin edits and publishes it.
   */
  async suggested(code: string, actor: Principal, companyId?: string) {
    const type = await this.requireType(code);
    const company = resolveTargetCompany(actor, companyId);
    const [preLevels, postLevels] = await Promise.all([
      this.approvals.effectiveLevels(BEFORE_WORK.subjectOf(type.code), company),
      this.approvals.effectiveLevels(AFTER_WORK.subjectOf(type.code), company),
    ]);

    return suggestedFlow({
      formSchema: type.formSchema,
      requiredDocs: type.requiredDocs,
      receiverFormSchema: type.receiverFormSchema,
      subRequestTypes: type.subRequestTypes,
      preLevels,
      postLevels,
    });
  }

  private async requireType(code: string) {
    const type = await this.types.findFirst({ where: { code } });
    if (!type) {
      throw new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอที่ระบุ', [
        { field: 'code', reason: code },
      ]);
    }
    return type;
  }
}

export function flowFromDto(dto: PublishFlowDto): Flow {
  const forwardOrder = new Map<string, number>();

  const v2 = dto.schema_version === 2;

  return {
    schemaVersion: dto.schema_version ?? 1,
    steps: dto.steps.map((step, index) => ({
      code: step.code,
      name: step.name,
      sortOrder: index + 1,
      formSchema: step.form_schema ?? null,
      subRequestTypes: step.sub_request_types ?? [],
      requiresApproval: step.requires_approval ?? false,
      assigneeRule: assigneeRuleOf(step.assignee_rule),
      slaHours: step.sla_hours ?? null,
      ...(v2
        ? {
            scopeStatus: step.scope_status,
            receiverRule: receiverRuleOf(step.receiver_rule),
            returnToStepCode: step.return_to_step ?? null,
            approvalLevels: step.approval_levels ?? null,
            requiredDocs: step.required_docs ?? [],
          }
        : {}),
    })),
    transitions: dto.transitions.map((exit) => {
      const key = `${exit.from_step}:${exit.backward ? 'b' : 'f'}`;
      const sortOrder = (forwardOrder.get(key) ?? 0) + 1;
      forwardOrder.set(key, sortOrder);
      return {
        fromStepCode: exit.from_step,
        toStepCode: exit.to_step,
        sortOrder,
        condition: exit.condition ?? null,
        backward: exit.backward ?? false,
      };
    }),
  };
}

/** Codes the runtime gives a meaning of its own; a step may not take them. */
const RESERVED_STEP_CODES = ['END'];

function assertReservedCodesUnused(dto: PublishFlowDto): void {
  const taken = dto.steps.filter((step) =>
    RESERVED_STEP_CODES.includes(step.code),
  );
  if (taken.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      'รหัสขั้นนี้สงวนไว้',
      taken.map((step) => ({
        field: `steps.${step.code}.code`,
        reason: step.code,
      })),
    );
  }
}

/** A stand-in so a step with documents but no form can reuse the documents check. */
const PLACEHOLDER_FORM = { properties: { _: { type: 'string' } } };

type StepColumns = Omit<
  Prisma.RequestFlowStepCreateWithoutFlowVersionInput,
  'code' | 'name' | 'sortOrder'
>;

function v1Columns(
  step: PublishFlowDto['steps'][number],
  parsed: Flow['steps'][number],
): StepColumns & { code: string; name: string; sortOrder: number } {
  return {
    code: parsed.code,
    name: parsed.name,
    sortOrder: parsed.sortOrder,
    formSchema: (step.form_schema as Prisma.InputJsonValue) ?? Prisma.DbNull,
    subRequestTypes: (step.sub_request_types ??
      []) as unknown as Prisma.InputJsonValue,
    requiresApproval: step.requires_approval ?? false,
    assigneeRule:
      (parsed.assigneeRule as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
    slaHours: step.sla_hours ?? null,
  };
}

/** The v2 columns; a v1 step keeps their defaults. */
function v2Columns(parsed: Flow['steps'][number]): StepColumns {
  if (!parsed.scopeStatus) return {};
  return {
    scopeStatus: scopeOf(parsed),
    receiverRule:
      (parsed.receiverRule as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
    returnToStepCode: parsed.returnToStepCode ?? null,
    approvalLevels:
      (parsed.approvalLevels as Prisma.InputJsonValue | null) ?? Prisma.DbNull,
    requiredDocs: parsed.requiredDocs ?? [],
  };
}

function receiverRuleOf(
  rule: PublishFlowDto['steps'][number]['receiver_rule'],
): ReceiverRule | null {
  if (!rule || rule.type === 'keep') return null;
  if (rule.type === 'receiver') return { type: 'receiver' };
  if (rule.type === 'step')
    return { type: 'step', stepCode: rule.step_code ?? '' };
  return { type: 'user', userId: rule.user_id ?? '' };
}

function assigneeRuleOf(
  rule: PublishFlowDto['steps'][number]['assignee_rule'],
): AssigneeRule | null {
  if (!rule || rule.type === 'keep') return null;
  if (rule.type === 'requester') return { type: 'requester' };
  return { type: 'user', userId: rule.user_id ?? '' };
}

/** Fields a condition may name: the requester's form and every step's form. */
export function knownFields(
  typeFormSchema: unknown,
  dto: PublishFlowDto,
): string[] {
  const fieldsOf = (schema: unknown) =>
    Object.keys(asRecord(asRecord(schema).properties));
  return [
    ...fieldsOf(typeFormSchema),
    ...dto.steps.flatMap((step) => fieldsOf(step.form_schema)),
  ];
}
