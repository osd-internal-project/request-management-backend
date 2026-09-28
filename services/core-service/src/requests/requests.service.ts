import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
  accessSubject,
  awaitingDecisionWhere,
  inApprovalRouteWhere,
  involvedRequestsWhere,
  visibleRequestsWhere,
  resolveTargetCompany,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma } from '@prisma/client';
import type { RequestStatus } from '@prisma/client';
import { assertTransition, OPEN_STATUSES } from './request-state-machine';
import {
  availableActions,
  hasAuthority,
  specFor,
  type RequestAction,
  type ActionableRequest,
} from './available-actions';
import { AttachmentRepository } from './attachment.repository';
import type { RequestListRow } from './request.repository';
import {
  assertKnownDocCode,
  assertKnownReturnReason,
  assertReceiverFormComplete,
  assertSubmittable,
  assertUsableFormSchema,
  assertUsableSubRequestTypes,
  missingRequiredSubRequests,
  receiverFor,
  type SubRequestTypeRule,
} from './submit-rules';
import {
  AFTER_WORK,
  BEFORE_WORK,
  stepExit,
  type ApprovalStage,
} from './approval-stage';
import {
  answersOf,
  asRecord,
  assertStepExitable,
  backwardOptions,
  firstStep,
  isLastStep,
  nextForward,
  stepOf,
  type Flow,
  type FlowStep,
} from './request-flow';
import { holderOf, isSubmitMove, roleOf, scopeOf } from './request-flow-v2';
import {
  RequestFlowService,
  type V2Request,
} from '../request-flow/request-flow.service';
import { toFlow } from '../request-flow/request-flow.repository';
import { nextRequestEventSeq } from './request-event-seq';
import { RunNumberClient } from '../run-number/run-number.client';
import {
  RequestDetail,
  RequestRepository,
  RequestWithType,
} from './request.repository';
import { RequestTypeRepository } from './request-type.repository';
import { RequestCommentRepository } from './request-comment.repository';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { SlaService } from '../sla/sla.service';
import { applyComputedFields } from './computed-fields';
import {
  assertSeverityGiven,
  readSeverityTargets,
  severityTargetProblems,
} from '../sla/severity';
import { ApprovalsService } from '../approvals/approvals.service';
import { NotificationsService } from '../notifications/notifications.service';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import {
  CancelRequestDto,
  CreateRequestDto,
  HoldRequestDto,
  ListRequestsQueryDto,
  AssignRequestDto,
  ResumeRequestDto,
  ReturnRequestDto,
  UpdateRequestDto,
  CreateIntegrationRequestDto,
  CreateRequestTypeDto,
  UpdateRequestTypeDto,
  AddCommentDto,
  CloseRequestDto,
  CompleteRequestDto,
  AdvanceRequestDto,
  StepFormDto,
} from './dto/request.dto';

/** What one node of the สายคำขอ panel needs — never the whole request. */
const REQUEST_TREE_SELECT = {
  id: true,
  requestNo: true,
  typeCode: true,
  status: true,
  parentRequestId: true,
  parentStepCode: true,
  ancestorIds: true,
  requester: { select: { displayName: true } },
  assignee: { select: { displayName: true } },
  receiver: { select: { displayName: true } },
} as const;

@Injectable()
export class RequestsService {
  constructor(
    private readonly requests: RequestRepository,
    private readonly attachments: AttachmentRepository,
    private readonly comments: RequestCommentRepository,
    private readonly types: RequestTypeRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly runNumbers: RunNumberClient,
    private readonly approvals: ApprovalsService,
    private readonly sla: SlaService,
    private readonly notifications: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly flows: RequestFlowService,
  ) {}

  // --- REQ-01: types are configuration -----------------------------------

  /**
   * The types a requester may raise — active, in their active company.
   *
   * REQ-01: an inactive type is one still being configured, so offering it on
   * the submit screen would produce requests nobody can route.
   */
  async listTypes(actor: Principal, parentRequestId?: string) {
    const ancestors = actor.orgUnitId
      ? await this.orgUnits.ancestorIdsOf(actor.orgUnitId)
      : [];
    // Raising a checklist sub request from its parent skips the group rule.
    const checklistCodes = parentRequestId
      ? (
          await this.checklistOf(await this.require(parentRequestId, actor))
        ).map((item) => item.code)
      : [];
    const [types, caseTargets] = await Promise.all([
      this.types.findMany({
        where: {
          active: true,
          companies: {
            some: { companyId: actor.activeCompanyId, active: true },
          },
          OR: [
            { eligibleUnits: { none: {} } },
            { eligibleUnits: { some: { orgUnitId: { in: ancestors } } } },
            { code: { in: checklistCodes } },
          ],
        },
        // The receiving team travels with the type so the submit screen can
        // both preselect it and name it. Reading the chart directly is not open
        // to a requester — `GET /admin/org-units` needs `admin.org.manage` — and
        // a page that fetches what its viewer cannot read is a guaranteed 403.
        include: {
          receiverOrgUnit: { select: { id: true, name: true } },
          receiverUser: { select: { id: true, displayName: true } },
          eligibleUnits: { select: { orgUnitId: true } },
        },
        orderBy: { code: 'asc' },
      }),
      this.sla.caseTargetsOf(actor.activeCompanyId),
    ]);

    // CD-67 — a case type tells the submit screen to ask for severity and
    // what each level promises.
    return types.map((type) => ({
      ...type,
      severityTargets: caseTargets.get(type.code) ?? null,
    }));
  }

  /**
   * The types an **administrator** may edit — inactive included.
   *
   * Screen A2 exists to finish a half-built type, and screen A1 needs the whole
   * catalog to offer a subject to publish a matrix for. Both were served by
   * `listTypes` and so could only ever see the active ones: OSD showed 19 of
   * its 40 types, and the other 21 were uneditable and unroutable at once.
   *
   * `companyId` is optional because A1 shows one company per tab, independent
   * of the header switcher. It goes through `resolveTargetCompany` so asking
   * for a company you do not belong to is refused, not answered (SCOPE-03).
   */
  async listAdminTypes(actor: Principal, companyId?: string) {
    const target = resolveTargetCompany(actor, companyId);

    const [types, caseTargets] = await Promise.all([
      this.types.findMany({
        where: { companies: { some: { companyId: target } } },
        // A2 edits both of these, so both travel with the row rather than being
        // fetched again per selection.
        include: {
          receiverOrgUnit: { select: { id: true, name: true } },
          receiverUser: { select: { id: true, displayName: true } },
          eligibleUnits: { select: { orgUnitId: true } },
        },
        // Active first so the ones in use lead A2's list; then by code.
        orderBy: [{ active: 'desc' }, { code: 'asc' }],
      }),
      this.sla.caseTargetsOf(target),
    ]);
    // CD-67 — A2 edits the case targets beside the type's SLA.
    return types.map((type) => ({
      ...type,
      severityTargets: caseTargets.get(type.code) ?? null,
    }));
  }

  /**
   * REQ-01 — authors a new request type from screen A2.
   *
   * Created **inactive** unless asked otherwise: a half-finished type that is
   * already offered on the submit screen produces requests nobody can route.
   * The admin turns it on once the form and documents are settled.
   *
   * Nothing here validates `form_schema` against JSON Schema itself — that is
   * `assertUsableFormSchema`'s job, and it checks the parts this system
   * actually reads rather than the whole standard.
   */
  async createType(dto: CreateRequestTypeDto, actor: Principal) {
    assertUsableFormSchema(dto.form_schema, dto.required_docs);
    // The receiver's form is optional, but an authored one is held to the same
    // rules — a required field that does not exist is as broken on one form as
    // on the other.
    if (dto.receiver_form_schema) {
      assertUsableFormSchema(dto.receiver_form_schema);
    }

    await this.assertSubRequestTypes(dto.code, dto.sub_request_types);

    const existing = await this.types.findFirst({
      where: { code: dto.code },
    });

    if (existing) {
      throw new AppError('CONFLICT', 'มีรหัสประเภทคำขอนี้อยู่แล้ว', [
        { field: 'code', reason: dto.code },
      ]);
    }

    const companyIds = (dto.company_ids ?? [actor.activeCompanyId]).map(
      (companyId) => resolveTargetCompany(actor, companyId),
    );

    if (dto.receiver_user_id) {
      await this.assertTypeReceiver(dto.receiver_user_id, actor);
    }

    const created = await this.transactions.execute(async (prisma) => {
      const type = await prisma.requestType.create({
        data: {
          code: dto.code,
          name: dto.name,
          receiverOrgUnitId: dto.receiver_org_unit_id ?? null,
          receiverUserId: dto.receiver_user_id ?? null,
          formSchema: dto.form_schema as Prisma.InputJsonValue,
          receiverFormSchema:
            (dto.receiver_form_schema as Prisma.InputJsonValue) ?? undefined,
          requiredDocs: (dto.required_docs ??
            []) as unknown as Prisma.InputJsonValue,
          returnReasonCodes: (dto.return_reason_codes ??
            []) as unknown as Prisma.InputJsonValue,
          subRequestTypes: (dto.sub_request_types ??
            []) as unknown as Prisma.InputJsonValue,
          approvalPolicy: (dto.approval_policy ?? {}) as Prisma.InputJsonValue,
          slaHours: dto.sla_hours ?? null,
          slaCoverage: dto.sla_coverage ?? 'H24X7',
          refRequired: dto.ref_required ?? false,
          active: dto.active ?? false,
          createdBy: actor.userId,
          updatedBy: actor.userId,
          /*
            The per-company row carries the same `active` as the type.

            `listTypes` filters on **`RequestTypeCompany.active`** while A2's
            switch writes `RequestType.active`, so a row created inactive here
            stayed invisible on the submit screen no matter what the admin did
            afterwards. Two flags, one switch — see `updateType`.
          */
          companies: {
            create: companyIds.map((companyId) => ({
              companyId,
              active: dto.active ?? false,
            })),
          },
          eligibleUnits: {
            create: (dto.eligible_org_unit_ids ?? []).map((orgUnitId) => ({
              orgUnitId,
            })),
          },
        },
      });

      await this.audit.record(
        {
          eventType: 'request.type.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'request_type',
          resourceId: type.id,
          after: { code: type.code, name: type.name, active: type.active },
        },
        { prisma },
      );

      // With the groups attached, for the same reason `updateType` re-reads:
      // A2 keeps whatever this returns, and a create that answers without them
      // shows a brand-new type as open to everybody.
      return prisma.requestType.findUniqueOrThrow({
        where: { id: type.id },
        include: {
          eligibleUnits: true,
          receiverUser: { select: { id: true, displayName: true } },
        },
      });
    });

    return created;
  }

  /**
   * REQ-01 — edits a type.
   *
   * **Only new requests see the change.** Every request carries the snapshot
   * it was raised under, so work already in the ladder keeps the form,
   * documents and SLA it started with (§7). That is why this updates the type
   * and nothing else — no backfill, deliberately.
   */
  async updateType(code: string, dto: UpdateRequestTypeDto, actor: Principal) {
    const before = await this.types.findFirst({ where: { code } });

    if (!before) {
      throw new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอที่ระบุ', [
        { field: 'code', reason: code },
      ]);
    }

    if (dto.form_schema) {
      assertUsableFormSchema(
        dto.form_schema,
        dto.required_docs ??
          (before.requiredDocs as unknown as { code: string; name: string }[]),
      );
    }

    if (dto.receiver_form_schema) {
      assertUsableFormSchema(dto.receiver_form_schema);
    }

    await this.assertSubRequestTypes(code, dto.sub_request_types);

    if (dto.receiver_user_id) {
      await this.assertTypeReceiver(dto.receiver_user_id, actor);
    }

    // CD-67 — checked before the transaction, like the form schema above.
    if (dto.severity_targets) {
      const problems = severityTargetProblems(dto.severity_targets);
      if (problems.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          `เป้าเวลาตามความรุนแรงไม่ถูกต้อง: ${problems[0]}`,
          problems.map((reason) => ({ field: 'severity_targets', reason })),
        );
      }
    }

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.requestType.update({
        where: { code },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.receiver_org_unit_id !== undefined
            ? { receiverOrgUnitId: dto.receiver_org_unit_id }
            : {}),
          ...(dto.receiver_user_id !== undefined
            ? { receiverUserId: dto.receiver_user_id }
            : {}),
          ...(dto.form_schema !== undefined
            ? { formSchema: dto.form_schema as Prisma.InputJsonValue }
            : {}),
          // `null` clears the receiver's form; absent leaves it alone. Prisma
          // wants `Prisma.DbNull` for the first, not a JavaScript null.
          ...(dto.receiver_form_schema !== undefined
            ? {
                receiverFormSchema:
                  dto.receiver_form_schema === null
                    ? Prisma.DbNull
                    : (dto.receiver_form_schema as Prisma.InputJsonValue),
              }
            : {}),
          ...(dto.required_docs !== undefined
            ? {
                requiredDocs:
                  dto.required_docs as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.return_reason_codes !== undefined
            ? {
                returnReasonCodes:
                  dto.return_reason_codes as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.sub_request_types !== undefined
            ? {
                subRequestTypes:
                  dto.sub_request_types as unknown as Prisma.InputJsonValue,
              }
            : {}),
          ...(dto.approval_policy !== undefined
            ? { approvalPolicy: dto.approval_policy as Prisma.InputJsonValue }
            : {}),
          ...(dto.sla_hours !== undefined ? { slaHours: dto.sla_hours } : {}),
          ...(dto.sla_coverage !== undefined
            ? { slaCoverage: dto.sla_coverage }
            : {}),
          ...(dto.ref_required !== undefined
            ? { refRequired: dto.ref_required }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: actor.userId,
        },
      });

      /*
        One switch, both flags.

        A type is usable on the submit screen only when `RequestType.active`
        **and** its `RequestTypeCompany.active` are both true — `listTypes`
        requires both. Nothing wrote the second one, so activating a type in A2
        left it invisible with no way to tell why: `MK-01` was activated on
        1 ก.ย. 2569 and never appeared. A2 is a per-company screen, so its
        switch means "usable in the company I am looking at", and writing only
        the company being administered is what keeps that honest for a type
        shared across several.
      */
      if (dto.active !== undefined) {
        await prisma.requestTypeCompany.updateMany({
          where: {
            requestTypeId: updated.id,
            companyId: actor.activeCompanyId,
          },
          data: { active: dto.active },
        });
      }

      /*
        Replaced wholesale rather than diffed. The screen sends the list it is
        showing, so a group the admin removed has to disappear — a merge would
        make removal impossible, which is the same bug the Keycloak mapping
        table was written to avoid.
      */
      let severityBefore: unknown;
      if (dto.severity_targets !== undefined) {
        severityBefore = await this.sla.setSeverityTargets(
          prisma,
          actor.activeCompanyId,
          updated,
          readSeverityTargets(dto.severity_targets),
          actor.userId,
        );
      }

      if (dto.eligible_org_unit_ids !== undefined) {
        await prisma.requestTypeOrgUnit.deleteMany({
          where: { requestTypeId: updated.id },
        });
        await prisma.requestTypeOrgUnit.createMany({
          data: dto.eligible_org_unit_ids.map((orgUnitId) => ({
            requestTypeId: updated.id,
            orgUnitId,
          })),
          skipDuplicates: true,
        });
      }

      await this.audit.record(
        {
          eventType: 'request.type.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'request_type',
          resourceId: updated.id,
          before: {
            name: before.name,
            active: before.active,
            slaHours: before.slaHours,
            formSchema: before.formSchema as Prisma.InputJsonValue,
            subRequestTypes: before.subRequestTypes as Prisma.InputJsonValue,
            ...(dto.severity_targets !== undefined
              ? { severityTargets: severityBefore as Prisma.InputJsonValue }
              : {}),
          },
          after: {
            name: updated.name,
            active: updated.active,
            slaHours: updated.slaHours,
            formSchema: updated.formSchema as Prisma.InputJsonValue,
            subRequestTypes: updated.subRequestTypes as Prisma.InputJsonValue,
            ...(dto.severity_targets !== undefined
              ? {
                  severityTargets: readSeverityTargets(
                    dto.severity_targets,
                  ) as unknown as Prisma.InputJsonValue,
                }
              : {}),
          },
        },
        { prisma },
      );

      /*
        Re-read with the groups attached, because A2 merges this response over
        the row it is holding. Returning the bare `update()` result meant
        `eligibleUnits` came back absent, the screen overwrote its own correct
        list with nothing, and the next save sent an empty list — silently
        reopening the type to every group. Found on 1 ก.ย. 2569 by saving the
        same type twice.
      */
      const saved = await prisma.requestType.findUniqueOrThrow({
        where: { id: updated.id },
        include: {
          eligibleUnits: true,
          receiverUser: { select: { id: true, displayName: true } },
        },
      });
      // CD-67 — merged over A2's row like the rest, so it must be current.
      const config = await prisma.slaConfig.findFirst({
        where: { companyId: actor.activeCompanyId, requestTypeCode: code },
        select: { severityTargets: true },
      });
      return {
        ...saved,
        severityTargets: readSeverityTargets(config?.severityTargets),
      };
    });
  }

  /**
   * Removes a request type outright — only while nothing was ever raised
   * against it.
   *
   * A type is configuration and a mistyped one should be removable rather than
   * left switched off for ever. What makes that safe is the refusal: a type
   * with requests behind it is history, and `Request.requestTypeId` does not
   * cascade, so deleting one would orphan every request of that type. Those
   * are turned off with `active: false` instead, which is what the screen
   * offers beside this.
   *
   * A published approval matrix for the subject blocks it too: the matrix
   * outlives the type it routes and would be left addressing nothing.
   */
  async deleteType(code: string, actor: Principal): Promise<void> {
    const before = await this.types.findFirst({ where: { code } });
    if (!before) {
      throw new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอที่ระบุ', [
        { field: 'code', reason: code },
      ]);
    }

    const [requests, matrices, parentTypes] = await Promise.all([
      this.requests.countWhere({ requestTypeId: before.id }),
      this.approvals.countMatricesFor(`request:${code}`),
      this.types.findMany({
        where: { subRequestTypes: { array_contains: [{ code }] } },
        select: { code: true },
      }),
    ]);

    const blockers = [
      requests && { field: 'requests', reason: `คำขอ ${requests}` },
      ...parentTypes.map((parent) => ({
        field: 'sub_request_types',
        reason: `เป็นคำขอย่อยของ ${parent.code}`,
      })),
      matrices && {
        field: 'approval_matrix',
        reason: `ตารางอำนาจอนุมัติ ${matrices}`,
      },
    ].filter((blocker): blocker is { field: string; reason: string } =>
      Boolean(blocker),
    );

    if (blockers.length) {
      throw new AppError(
        'REQ_TYPE_IN_USE',
        'ลบประเภทคำขอนี้ไม่ได้เพราะมีข้อมูลอ้างอยู่ — ปิดใช้งานแทนได้',
        blockers,
      );
    }

    await this.transactions.execute(async (prisma) => {
      // `RequestTypeCompany` and `RequestTypeOrgUnit` cascade with the row.
      await prisma.requestType.delete({ where: { id: before.id } });

      await this.audit.record(
        {
          eventType: 'request.type.deleted',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'request_type',
          resourceId: before.id,
          before: { code: before.code, name: before.name },
        },
        { prisma },
      );
    });
  }

  // --- REQ-01/REQ-03: draft, edit, submit --------------------------------

  async create(dto: CreateRequestDto, actor: Principal) {
    const type = await this.requireType(dto.type_code, actor.activeCompanyId);

    if (dto.parent_request_id) {
      await this.assertUsableParent(dto.parent_request_id, actor);
    }

    // The lineage, root first — written once here rather than walked on every
    // page view. See `Request.ancestorIds`.
    const ancestorIds = dto.parent_request_id
      ? await this.lineageOf(dto.parent_request_id)
      : [];
    // Which step of the parent's flow this child belongs to, for that step's checklist.
    const parentStepCode = dto.parent_request_id
      ? ((
          await this.requests.findUnique({
            where: { id: dto.parent_request_id },
            select: { currentStepCode: true },
          })
        )?.currentStepCode ?? null)
      : null;

    const receiverOrgUnitId = await this.resolveReceiverUnit(
      dto.receiver_org_unit_id,
      type.receiverOrgUnitId,
      actor.activeCompanyId,
    );
    // A v2 flow owns the whole path, so the request is on its first step from birth.
    const latest = await this.flows.latestFor(actor.activeCompanyId, type.id);
    const flowV2 = latest?.schemaVersion === 2 ? latest : null;

    return this.transactions.execute(async (prisma) => {
      const created = await this.requests.create(
        {
          data: {
            requestTypeId: type.id,
            typeCode: type.code,
            companyId: actor.activeCompanyId,
            requesterId: actor.userId,
            requesterOrgUnitId: actor.orgUnitId,
            // CD-80 — computed fields are the system's, never the caller's.
            formData: applyComputedFields(
              flowV2 ? firstStep(toFlow(flowV2)).formSchema : type.formSchema,
              dto.form_data ?? {},
            ) as Prisma.InputJsonValue,
            refType: dto.ref_type ?? null,
            refId: dto.ref_id ?? null,
            severity: dto.severity ?? null,
            receiverUserId: receiverFor(type, dto.receiver_user_id),
            // The type's `ทีมผู้รับ` is the starting point; the requester may send
            // it somewhere else. Copied onto the row rather than read back off the
            // type, so a later edit to the type cannot re-route this (REQ-01).
            receiverOrgUnitId,
            parentRequestId: dto.parent_request_id ?? null,
            parentStepCode,
            ancestorIds,
            flowVersionId: flowV2?.id ?? null,
            status: 'draft',
            createdBy: actor.userId,
          },
        },
        { prisma },
      );
      if (!flowV2) return created;

      await this.flows.enterV2(
        prisma,
        created,
        firstStep(toFlow(flowV2)),
        actor,
      );
      return prisma.request.findUniqueOrThrow({ where: { id: created.id } });
    });
  }

  /**
   * The team a request is being sent to, checked before it is stored.
   *
   * An explicit choice must name an active unit of the caller's own company;
   * anything else is refused rather than written, because an id that resolves
   * to nothing produces a request sitting in a queue that does not exist. When
   * the caller says nothing, the type's configured team stands — and that one
   * is *not* re-checked here: it was configured by an admin and may legitimately
   * have been deactivated since, which is a matter for screen A2, not a reason
   * to block someone from raising a request today.
   */
  private async resolveReceiverUnit(
    chosen: string | undefined,
    fallback: string | null,
    companyId: string,
  ): Promise<string | null> {
    if (chosen === undefined) return fallback;

    const unit = await this.orgUnits.findAssignable(chosen, companyId);

    if (!unit) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบทีมผู้รับที่ระบุ', [
        { field: 'receiver_org_unit_id', reason: chosen },
      ]);
    }

    return unit.id;
  }

  /**
   * A request may hang under another one, but not under itself.
   *
   * One piece of work commonly becomes several — `06_EXAMPLE` traces ten across
   * eight departments — and each child holds its parent open. A cycle would
   * hold every request in it open for ever, with no way for anyone to finish
   * any of them, so the chain is walked upward before the link is made.
   */
  /**
   * The parent's own lineage plus the parent — what a child inherits.
   *
   * Read from the parent rather than walked upward: the parent already holds
   * the whole chain, so a child costs one row however deep the tree is. Only
   * ever called after `assertUsableParent`, which is what guarantees the chain
   * has no cycle to inherit.
   */
  private async lineageOf(parentId: string): Promise<string[]> {
    const parent = await this.requests.findUnique({
      where: { id: parentId },
      select: { ancestorIds: true },
    });

    return [...(parent?.ancestorIds ?? []), parentId];
  }

  private async assertUsableParent(
    parentId: string,
    actor: Principal,
  ): Promise<void> {
    const parent = await this.require(parentId, actor);

    let current: string | null = parent.parentRequestId;
    const seen = new Set<string>([parent.id]);

    while (current) {
      if (seen.has(current)) break;
      seen.add(current);

      const ancestor = await this.requests.findWithType(current);
      current = ancestor?.parentRequestId ?? null;
    }

    // A brand-new request has no id yet, so it cannot be its own ancestor;
    // what this catches is a parent chain that is already circular.
    if (seen.size > 1 && seen.has(parent.id) && current !== null) {
      throw new AppError('VALIDATION_FAILED', 'คำขอต้นเรื่องวนกลับมาหาตัวเอง', [
        { field: 'parent_request_id', reason: parentId },
      ]);
    }
  }

  async update(id: string, dto: UpdateRequestDto, actor: Principal) {
    const found = await this.require(id, actor);

    // §7.1: only a draft or a returned request may be edited. Editing one
    // already in the ladder would change what approvers agreed to.
    if (!['draft', 'returned'].includes(found.status)) {
      throw new AppError(
        'REQ_STATE_INVALID',
        'แก้ไขได้เฉพาะคำขอที่เป็นร่างหรือถูกตีกลับ',
        [{ field: 'status', reason: found.status }],
      );
    }

    if (found.requesterId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'แก้ไขได้เฉพาะคำขอของตนเอง');
    }

    return this.requests.update({
      where: { id },
      data: {
        ...(dto.form_data
          ? {
              formData: applyComputedFields(
                found.requestType.formSchema,
                dto.form_data,
              ) as Prisma.InputJsonValue,
            }
          : {}),
        ...(dto.ref_type !== undefined ? { refType: dto.ref_type } : {}),
        ...(dto.ref_id !== undefined ? { refId: dto.ref_id } : {}),
        ...(dto.severity !== undefined ? { severity: dto.severity } : {}),
        ...(dto.receiver_user_id !== undefined
          ? {
              receiverUserId: receiverFor(
                found.requestType,
                dto.receiver_user_id,
              ),
            }
          : {}),
        ...(dto.receiver_org_unit_id !== undefined
          ? {
              receiverOrgUnitId: await this.resolveReceiverUnit(
                dto.receiver_org_unit_id,
                found.receiverOrgUnitId,
                actor.activeCompanyId,
              ),
            }
          : {}),
        updatedBy: actor.userId,
      },
    });
  }

  // --- REQ-03: documents -----------------------------------------------

  /**
   * Soft-deletes one attachment (rule 4: no hard deletes). The row survives so
   * the timeline can still show that a document was attached and withdrawn.
   */
  async removeAttachment(id: string, attachmentId: string, actor: Principal) {
    const found = await this.requireEditableOwn(id, actor, 'ลบเอกสาร');

    const attachment = await this.attachments.findOfRequest(
      found.id,
      attachmentId,
    );

    if (!attachment) {
      throw new AppError('NOT_FOUND', 'ไม่พบเอกสารแนบที่ระบุ');
    }

    const removed = await this.attachments.update({
      where: { id: attachment.id },
      data: { deletedAt: new Date() },
    });

    await this.audit.record({
      eventType: 'request.attachment.removed',
      companyId: found.companyId,
      ...auditActor(actor),
      resourceType: 'request_attachment',
      resourceId: attachment.id,
      before: {
        requestId: found.id,
        docCode: attachment.docCode,
        fileName: attachment.fileName,
      },
    });

    return removed;
  }

  // --- REQ-10: raised by another system -----------------------------------

  /**
   * Creates and submits in one call, on behalf of a named person.
   *
   * A service account has no supervisor, so `resolveChain` could find no
   * step 1 for it — the integration must say whom the request belongs to, and
   * the ladder is then computed from *that person's* place in the org chart
   * exactly as if they had used the screen.
   *
   * `source: SYSTEM` is what lets the timeline and REQ-09 tell machine-raised
   * work apart from a person's, which matters when the numbers are read.
   */
  async createFromIntegration(
    dto: CreateIntegrationRequestDto,
    actor: Principal,
    authorization: string,
  ) {
    const companyId = resolveTargetCompany(actor, dto.company_id);
    const type = await this.requireType(dto.type_code, companyId);

    const created = await this.requests.create({
      data: {
        requestTypeId: type.id,
        typeCode: type.code,
        companyId,
        requesterId: dto.requester_user_id,
        requesterOrgUnitId: null,
        formData: applyComputedFields(
          type.formSchema,
          dto.form_data ?? {},
        ) as Prisma.InputJsonValue,
        refType: dto.ref_type ?? null,
        refId: dto.ref_id ?? null,
        severity: dto.severity ?? null,
        receiverUserId: type.receiverUserId,
        status: 'draft',
        source: 'SYSTEM',
        createdBy: null,
      },
    });

    /**
     * Submitted as the service account but *for* the named requester.
     *
     * `submit` resolves the chain from `requesterId` on the row, not from the
     * caller, so the account's own (absent) org placement never enters into
     * it. If the person has no supervisor the submit fails with
     * `ORG_SUPERVISOR_MISSING` — the right answer, and the same one the screen
     * would give.
     */
    return this.submit(
      created.id,
      { ...actor, activeCompanyId: companyId },
      authorization,
    );
  }

  // --- the ticket: receive, assign, complete, close -----------------------

  /**
   * A submit needs somebody to hand the ticket to.
   *
   * Named by the requester rather than resolved from the type's receiving unit:
   * the source keeps a person in `ผู้รับผิดชอบที่แผนกปลายทาง`, and a queue
   * belonging to a whole department is a queue nobody is answerable for.
   */
  private async assertReceivable(request: RequestWithType): Promise<void> {
    if (!request.receiverUserId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุผู้รับเรื่องก่อนยื่นคำขอ',
        [{ field: 'receiver_user_id', reason: 'required' }],
      );
    }

    const receiver = await this.requests.findReceiver(
      request.receiverUserId,
      request.companyId,
    );

    // SCOPE-03: somebody outside this company is not a different answer from
    // somebody who does not exist.
    if (!receiver) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้รับเรื่องที่ระบุ', [
        { field: 'receiver_user_id', reason: request.receiverUserId },
      ]);
    }

    // A draft saved before the admin fixed the receiver must not slip past it.
    receiverFor(request.requestType, request.receiverUserId);
  }

  /** The parent's type checklist plus, on a flow, its current step's. */
  private async checklistOf(
    parent: RequestWithType,
  ): Promise<SubRequestTypeRule[]> {
    const typeLevel = subRequestTypesOf(parent);
    if (!parent.flowVersionId || !parent.currentStepCode) return typeLevel;

    const flow = await this.flows.load(parent.flowVersionId);
    return [
      ...typeLevel,
      ...stepOf(flow, parent.currentStepCode).subRequestTypes,
    ];
  }

  /** A2 — checks a sub-request checklist against the types that exist. */
  private async assertSubRequestTypes(
    ownCode: string,
    items: readonly SubRequestTypeRule[] | undefined,
  ): Promise<void> {
    if (!items?.length) return;

    const known = await this.types.findMany({
      where: { code: { in: items.map((item) => item.code) } },
      select: { code: true },
    });

    assertUsableSubRequestTypes(
      ownCode,
      items,
      known.map((type) => type.code),
    );
  }

  /** The type's checklist with each name attached, as the snapshot keeps it. */
  private async namedSubRequestTypes(
    checklist: unknown,
  ): Promise<{ code: string; name: string; required: boolean }[]> {
    const items = asSubRequestTypes(checklist);
    if (!items.length) return [];

    const types = await this.types.findMany({
      where: { code: { in: items.map((item) => item.code) } },
      select: { code: true, name: true },
    });

    return items.map((item) => ({
      code: item.code,
      name: types.find((type) => type.code === item.code)?.name ?? item.code,
      required: item.required,
    }));
  }

  /** Blocks `complete` while a required sub request from the checklist is missing. */
  private async assertRequiredSubRequests(
    request: RequestWithType,
  ): Promise<void> {
    const items = subRequestTypesOf(request);
    if (!items.some((item) => item.required)) return;

    const children = await this.requests.findChildTypes(request.id);
    const missing = missingRequiredSubRequests(items, children);

    if (missing.length) {
      throw new AppError(
        'REQ_SUB_REQUEST_MISSING',
        'ยังไม่ได้สร้างคำขอย่อยที่บังคับ — ต้องสร้างให้ครบก่อน',
        missing.map((code) => ({ field: 'sub_request_types', reason: code })),
      );
    }
  }

  /** A2 — the fixed receiver must be a member of the company being administered. */
  private async assertTypeReceiver(
    userId: string,
    actor: Principal,
  ): Promise<void> {
    const receiver = await this.requests.findReceiver(
      userId,
      actor.activeCompanyId,
    );

    if (!receiver) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบผู้รับเรื่องที่ระบุ', [
        { field: 'receiver_user_id', reason: userId },
      ]);
    }
  }

  /**
   * The receiver accepts the ticket — `submitted → in_progress`.
   *
   * This is where the working clock starts for real. The source draws the line
   * in the same place: *"แผนกปลายทางรับเรื่องแล้ว — เริ่มนับเวลาทำงานจริง"*, and
   * `CLOCK_PAUSED_IN` holds `submitted` for that reason.
   *
   * Only the named receiver may accept. Anyone else doing it would leave the
   * ticket recorded as somebody's while sitting in someone else's hands.
   */
  async receive(id: string, actor: Principal) {
    const before = await this.require(id, actor);

    if (before.receiverUserId !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'รับเรื่องได้เฉพาะผู้ที่ถูกระบุเป็นผู้รับเรื่อง',
      );
    }

    const flowV2 = await this.flowV2Of(before);
    if (flowV2) return this.receiveV2(before, flowV2, actor);

    assertTransition(before.status, 'in_progress');

    // A re-receive after a return resumes the step the work was on.
    const flow =
      before.flowVersionId && !before.currentStepCode
        ? await this.flows.load(before.flowVersionId)
        : null;

    return this.transactions.execute(async (prisma) => {
      const now = new Date();

      const updated = await prisma.request.update({
        where: { id },
        data: {
          status: 'in_progress',
          // Whoever accepts is doing the work until they hand it on.
          assigneeUserId: before.assigneeUserId ?? actor.userId,
          updatedBy: actor.userId,
        },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'RECEIVED',
        actor,
        fromStatus: before.status,
        toStatus: 'in_progress',
      });

      // The clock was paused through `submitted`; accepting is what starts it.
      await this.sla.resume(prisma, id, now);
      // CD-67 — accepting is the receiving side's first response.
      await this.sla.markResponded(id, now, prisma);

      if (flow) {
        await this.flows.enter(prisma, before, firstStep(flow), actor);
      }

      await this.audit.record(
        {
          eventType: 'request.received',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'in_progress', assigneeUserId: actor.userId },
        },
        { prisma },
      );

      return updated;
    });
  }

  /**
   * Hands the work to someone else without changing what state it is in.
   *
   * The source records `ASSIGNED` and `HANDOVER` as events in their own right —
   * who accepted a ticket and who finished it are often different people, and
   * a timeline that overwrites the first with the second loses the fact that it
   * changed hands at all.
   */
  async assign(id: string, dto: AssignRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

    // Handing work on is the prerogative of whoever is holding it.
    this.assertMayAct(before, actor, 'assign', 'มอบหมายงาน');

    if (!OPEN_STATUSES.includes(before.status)) {
      throw new AppError('REQ_STATE_INVALID', 'มอบหมายงานที่ปิดไปแล้วไม่ได้', [
        { field: 'status', reason: before.status },
      ]);
    }

    const assignee = await this.requests.findReceiver(
      dto.assignee_user_id,
      before.companyId,
    );

    if (!assignee) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้รับผิดชอบที่ระบุ', [
        { field: 'assignee_user_id', reason: dto.assignee_user_id },
      ]);
    }

    if (before.flowVersion?.schemaVersion === 2) {
      return this.handOnV2(before, dto, actor);
    }

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: { assigneeUserId: dto.assignee_user_id, updatedBy: actor.userId },
      });

      // SLA counts from the first assignment; no-op when already running.
      if (before.status === 'submitted' || before.status === 'in_progress') {
        await this.sla.resume(prisma, id);
      }
      // CD-67 — handing it to someone counts as the receiving side responding.
      await this.sla.markResponded(id, new Date(), prisma);

      await this.recordEvent(prisma, {
        requestId: id,
        // `HANDOVER` when it was already somebody's, `ASSIGNED` the first time.
        type: before.assigneeUserId ? 'HANDOVER' : 'ASSIGNED',
        actor,
        data: {
          from: before.assigneeUserId,
          to: dto.assignee_user_id,
          note: dto.note ?? null,
        },
      });

      await this.audit.record(
        {
          eventType: 'request.assigned',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { assigneeUserId: before.assigneeUserId },
          after: { assigneeUserId: dto.assignee_user_id },
        },
        { prisma },
      );

      return updated;
    });
  }

  /**
   * The requester accepts the result — `approved → closed`.
   *
   * Only the person who asked can close: `completed` is the doing team saying
   * the work is done, and `closed` is the asking side agreeing. Letting the
   * same side do both would make the second signature meaningless.
   */
  async close(id: string, actor: Principal, dto: CloseRequestDto = {}) {
    const before = await this.require(id, actor);

    if (before.requesterId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'ปิดคำขอได้เฉพาะผู้ยื่นคำขอ');
    }
    assertNotFlowV2(before);

    assertTransition(before.status, 'closed');

    /*
      The same guard `complete` carries, because closing is the other way a
      chain ends and it was the unguarded one.

      `complete` checks once, at the moment the doing team finishes. A child
      raised *after* that — which is exactly when a sub-request tends to appear,
      while the parent waits on approval — met no check at all, and the parent
      closed over live work underneath it. Found by walking a two-level chain on
      1 ก.ย. 2569.
    */
    await this.assertNoOpenChildren(id);

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: {
          status: 'closed',
          closedAt: new Date(),
          updatedBy: actor.userId,
        },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.closed',
        actor,
        fromStatus: before.status,
        toStatus: 'closed',
        ...(dto.note ? { data: { note: dto.note } } : {}),
      });

      await this.audit.record(
        {
          eventType: 'request.closed',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'closed' },
        },
        { prisma },
      );

      return updated;
    });
  }

  // --- REQ-08: closing the work ------------------------------------------

  /**
   * The doing team says the work is finished — and the ticket branches.
   *
   * The receiving team completes, not the requester: REQ-08 tracks work across
   * teams, and letting the person who raised it declare completion would make
   * the SLA measure their patience rather than the team's response.
   *
   * Two things then decide what happens next, in this order:
   *
   * 1. **Open children block it.** A request commonly breaks into others across
   *    departments; finishing the parent while they run would say the work was
   *    done when part of it had not started.
   * 2. **A published matrix means the result gets checked.** Types that have
   *    one go to `pending_approval`; the eighteen Pattern C types that have
   *    none are accepted as delivered. This is the only place that branch is
   *    decided — nothing else may set either status.
   */
  async complete(
    id: string,
    actor: Principal,
    authorization: string,
    dto: CompleteRequestDto = {},
  ) {
    const before = await this.require(id, actor);

    // The work is finished by whoever did it. An approver signs it off later;
    // a bystander does neither.
    this.assertMayAct(before, actor, 'complete', 'แจ้งงานเสร็จ');
    assertNotFlowV2(before);

    assertTransition(before.status, 'completed');

    await this.assertNoOpenChildren(id);
    await this.assertRequiredSubRequests(before);

    const flow = before.flowVersionId
      ? await this.flows.load(before.flowVersionId)
      : null;
    if (flow) await this.assertCurrentStepFinishes(before, flow);

    /*
      H2.2 ข้อ 3 — the receiver's own form, checked here rather than at submit.

      Read from the **snapshot** where there is one, for the same reason every
      other rule does: a type edited while this request was being worked on
      must not change what finishing it requires (REQ-01).
    */
    const receiverSchema =
      snapshotOf(before).receiverFormSchema ??
      before.requestType.receiverFormSchema;

    const receiverFormData = {
      ...((before.receiverFormData as Record<string, unknown>) ?? {}),
      ...(dto.receiver_form_data ?? {}),
    };

    assertReceiverFormComplete(receiverSchema, receiverFormData);

    const updatedRequest = await this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: {
          status: 'completed',
          completedAt: new Date(),
          receiverFormData: receiverFormData as Prisma.InputJsonValue,
          updatedBy: actor.userId,
        },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.completed',
        actor,
        fromStatus: before.status,
        toStatus: 'completed',
      });

      if (flow && before.currentStepCode) {
        await this.flows.leave(
          prisma,
          id,
          before.currentStepCode,
          'completed',
          actor,
        );
      }

      // Paused, not stopped: a send-back after the check resumes it, and
      // acceptance stops it with met/breached judged from the time used.
      await this.sla.pause(prisma, id);

      await this.audit.record(
        {
          eventType: 'request.completed',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'completed' },
        },
        { prisma },
      );

      return updated;
    });

    // §11.8 — after the commit, so a subscriber reads the state it was told of.
    await this.domainEvents.emit({
      name: DOMAIN_EVENTS.requestCompleted,
      payload: {
        company_id: before.companyId,
        request_id: id,
        request_no: before.requestNo,
        type_code: before.typeCode,
        requester_id: before.requesterId,
      },
    });

    return this.routeForApproval(
      before,
      actor,
      authorization,
      updatedRequest,
      AFTER_WORK,
    );
  }

  /**
   * After completion: check the result, or accept it as delivered.
   *
   * A published matrix for `(company, request:<TYPE>)` is the whole test.
   * Eighteen of OSD's forty types are Pattern C — *"คำขอนี้ไม่มีชั้นอนุมัติ"* —
   * and for those the absence of a matrix is the configuration, not a gap.
   *
   * The case is opened outside the transaction because the chain resolves
   * across a service boundary; if that fails the request stays `completed`,
   * which is recoverable — the work is done and the check can be retried —
   * unlike a request marked checked that nobody ever checked.
   */
  private async routeForApproval(
    before: RequestWithType,
    actor: Principal,
    authorization: string,
    completed: { id: string },
    stage: ApprovalStage = AFTER_WORK,
  ) {
    const id = completed.id;

    const hasMatrix = await this.approvals.hasPublishedMatrix(
      stage.subjectOf(before.typeCode),
      before.companyId,
      authorization,
    );

    if (!hasMatrix) {
      return this.acceptWithoutCheck(before, actor, completed, stage);
    }

    const approvalCase = await this.approvals.openCase(
      {
        subject_type: stage.subjectOf(before.typeCode),
        subject_id: before.requestNo ?? id,
        requester_user_id: before.requesterId,
        /*
          Whose chart the `หัวหน้าทีม` levels climb.

          Before the work it is the requester's — they are asking permission of
          their own line of management. After it, it is whoever actually did
          the work, because that is whose result is being checked: a request
          raised by Sales and delivered by Marketing was routing to Sales'
          managers to sign off Marketing's output.
        */
        chart_owner_user_id: stage.chartOwnerOf(before),
        // Step answers too, so a level condition can read what a step recorded.
        payload: answersOf(before.formData, before.stepFormData),
      },
      actor,
      authorization,
    );

    // Every level skipped by its condition: the case is on record, the work moves on.
    if (approvalCase.status !== 'pending') {
      await this.transactions.execute((prisma) =>
        prisma.approvalCase.update({
          where: { id: approvalCase.id },
          data: { requestId: id },
        }),
      );
      return this.acceptWithoutCheck(
        before,
        actor,
        completed,
        stage,
        'all_levels_skipped',
      );
    }

    return this.transactions.execute(async (prisma) => {
      await prisma.approvalCase.update({
        where: { id: approvalCase.id },
        data: { requestId: id },
      });

      const updated = await prisma.request.update({
        where: { id },
        data: { status: 'pending_approval', updatedBy: actor.userId },
      });

      // Waiting on a step's exit approval is the approver's time, not the team's.
      if (stage.name === 'step') await this.sla.pause(prisma, id);

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.routed',
        actor,
        fromStatus: before.status,
        toStatus: 'pending_approval',
        data: {
          caseId: approvalCase.id,
          steps: approvalCase.steps.length,
          stage: stage.name,
        },
      });

      return updated;
    });
  }

  /**
   * Nothing to check at this stage (no ladder, or every level skipped): the
   * pre-work and step stages hand on; after the work, the result is accepted.
   */
  private async acceptWithoutCheck(
    before: RequestWithType,
    actor: Principal,
    completed: { id: string },
    stage: ApprovalStage,
    reason: 'no_approval_matrix' | 'all_levels_skipped' = 'no_approval_matrix',
  ) {
    const id = completed.id;
    // Nothing to check at this stage. The pre-work stage simply hands the
    // ticket on, which is what every type without a `:pre` matrix does —
    // that is, all of them until somebody publishes one.
    if (!stage.recordsAcceptance) return completed;

    const accepted = await this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: { status: 'approved', updatedBy: actor.userId },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        // No approver was involved — the type has no matrix, so accepting
        // the delivered result is the system's own step, not a person's.
        type: 'request.accepted',
        actor,
        fromStatus: 'completed',
        toStatus: 'approved',
        data: { reason },
      });

      await this.sla.stop(prisma, id, 'met');

      return updated;
    });

    // §11.8 — after the commit. Same event an approver's final sign-off
    // emits, so a consumer waiting on the outcome need not know that this
    // type has no matrix.
    await this.domainEvents.emit({
      name: DOMAIN_EVENTS.requestApproved,
      payload: {
        company_id: before.companyId,
        request_id: id,
        request_no: before.requestNo,
        type_code: before.typeCode,
        requester_id: before.requesterId,
      },
    });

    return accepted;
  }

  /**
   * A parent may not be completed while a child is still running.
   *
   * Only direct children are counted. Each of those is held by this same rule,
   * so a grandchild keeps its own parent open and that parent keeps this one
   * open — walking the whole tree on every completion would re-derive what the
   * rule already guarantees.
   *
   * The open request numbers travel in the error: "finish the children first"
   * is not actionable without saying which.
   */
  private async assertNoOpenChildren(id: string): Promise<void> {
    const open = await this.requests.findOpenChildren(id, OPEN_STATUSES);

    if (open.length) {
      throw new AppError(
        'REQ_CHILDREN_OPEN',
        'ยังมีคำขอย่อยที่ยังไม่ปิด — ต้องปิดคำขอย่อยให้ครบก่อน',
        open.map((child) => ({
          field: 'children',
          reason: child.requestNo ?? child.id,
        })),
      );
    }
  }

  /**
   * The gate every attachment write shares: the request exists, is visible to
   * this caller, is still editable, and is theirs.
   */
  async requireEditableOwn(id: string, actor: Principal, action: string) {
    const found = await this.require(id, actor);

    if (!['draft', 'returned'].includes(found.status)) {
      throw new AppError(
        'REQ_STATE_INVALID',
        `${action}ได้เฉพาะคำขอที่เป็นร่างหรือถูกตีกลับ`,
        [{ field: 'status', reason: found.status }],
      );
    }

    if (found.requesterId !== actor.userId) {
      throw new AppError('FORBIDDEN', `${action}ได้เฉพาะคำขอของตนเอง`);
    }

    return found;
  }

  /**
   * REQ-02/03 + SUP-01 — the submit.
   *
   * Everything below happens in **one transaction** on purpose: a request that
   * holds a number but no clock never escalates, and that failure is invisible
   * in a system whose job is making sure nothing is silently stuck.
   *
   * **No approval chain is resolved here any more.** Approval is a check on
   * finished work, so it is `complete` that opens a case. What submit needs
   * instead is a *receiver* — the person this ticket is being handed to — and
   * that is what it refuses without.
   */
  // `authorization` is kept in the signature although submit no longer calls
  // another service: `createForIntegration` submits on someone's behalf and
  // passes its own token through, and dropping the parameter would move that
  // decision into every caller.
  async submit(id: string, actor: Principal, authorization: string) {
    const before = await this.require(id, actor);

    // v2: submitting is advancing off the requester's step.
    const flowV2 = await this.flowV2Of(before);
    if (flowV2) return this.advanceV2(before, flowV2, null, actor);

    if (before.requesterId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'ยื่นได้เฉพาะคำขอของตนเอง');
    }

    assertTransition(before.status, 'submitted');

    // REQ-03 first: nothing is reserved until the request is actually valid,
    // so a rejected submit leaves no gap in the number sequence.
    assertSubmittable({
      formSchema: before.requestType.formSchema,
      requiredDocs: before.requestType.requiredDocs,
      formData: before.formData as Record<string, unknown>,
      refRequired: before.requestType.refRequired,
      refId: before.refId,
      attachmentCodes: before.attachments
        .filter((attachment) => !attachment.deletedAt)
        .map((attachment) => attachment.docCode ?? ''),
    });

    // CD-67 — a case type must carry a severity before its clocks start.
    if (!before.severity) {
      assertSeverityGiven(
        await this.sla.isCaseType(before.companyId, before.typeCode),
        before.severity,
      );
    }

    /**
     * A ticket has to be handed to somebody.
     *
     * Checked before anything is written, for the same reason routing used to
     * be: a request that consumed a number and started its clock but sits in
     * no one's queue is invisible, and invisible is the failure mode this
     * whole system exists to prevent.
     */
    await this.assertReceivable(before);

    // A :pre ladder that cannot resolve must fail here, before the number and clock.
    await this.approvals.assertRoutable({
      subjectType: BEFORE_WORK.subjectOf(before.typeCode),
      requesterId: before.requesterId,
      chartOwnerId: BEFORE_WORK.chartOwnerOf(before),
      companyId: before.companyId,
      authorization,
    });

    const requestNo = await this.requestNoFor(before);
    const typeSnapshot = await this.typeSnapshotFor(before);

    // Running work keeps the flow it was submitted under; a resubmit keeps its pin.
    // A draft raised before a v2 flow was published stays on the fixed lifecycle.
    const latest = before.flowVersionId
      ? null
      : await this.flows.latestFor(before.companyId, before.requestTypeId);
    const flow = latest?.schemaVersion === 1 ? latest : null;

    const submitted = await this.transactions.execute(async (prisma) => {
      const now = new Date();

      const updated = await prisma.request.update({
        where: { id },
        data: {
          requestNo,
          status: 'submitted',
          submittedAt: now,
          ...(flow ? { flowVersionId: flow.id } : {}),
          // §7: running work keeps the rules it started under.
          typeSnapshot,
          updatedBy: actor.userId,
        },
        include: { requestType: true, attachments: true },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.submitted',
        actor,
        fromStatus: before.status,
        toStatus: 'submitted',
        data: { requestNo },
      });

      // SUP-01: the clock is created paused and runs from the first assignment;
      // a resubmit leaves it paused until the work is received again.
      if (!before.requestNo) {
        await this.sla.start(prisma, updated, now);
      }

      await this.audit.record(
        {
          eventType: 'request.submitted',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'submitted', requestNo },
        },
        { prisma },
      );

      return updated;
    });

    // §11.8 — published after the commit, so a subscriber that reads the
    // database sees the state it was told about.
    await this.domainEvents.emit({
      name: before.requestNo
        ? DOMAIN_EVENTS.requestResubmitted
        : DOMAIN_EVENTS.requestSubmitted,
      payload: {
        company_id: before.companyId,
        request_id: id,
        request_no: submitted.requestNo,
        type_code: before.typeCode,
        requester_id: before.requesterId,
      },
    });

    /*
      §7.1's order, for a type that asks for it.

      A type with a published `request:<CODE>:pre` ladder is approved *before*
      its receiver ever sees it — permission to ask. Without one, `submit`
      leaves the request at `submitted` exactly as it always has, which is
      every type that exists today.

      After the number, the snapshot and the clock, all of which happen on
      submit whichever way this branches: REQ-02 issues a number once, and an
      approved pre-work case moves the status without touching it.
    */
    await this.routeForApproval(
      before,
      actor,
      authorization,
      submitted,
      BEFORE_WORK,
    );

    return this.requests.findDetail(id) as Promise<RequestDetail>;
  }

  /** REQ-02: issued once, at the first submit; a resubmit keeps its number. */
  private async requestNoFor(before: RequestWithType): Promise<string> {
    // Outside the transaction and after every assert — docs/run-number.md.
    return (
      before.requestNo ??
      (await this.runNumbers.issueUnused(
        {
          companyId: before.companyId,
          docType: 'REQUEST',
          scopeKey: before.typeCode,
          master: { 'M:REQUEST_TYPE': before.typeCode },
          idempotencyKey: `run-number:REQUEST:${before.id}:${before.typeCode}`,
        },
        (code) => this.requests.requestNoTaken(code),
      ))
    );
  }

  /** §7: the rules a request keeps once submitted, whatever later edits do to its type. */
  private async typeSnapshotFor(before: RequestWithType) {
    const subRequestTypes = await this.namedSubRequestTypes(
      before.requestType.subRequestTypes,
    );
    return {
      code: before.requestType.code,
      name: before.requestType.name,
      formSchema: before.requestType.formSchema,
      // The receiver's form is snapshotted for the same reason as the
      // requester's: a type edited mid-flight must not change what
      // finishing this request requires (REQ-01).
      receiverFormSchema: before.requestType.receiverFormSchema,
      requiredDocs: before.requestType.requiredDocs,
      returnReasonCodes: before.requestType.returnReasonCodes,
      approvalPolicy: before.requestType.approvalPolicy,
      slaHours: before.requestType.slaHours,
      // What the type suggested as ทีมผู้รับ at this moment. The request
      // carries its own `receiverOrgUnitId`; keeping the default beside
      // it is what makes "did the requester send this somewhere else?"
      // answerable later, after the type has been edited.
      receiverOrgUnitId: before.requestType.receiverOrgUnitId,
      subRequestTypes,
    };
  }

  // --- REQ-04/05: return and cancel --------------------------------------

  /** REQ-04: bounced back to the requester, with a countable reason. */
  async returnToRequester(id: string, dto: ReturnRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

    /*
      Added 3 ก.ย. 2569, and it is a **narrowing**: until now this endpoint
      checked only `request.return` and that the request was in the caller's
      company, so any holder of that permission could send back anybody's
      ticket. Every neighbouring verb — receive, hold, complete, cancel — has
      always asked who you are to this request; this one was missed.

      Found while giving the external API a list of actions it may offer: the
      list is built from these same rules, and advertising `return` to every
      permission holder would have spread the hole to the chatbot.
    */
    this.assertMayAct(before, actor, 'return', 'ตีกลับคำขอ');
    assertNotFlowV2(before);

    assertKnownReturnReason(
      snapshotOf(before).returnReasonCodes ??
        before.requestType.returnReasonCodes,
      dto.reason_code,
    );
    assertTransition(before.status, 'returned');

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: { status: 'returned', updatedBy: actor.userId },
      });

      const event = await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.returned',
        actor,
        fromStatus: before.status,
        toStatus: 'returned',
        data: { reasonCode: dto.reason_code, note: dto.note ?? null },
      });

      if (before.status === 'pending_approval') {
        await this.approvals.closeOpenCases(prisma, id, 'voided', actor);
      }

      await prisma.requestReturnReason.create({
        data: {
          requestId: id,
          eventId: event.id,
          code: dto.reason_code,
          note: dto.note ?? null,
          createdBy: actor.userId,
        },
      });

      // SUP-01: the clock stops while the ball is in the requester's court —
      // time they spend fixing it is not time the approver kept them waiting.
      await this.sla.pause(prisma, id);

      await this.audit.record(
        {
          eventType: 'request.returned',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'returned', reasonCode: dto.reason_code },
        },
        { prisma },
      );

      return updated;
    });
  }

  /** REQ-05: cancelled with a reason, never deleted. */
  async cancel(id: string, dto: CancelRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

    /*
      The requester withdraws their own ask; a group head can withdraw one
      raised into or by their part of the chart. Nobody else — a cancelled
      request is one that will never be done, and that is not a bystander's
      call to make.
    */
    this.assertMayAct(before, actor, 'cancel', 'ยกเลิกคำขอ');

    // The requester, or anyone senior enough to see it — scope already
    // answered that by letting them load it.
    assertTransition(before.status, 'cancelled');

    const updatedRequest = await this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelReason: dto.reason,
          updatedBy: actor.userId,
        },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.cancelled',
        actor,
        fromStatus: before.status,
        toStatus: 'cancelled',
        data: { reason: dto.reason },
      });

      if (before.status === 'pending_approval') {
        await this.approvals.closeOpenCases(prisma, id, 'cancelled', actor);
      }

      if (before.currentStepCode) {
        await this.flows.leave(
          prisma,
          id,
          before.currentStepCode,
          'cancelled',
          actor,
        );
      }

      await this.sla.stop(prisma, id, 'cancelled');

      await this.audit.record(
        {
          eventType: 'request.cancelled',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'cancelled', reason: dto.reason },
        },
        { prisma },
      );

      return updated;
    });

    if (before.status === 'pending_approval') {
      await this.notifications.approvalWithdrawn(id, before.companyId);
    }

    // §11.8 — after the commit, so a subscriber reads the state it was told of.
    await this.domainEvents.emit({
      name: DOMAIN_EVENTS.requestCancelled,
      payload: {
        company_id: before.companyId,
        request_id: id,
        request_no: before.requestNo,
        type_code: before.typeCode,
        requester_id: before.requesterId,
      },
    });

    return updatedRequest;
  }

  // --- Configurable flow: steps inside in_progress ------------------------

  /**
   * Moves the work to `to_step`: forward along the exit its answers select
   * (through the step's exit ladder when it has one), or back along a backward exit.
   */
  async advance(
    id: string,
    dto: AdvanceRequestDto,
    actor: Principal,
    authorization: string,
  ) {
    const before = await this.require(id, actor);

    const flowV2 = await this.flowV2Of(before);
    if (flowV2) return this.advanceV2(before, flowV2, dto.to_step, actor);

    this.assertMayAct(before, actor, 'advance', 'ไปขั้นถัดไป');

    if (before.status !== 'in_progress' || !before.flowVersionId) {
      throw new AppError(
        'REQ_STEP_INVALID',
        'คำขอนี้ไม่ได้อยู่ในขั้นตอนที่เดินต่อได้',
      );
    }

    const flow = await this.flows.load(before.flowVersionId);
    const current = stepOf(flow, before.currentStepCode);

    if (backwardOptions(flow, current.code).includes(dto.to_step)) {
      await this.transactions.execute((prisma) =>
        this.flows.move(
          prisma,
          before,
          flow,
          current.code,
          dto.to_step,
          'backward',
          actor,
        ),
      );
      return this.findOne(id, actor);
    }

    const next = nextForward(
      flow,
      current.code,
      answersOf(before.formData, before.stepFormData),
    );
    if (!next || next !== dto.to_step) {
      throw new AppError(
        'REQ_STEP_INVALID',
        isLastStep(flow, current.code)
          ? 'ขั้นสุดท้าย — ใช้ "ทำเสร็จแล้ว"'
          : 'ไปขั้นนี้จากขั้นปัจจุบันไม่ได้',
        [{ field: 'to_step', reason: next ?? '' }],
      );
    }

    await this.assertStepLeavable(before, flow);

    const stage = stepExit(current.code);
    const needsApproval =
      current.requiresApproval &&
      (await this.approvals.hasPublishedMatrix(
        stage.subjectOf(before.typeCode),
        before.companyId,
        authorization,
      ));

    // A ladder whose every level was skipped leaves the request in progress: move on.
    const routed = needsApproval
      ? await this.routeForApproval(before, actor, authorization, before, stage)
      : null;
    if (routed && 'status' in routed && routed.status === 'pending_approval') {
      return this.findOne(id, actor);
    }

    await this.transactions.execute((prisma) =>
      this.flows.move(
        prisma,
        before,
        flow,
        current.code,
        next,
        'forward',
        actor,
      ),
    );

    return this.findOne(id, actor);
  }

  /** Saves draft answers to the current step's form; nothing is checked until the step is left. */
  async saveStepForm(id: string, dto: StepFormDto, actor: Principal) {
    const before = await this.require(id, actor);
    this.assertMayAct(before, actor, 'advance', 'บันทึกฟอร์มขั้นนี้');

    const flowV2 = await this.flowV2Of(before);
    if (flowV2) return this.saveStepFormV2(before, flowV2, dto, actor);

    if (before.status !== 'in_progress' || !before.currentStepCode) {
      throw new AppError(
        'REQ_STEP_INVALID',
        'คำขอนี้ไม่ได้อยู่ในขั้นตอนที่แก้ฟอร์มได้',
      );
    }

    const stepFormData = asRecord(before.stepFormData);
    const merged = {
      ...stepFormData,
      [before.currentStepCode]: {
        ...asRecord(stepFormData[before.currentStepCode]),
        ...dto.data,
      },
    };

    await this.transactions.execute(async (prisma) => {
      await prisma.request.update({
        where: { id },
        data: {
          stepFormData: merged as Prisma.InputJsonValue,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'request.step_form.saved',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          after: { step: before.currentStepCode },
        },
        { prisma },
      );
    });

    return this.findOne(id, actor);
  }

  /** The current step's exit rules, against its answers and the children raised in it. */
  private async assertStepLeavable(request: RequestWithType, flow: Flow) {
    const step = stepOf(flow, request.currentStepCode);
    const children = await this.requests.findChildTypes(request.id);
    assertStepExitable(
      step,
      asRecord(asRecord(request.stepFormData)[step.code]),
      children,
    );
  }

  /** `complete` on a flow request finishes only from a last step whose exit rules hold. */
  private async assertCurrentStepFinishes(
    request: RequestWithType,
    flow: Flow,
  ) {
    if (
      !request.currentStepCode ||
      !isLastStep(flow, request.currentStepCode)
    ) {
      throw new AppError(
        'REQ_STEP_INVALID',
        'ยังไม่ถึงขั้นสุดท้าย — ไปขั้นถัดไปก่อน',
        [{ field: 'step', reason: request.currentStepCode ?? '' }],
      );
    }
    await this.assertStepLeavable(request, flow);
  }

  // --- Flow v2: steps own the whole path ----------------------------------

  /** The pinned flow when it is v2; null for v1 and the fixed lifecycle. */
  private async flowV2Of(request: RequestWithType): Promise<Flow | null> {
    if (!request.flowVersionId || request.flowVersion?.schemaVersion !== 2) {
      return null;
    }
    return this.flows.load(request.flowVersionId);
  }

  /**
   * v2 `advance`, and `submit` (advancing off a requester step). Forward goes
   * along the exit the answers select once the step's rules hold; the last step
   * closes the request. Backward exits skip the checks.
   */
  private async advanceV2(
    before: RequestWithType,
    flow: Flow,
    toStep: string | null,
    actor: Principal,
  ): Promise<RequestDetail> {
    if (!ADVANCEABLE_V2.includes(before.status)) {
      throw new AppError('REQ_STEP_INVALID', stuckReasonV2(before.status), [
        { field: 'status', reason: before.status },
      ]);
    }
    this.assertMayAct(before, actor, 'advance', 'ไปขั้นถัดไป');

    const current = stepOf(flow, before.currentStepCode);
    const backward =
      toStep !== null && backwardOptions(flow, current.code).includes(toStep);
    const next = backward
      ? toStep
      : nextForward(
          flow,
          current.code,
          answersOf(before.formData, before.stepFormData),
        );

    if (!backward && toStep !== null && toStep !== (next ?? END_STEP)) {
      throw new AppError('REQ_STEP_INVALID', 'ไปขั้นนี้จากขั้นปัจจุบันไม่ได้', [
        { field: 'to_step', reason: next ?? END_STEP },
      ]);
    }
    if (!backward) await this.assertStepDoneV2(before, flow, current);

    const target = next ? stepOf(flow, next) : null;
    const submitting =
      target !== null && isSubmitMove(before.status, scopeOf(target));
    if (submitting && scopeOf(target) === 'submitted') {
      await this.assertReceivable(before);
    }
    // CD-67 — a case type must carry a severity before its clocks start.
    if (submitting && !before.severity) {
      assertSeverityGiven(
        await this.sla.isCaseType(before.companyId, before.typeCode),
        before.severity,
      );
    }
    const requestNo = submitting ? await this.requestNoFor(before) : null;
    const typeSnapshot =
      submitting && !before.requestNo
        ? await this.typeSnapshotFor(before)
        : null;

    const opened = await this.transactions.execute(async (prisma) => {
      let request: V2Request = before;

      if (requestNo) {
        request = await this.recordSubmitV2(
          prisma,
          before,
          requestNo,
          typeSnapshot,
          actor,
        );
      }

      if (!target) {
        await this.flows.finishV2(prisma, request, current, actor);
        await this.sla.stop(prisma, before.id, 'met');
        return null;
      }

      const approval = await this.flows.moveV2(
        prisma,
        request,
        flow,
        current.code,
        target.code,
        backward ? 'backward' : 'forward',
        actor,
      );
      // D7: a v2 clock runs through every step once work has reached a worker.
      if (scopeOf(target) === 'in_progress') {
        await this.sla.resume(prisma, before.id);
      }
      return approval;
    });

    if (requestNo) await this.emitSubmitted(before, requestNo);
    await this.flows.announceV2(before.id, before);
    if (opened) await this.approvals.openStepCaseV2(before.id, actor);

    return this.findOne(before.id, actor);
  }

  /** What leaving `step` requires: its form and documents, or a worker step's checklist. */
  private async assertStepDoneV2(
    request: RequestWithType,
    flow: Flow,
    step: FlowStep,
  ): Promise<void> {
    const role = roleOf(scopeOf(step));

    if (role === 'worker') {
      await this.assertStepLeavable(request, flow);
      return;
    }
    if (role !== 'requester') return;

    const isFirst = firstStep(flow).code === step.code;
    assertSubmittable({
      formSchema: step.formSchema,
      requiredDocs: step.requiredDocs ?? [],
      // The first step's answers are the request's own `formData`.
      formData: isFirst
        ? (request.formData as Record<string, unknown>)
        : asRecord(asRecord(request.stepFormData)[step.code]),
      refRequired: isFirst && request.requestType.refRequired,
      refId: request.refId,
      attachmentCodes: request.attachments
        .filter((attachment) => !attachment.deletedAt)
        .map((attachment) => attachment.docCode ?? ''),
    });
  }

  /** The number, snapshot and clock a submit writes, inside the move's transaction. */
  private async recordSubmitV2(
    prisma: Prisma.TransactionClient,
    before: RequestWithType,
    requestNo: string,
    typeSnapshot: Prisma.InputJsonValue | null,
    actor: Principal,
  ): Promise<V2Request> {
    const now = new Date();
    const updated = await prisma.request.update({
      where: { id: before.id },
      data: {
        requestNo,
        submittedAt: now,
        ...(typeSnapshot ? { typeSnapshot } : {}),
        updatedBy: actor.userId,
      },
      include: { requestType: true },
    });

    await this.recordEvent(prisma, {
      requestId: before.id,
      type: 'request.submitted',
      actor,
      fromStatus: before.status,
      data: { requestNo },
    });
    // SUP-01: created paused; the first worker step starts it.
    if (!before.requestNo) await this.sla.start(prisma, updated, now);

    await this.audit.record(
      {
        eventType: 'request.submitted',
        companyId: before.companyId,
        ...auditActor(actor),
        resourceType: 'request',
        resourceId: before.id,
        before: { status: before.status },
        after: { requestNo },
      },
      { prisma },
    );
    return updated;
  }

  private async emitSubmitted(before: RequestWithType, requestNo: string) {
    await this.domainEvents.emit({
      name: before.requestNo
        ? DOMAIN_EVENTS.requestResubmitted
        : DOMAIN_EVENTS.requestSubmitted,
      payload: {
        company_id: before.companyId,
        request_id: before.id,
        request_no: requestNo,
        type_code: before.typeCode,
        requester_id: before.requesterId,
      },
    });
  }

  /** v2 `receive`: the receiver takes a `submitted` step and the work moves on. */
  private async receiveV2(
    before: RequestWithType,
    flow: Flow,
    actor: Principal,
  ) {
    if (before.status !== 'submitted') {
      throw new AppError('REQ_STATE_INVALID', 'คำขอนี้ไม่ได้รอรับเรื่อง', [
        { field: 'status', reason: before.status },
      ]);
    }
    const current = stepOf(flow, before.currentStepCode);
    const next = nextForward(
      flow,
      current.code,
      answersOf(before.formData, before.stepFormData),
    );
    if (!next) {
      throw new AppError('REQ_STEP_INVALID', 'ขั้นนี้ไม่มีขั้นถัดไป');
    }

    const opened = await this.transactions.execute(async (prisma) => {
      // Whoever accepts is doing the work until they hand it on.
      const request = {
        ...before,
        assigneeUserId: before.assigneeUserId ?? actor.userId,
      };
      await this.recordEvent(prisma, {
        requestId: before.id,
        type: 'RECEIVED',
        actor,
        fromStatus: before.status,
      });
      const approval = await this.flows.moveV2(
        prisma,
        request,
        flow,
        current.code,
        next,
        'forward',
        actor,
      );
      await this.sla.resume(prisma, before.id);
      // CD-67 — accepting is the receiving side's first response.
      await this.sla.markResponded(before.id, new Date(), prisma);
      await this.audit.record(
        {
          eventType: 'request.received',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: before.id,
          before: { status: before.status, step: current.code },
          after: { step: next, assigneeUserId: request.assigneeUserId },
        },
        { prisma },
      );
      return approval;
    });

    await this.flows.announceV2(before.id, before);
    if (opened) await this.approvals.openStepCaseV2(before.id, actor);
    return this.require(before.id, actor);
  }

  /** v2 hand-on: the holder of any step but an approval passes it to someone else. */
  private async handOnV2(
    before: RequestWithType,
    dto: AssignRequestDto,
    actor: Principal,
  ) {
    if (before.status === 'pending_approval') {
      throw new AppError(
        'REQ_STEP_INVALID',
        'ขั้นอนุมัติมอบต่อด้วยการมอบอำนาจอนุมัติ',
      );
    }
    const column = HOLDER_COLUMN[before.status] ?? 'assigneeUserId';
    const from = before[column];

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id: before.id },
        data: { [column]: dto.assignee_user_id, updatedBy: actor.userId },
      });
      if (before.status === 'in_progress') {
        await this.sla.resume(prisma, before.id);
      }
      // CD-67 — handing on the receiving side's step counts as responding.
      if (before.status === 'submitted' || before.status === 'in_progress') {
        await this.sla.markResponded(before.id, new Date(), prisma);
      }
      await this.recordEvent(prisma, {
        requestId: before.id,
        type: from ? 'HANDOVER' : 'ASSIGNED',
        actor,
        data: {
          from,
          to: dto.assignee_user_id,
          step: before.currentStepCode,
          note: dto.note ?? null,
        },
      });
      await this.audit.record(
        {
          eventType: 'request.assigned',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: before.id,
          before: { [column]: from },
          after: { [column]: dto.assignee_user_id },
        },
        { prisma },
      );
      return updated;
    });
  }

  /** v2: the first step's answers are `formData`; later steps keep theirs per step. */
  private async saveStepFormV2(
    before: RequestWithType,
    flow: Flow,
    dto: StepFormDto,
    actor: Principal,
  ) {
    if (!ADVANCEABLE_V2.includes(before.status) || !before.currentStepCode) {
      throw new AppError(
        'REQ_STEP_INVALID',
        'คำขอนี้ไม่ได้อยู่ในขั้นตอนที่แก้ฟอร์มได้',
      );
    }
    const code = before.currentStepCode;
    const schema = stepOf(flow, code).formSchema;
    const stepFormData = asRecord(before.stepFormData);
    // CD-80 — computed fields are the system's, never the caller's.
    const data: Prisma.RequestUpdateInput =
      firstStep(flow).code === code
        ? {
            formData: applyComputedFields(schema, {
              ...asRecord(before.formData),
              ...dto.data,
            }) as Prisma.InputJsonValue,
          }
        : {
            stepFormData: {
              ...stepFormData,
              [code]: applyComputedFields(schema, {
                ...asRecord(stepFormData[code]),
                ...dto.data,
              }),
            } as Prisma.InputJsonValue,
          };

    await this.transactions.execute(async (prisma) => {
      await prisma.request.update({
        where: { id: before.id },
        data: { ...data, updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'request.step_form.saved',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: before.id,
          after: { step: code },
        },
        { prisma },
      );
    });

    return this.findOne(before.id, actor);
  }

  // --- §7.1 amendment: hold and resume ------------------------------------

  /**
   * Parks work that is waiting on an external factor. Only `in_progress` can
   * be held (§7.1 amendment) — a request awaiting approval is somebody's
   * queue, not an external wait.
   */
  async hold(id: string, dto: HoldRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

    this.assertMayAct(before, actor, 'hold', 'พักงาน');

    assertTransition(before.status, 'on_hold');

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: { status: 'on_hold', updatedBy: actor.userId },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.held',
        actor,
        fromStatus: before.status,
        toStatus: 'on_hold',
        data: { reason: dto.reason },
      });

      // SUP-01: the wait is on an external factor, not the receiving team —
      // same reasoning as the pause on return.
      await this.sla.pause(prisma, id);

      await this.audit.record(
        {
          eventType: 'request.held',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'on_hold', reason: dto.reason },
        },
        { prisma },
      );

      return updated;
    });
  }

  /** Resumes held work; the clock owes the same remaining hours as before. */
  async resume(id: string, dto: ResumeRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

    this.assertMayAct(before, actor, 'resume', 'กลับมาดำเนินการ');

    // `submitted → in_progress` is also a legal transition, so the state
    // machine alone would let /resume double as a start button. It only
    // undoes a hold.
    if (before.status !== 'on_hold') {
      throw new AppError(
        'REQ_STATE_INVALID',
        'ไม่สามารถเปลี่ยนสถานะคำขอจากสถานะปัจจุบันได้',
        [{ field: 'status', reason: `${before.status} → in_progress` }],
      );
    }
    assertTransition(before.status, 'in_progress');

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: { status: 'in_progress', updatedBy: actor.userId },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.resumed',
        actor,
        fromStatus: before.status,
        toStatus: 'in_progress',
        data: { note: dto.note ?? null },
      });

      await this.sla.resume(prisma, id);

      await this.audit.record(
        {
          eventType: 'request.resumed',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: id,
          before: { status: before.status },
          after: { status: 'in_progress' },
        },
        { prisma },
      );

      return updated;
    });
  }

  // --- REQ-08: reads ------------------------------------------------------

  async list(actor: Principal, query: ListRequestsQueryDto) {
    const { skip, take } = toSkipTake(query);
    /*
      One delegation lookup per list, rather than none.

      The "อนุมัติ" tab counted only steps naming the caller directly, so a
      person covering for an approver read `0` on a queue they were working
      from `/approvals`. Delegations are resolved now, not at submit (APV-03),
      so the answer cannot come off the cached principal.
    */
    const covering = await this.approvals.coveringFor(actor);
    const where = this.scopedWhere(actor, query, covering);

    const [rows, total] = await Promise.all([
      this.requests.search(where, { skip, take }),
      this.requests.countWhere(where),
    ]);

    return paginated(
      rows.map((row) => this.withAvailableActions(row, actor, covering)),
      query,
      total,
    );
  }

  /**
   * What this caller may do with this row, as the list renders it.
   *
   * `availableActions` is the same table `assertMayAct` consults, so a button
   * the list offers is a button the handler behind it will honour. Deriving the
   * list on the frontend instead was how `งานทั้งหมด` ended up read-only: with
   * no trustworthy answer available, offering nothing was the only safe choice.
   *
   * Computed per row rather than queried — it is a pure function of fields the
   * list already loaded, so this adds no round trips.
   */
  private withAvailableActions(
    row: RequestListRow,
    actor: Principal,
    covering: readonly string[],
  ): RequestListRow & { available_actions: string[] } {
    return {
      ...row,
      available_actions: this.actionNamesFor(row, actor, covering),
    };
  }

  /** The detail screen's read: `findOne` plus the buttons, from the same table as the list. */
  async detailFor(id: string, actor: Principal) {
    const found = await this.findOne(id, actor);
    const covering = await this.approvals.coveringFor(actor);

    return {
      ...found,
      available_actions: this.actionNamesFor(found, actor, covering),
      flow_moves: await this.flowMovesOf(found),
    };
  }

  /** Where `advance` may go from here, so the screen and the external API can label it. */
  async flowMovesOf(request: RequestWithType) {
    if (!request.flowVersionId || !request.currentStepCode) return null;

    const flow = await this.flows.load(request.flowVersionId);
    const step = stepOf(flow, request.currentStepCode);
    const scope = flow.schemaVersion === 2 ? scopeOf(step) : null;
    return {
      schema_version: flow.schemaVersion ?? 1,
      // v2: the status this step sits under and who acts on it (null while awaiting approval).
      scope,
      holder_user_id: scope ? holderOf(scope, request) : null,
      current: request.currentStepCode,
      forward: nextForward(
        flow,
        request.currentStepCode,
        answersOf(request.formData, request.stepFormData),
      ),
      backward: backwardOptions(flow, request.currentStepCode),
      is_last: isLastStep(flow, request.currentStepCode),
      requires_approval: stepOf(flow, request.currentStepCode).requiresApproval,
      checklist: await this.namedSubRequestTypes(
        stepOf(flow, request.currentStepCode).subRequestTypes,
      ),
    };
  }

  private actionNamesFor(
    row: ActionableRequest & CaseCarrier,
    actor: Principal,
    covering: readonly string[],
  ): string[] {
    const step = currentStepOf(row);

    /*
      The same test `authorise` runs, including the delegation and the
      pre-`candidateUserIds` fallback. A narrower one here would put an
      อนุมัติ button on a row that answers `APV_NOT_YOUR_TURN`, and a wider
      one would hide a decision somebody actually owes.
    */
    const deciders = [actor.userId, ...covering];

    const isDecider =
      step !== null &&
      step.status === 'pending' &&
      (step.candidateUserIds.length
        ? step.candidateUserIds.some((id) => deciders.includes(id))
        : step.approverUserId !== null &&
          deciders.includes(step.approverUserId));

    return availableActions(row, actor, isDecider).map((spec) => spec.action);
  }

  async findOne(id: string, actor: Principal): Promise<RequestDetail> {
    const found = await this.requests.findDetail(id);

    // SCOPE-03: outside scope answers 404, never 403 — existence is not
    // disclosed across a boundary.
    if (!found || !(await this.visibleTo(found, actor))) {
      throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ');
    }

    return found;
  }

  async events(id: string, actor: Principal) {
    const found = await this.findOne(id, actor);
    return found.events;
  }

  // --- H2.2: comments -----------------------------------------------------

  /**
   * Leaves a note on a request.
   *
   * Gated on being able to *see* the request, not on a separate permission:
   * the people who can open a request are exactly the people with something to
   * say about it, and a second rule would have to be kept in step with the
   * first for no benefit.
   *
   * `findOne` is what enforces that, and it answers 404 rather than 403 for a
   * request outside the caller's reach (SCOPE-03) — so commenting cannot be
   * used to discover that one exists.
   */
  async addComment(id: string, dto: AddCommentDto, actor: Principal) {
    const found = await this.findOne(id, actor);

    const comment = await this.comments.create({
      data: { requestId: id, authorId: actor.userId, body: dto.body },
      include: { author: { select: { displayName: true } } },
    });

    // CD-67 — a reply from anyone but the requester is a response on a case.
    if ((found as { requesterId: string }).requesterId !== actor.userId) {
      await this.sla.markResponded(id);
    }
    return comment;
  }

  // --- H2.2: the request tree ----------------------------------------------

  /**
   * This request, everything spawned under it, and the one above it.
   *
   * One query for the subtree — `ancestorIds` holds the whole lineage, so
   * "everything under this" is an index lookup rather than a walk. The parent
   * comes back separately and shallowly: a child shows *who it came from*, not
   * that parent's own contents, which belong to whoever is working on it.
   *
   * Visibility is the request's own: somebody who can open this request can see
   * what was raised from it. That is the point of the panel — a chain nobody
   * can follow is a chain that gets worked on twice.
   */
  async tree(id: string, actor: Principal) {
    const found = await this.findOne(id, actor);

    const [descendants, parent] = await Promise.all([
      this.requests.findMany({
        where: { ancestorIds: { has: id } },
        select: REQUEST_TREE_SELECT,
        orderBy: { createdAt: 'asc' },
      }),
      found.parentRequestId
        ? this.requests.findUnique({
            where: { id: found.parentRequestId },
            select: { id: true, requestNo: true, typeCode: true, status: true },
          })
        : null,
    ]);

    return { parent, descendants };
  }

  // --- internals ----------------------------------------------------------

  /**
   * The one filter behind every list, single read and count (SCOPE-02).
   *
   * No longer private, so the external summary endpoint can count the rows this
   * builds rather than describe them a second time. That is the only reason to
   * call it: a caller that composes its own `where` is how a total and the page
   * beneath it start disagreeing, which is the defect SCOPE-02 names.
   */
  scopedWhere(
    actor: Principal,
    // Partial because `visibleTo` reuses this with no filters at all — the
    // visibility half is what it needs, not the search box.
    query: Partial<ListRequestsQueryDto>,
    /** Delegators this caller covers for, from `approvals.coveringFor`. */
    covering: readonly string[] = [],
  ): Prisma.RequestWhereInput {
    /*
      One filter layer for every list, single read and count (SCOPE-02). The
      scope levels it used to read are gone; `visibleRequestsWhere` decides
      from involvement and from the groups this person leads, and still pins
      the company on every branch (SCOPE-03).

      `view` no longer needs to widen it. It used to OR an extra predicate on
      because scope `own` could not see a ticket handed to you or a case you
      approve; those are part of the base rule now, so the views below only
      narrow.
    */
    const subject = accessSubject(actor, covering);

    const scoped = visibleRequestsWhere(subject) as Prisma.RequestWhereInput;

    /*
      Composed with `AND` rather than merged into one object.

      Three of these contribute an `OR`, and spreading them into a single
      literal silently dropped all but the last — searching inside the
      "รับเรื่อง" tab quietly became a search across everything, because the
      search box's `OR` overwrote the tab's.
    */
    const narrowing: Prisma.RequestWhereInput[] = [];

    if (query.view === 'involved') {
      narrowing.push(involvedRequestsWhere(subject));
    }

    if (query.view === 'created') {
      narrowing.push({ requesterId: actor.userId });
    }

    /*
      `incoming` is "handed to me", not "handed to me and not finished yet".

      It used to AND `status in CARRIER_QUEUE_STATUSES`, which made the tab a
      filter on the *status of the work* rather than on what the caller may
      reach. A receiver whose tickets had all been closed saw `รับเรื่อง · 0`
      beside `สร้าง · 3` and read it as data loss — reported as a defect on
      4 ก.ย. 2569, with `uat.chavisat`'s three `MK-01` tickets all sitting at
      `closed`/`cancelled`.

      Every tab narrows by *access* now; the status box above narrows by
      status, and it is the control that was always meant to do it.
    */
    if (query.view === 'incoming') {
      narrowing.push({
        OR: [
          { receiverUserId: actor.userId },
          { assigneeUserId: actor.userId },
        ],
      });
    }

    if (query.view === 'approver') {
      narrowing.push(inApprovalRouteWhere(subject));
    }

    /*
      The queue the `approver` tab used to be. Kept as its own view rather than
      folded back into that one: the tab lists everything this person's name is
      on, and the badge beside it counts what is actually waiting. Two numbers,
      two questions — the badge is what tells somebody they owe a decision.
    */
    if (query.view === 'awaiting') {
      narrowing.push(awaitingDecisionWhere(subject));
    }

    /*
      `led` — "งานทั้งหมด" — adds nothing at all: the base rule already covers
      involvement, the groups this person leads and the groups granted to
      them, which is exactly what the screen means. Kept as an accepted value
      so existing links do not 422.
    */

    if (query.status) {
      narrowing.push({ status: query.status as RequestStatus });
    }

    /*
      "งานค้าง" — the same set `open_total` counts, so the number on the
      dashboard and the rows under it cannot disagree.

      ANDed like every other filter rather than replacing `status`: asking for
      both an exact status and open-only is a contradiction the caller can
      express, and answering it with nothing is the honest result. The screens
      send one or the other.
    */
    if (isOpenOnlyRequested(query.open)) {
      narrowing.push({ status: { in: [...OPEN_STATUSES] } });
    }

    if (query.type_code) narrowing.push({ typeCode: query.type_code });
    if (query.severity) narrowing.push({ severity: query.severity });

    // REQ-06 / C360 — the 360° page's "คำขอ" tab: everything raised against
    // one entity, still inside the caller's scope.
    if (query.ref_type) narrowing.push({ refType: query.ref_type });
    if (query.ref_id) narrowing.push({ refId: query.ref_id });

    if (query.q) {
      narrowing.push({
        OR: [
          { requestNo: { contains: query.q, mode: 'insensitive' } },
          { refId: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    if (isOverdueRequested(query.overdue)) {
      narrowing.push({ slaClock: { is: overdueClockWhere() } });
    }

    return { AND: [scoped, ...narrowing] };
  }

  private async visibleTo(
    found: RequestDetail,
    actor: Principal,
  ): Promise<boolean> {
    if (found.companyId !== actor.activeCompanyId) return false;
    if (found.requesterId === actor.userId) return true;

    /*
      One question, asked of the one filter. Being an approver on the chain
      (SCOPE-06) used to need a second query as a fallback past the scope
      levels; it is a branch of the base rule now, so a second query would
      only be a second chance to disagree with the first.
    */
    const covering = await this.approvals.coveringFor(actor);

    const match = await this.requests.countWhere({
      AND: [this.scopedWhere(actor, {}, covering), { id: found.id }],
    });

    if (match > 0) return true;

    return false;
  }

  /**
   * Whether this person may move this particular ticket.
   *
   * **This is the gate, now that the role is not.** Until 2 ก.ย. 2569 the only
   * thing standing between an employee and somebody else's request was the
   * `request.complete` permission, held by one role. Authority over the request
   * menu now follows the org chart and involvement instead — which is only safe
   * if the involvement is actually checked, so it is checked here.
   *
   * `require` above proves the request exists in your company and nothing more.
   * That is deliberately a weaker question: reading is decided by
   * `visibleRequestsWhere`, and acting is decided by this.
   *
   * One helper rather than the same three lines in five places, because five
   * copies of a rule is five chances for one of them to drift.
   */
  private assertMayAct(
    request: RequestWithType,
    actor: Principal,
    /**
     * The action being attempted, named as `ACTIONS` names it.
     *
     * The authority it needs **and** the permission a scope grant must carry to
     * reach it both come from that one table, which the external API's "what
     * can I do with this?" endpoint reads too. Restating either here is how a
     * list of offered choices starts disagreeing with the handler behind
     * them — and by then the caller has already told somebody it would work.
     *
     * `carrier_or_lead` / `requester_or_lead` reach group heads. Scope grants
     * reach those and, since 7 ก.ย. 2569, `carrier` as well — but only when the
     * grant names this action's permission *and* the caller's own roles hold
     * it. Never through the plain `scopedUnitIds`: a grant that only lets a
     * group read another group's work must not let them move it.
     */
    action: RequestAction,
    label: string,
  ): void {
    const spec = specFor(action);

    if (
      hasAuthority(spec.authority, request, actor, false, spec.scopePermission)
    ) {
      return;
    }

    throw new AppError(
      'FORBIDDEN',
      `${label}ได้เฉพาะผู้ที่เกี่ยวข้องกับคำขอนี้`,
    );
  }

  private async require(
    id: string,
    actor: Principal,
  ): Promise<RequestWithType> {
    const found = await this.requests.findWithType(id);

    if (!found || found.companyId !== actor.activeCompanyId) {
      throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ');
    }

    return found;
  }

  private async requireType(typeCode: string, companyId: string) {
    const type = await this.types.findFirst({
      where: {
        code: typeCode,
        active: true,
        companies: { some: { companyId, active: true } },
      },
    });

    if (!type) {
      throw new AppError('NOT_FOUND', 'ไม่พบประเภทคำขอที่ระบุ', [
        { field: 'type_code', reason: typeCode },
      ]);
    }

    return type;
  }

  /**
   * REQ-07: one append-only entry per status change, numbered by
   * {@link nextRequestEventSeq} so the order is stable under concurrency.
   */
  private async recordEvent(
    prisma: Prisma.TransactionClient,
    entry: {
      requestId: string;
      type: string;
      actor: Principal;
      fromStatus?: RequestStatus;
      toStatus?: RequestStatus;
      data?: Prisma.InputJsonValue;
    },
  ) {
    const seq = await nextRequestEventSeq(prisma, entry.requestId);

    return prisma.requestEvent.create({
      data: {
        requestId: entry.requestId,
        seq,
        type: entry.type,
        actorId: entry.actor.isServiceAccount ? null : entry.actor.userId,
        actorLabel: entry.actor.displayName || entry.actor.username,
        fromStatus: entry.fromStatus ?? null,
        toStatus: entry.toStatus ?? null,
        data: entry.data,
      },
    });
  }
}

/**
 * The checklist a request runs under: its snapshot once submitted (a snapshot
 * taken before the column existed means none), the live type before that.
 */
function subRequestTypesOf(request: RequestWithType): SubRequestTypeRule[] {
  return asSubRequestTypes(
    request.typeSnapshot
      ? snapshotOf(request).subRequestTypes
      : request.requestType.subRequestTypes,
  );
}

function asSubRequestTypes(value: unknown): SubRequestTypeRule[] {
  // Written only through `SubRequestTypeDto`, so an array has that shape.
  return Array.isArray(value) ? (value as SubRequestTypeRule[]) : [];
}

/** The `typeSnapshot` a running request carries, if it has one yet. */
function snapshotOf(request: RequestWithType): Record<string, unknown> {
  return typeof request.typeSnapshot === 'object' && request.typeSnapshot
    ? (request.typeSnapshot as Record<string, unknown>)
    : {};
}

/**
 * The step an approval case is currently sitting on, or null.
 *
 * `search` loads the newest case with its steps in `stepNo` order, so this is
 * a lookup rather than a query. Returns null for a request with no case at all
 * — eighteen of the forty request types carry no approval step, and those rows
 * must not be treated as though a decision were owed on them.
 */
/**
 * A clock that is late — by either of the two ways a clock can be late.
 *
 * `breachedAt` is written by the SLA sweep, which runs on a 60-second interval
 * and can be switched off entirely (`slaSweepIntervalMs <= 0`, which tests and
 * one-off scripts do). Filtering on it alone meant "เฉพาะเกินกำหนด" answered
 * *nothing is late* in any environment without a sweeper, and missed the first
 * minute of every breach in the ones that have it.
 *
 * The second branch asks the question directly. It is not a replacement for the
 * first: a clock that has stopped keeps `breachedAt` and loses `state:
 * 'running'`, and a request that finished late is still a request that finished
 * late. `SlaClock` is indexed on `[state, dueAt]`, so the added branch is a
 * range scan rather than a table walk.
 *
 * Not extended to `paused`: a clock parked on `on_hold` is not accruing time,
 * and calling it late would blame the receiving team for a wait that is
 * somebody else's. That the sweeper never marks such a clock at all is a
 * separate defect, recorded in the gap analysis rather than papered over here.
 */
function overdueClockWhere(): Prisma.SlaClockWhereInput {
  return {
    OR: [
      { breachedAt: { not: null } },
      { state: 'running', dueAt: { lt: new Date() } },
    ],
  };
}

/**
 * Whether the caller asked for the overdue filter.
 *
 * The web app declares `overdue` as a string and sends `"true"`; the external
 * API declares it as a boolean and sends `true`. Both reach the same `where`,
 * so both have to be understood here — reading only one is how the filter
 * silently did nothing for one of its two callers.
 */
function isOverdueRequested(value: unknown): boolean {
  return value === true || value === 'true';
}

/** Same two representations as `overdue`, for the same two callers. */
function isOpenOnlyRequested(value: unknown): boolean {
  return value === true || value === 'true';
}

/** The slice of a loaded request `currentStepOf` reads — list rows and the detail both carry it. */
interface CaseCarrier {
  approvalCases: {
    currentStep: number;
    steps: {
      stepNo: number;
      status: string;
      candidateUserIds: string[];
      approverUserId: string | null;
    }[];
  }[];
}

function currentStepOf(row: CaseCarrier) {
  const activeCase = row.approvalCases[0];

  if (!activeCase) return null;

  return (
    activeCase.steps.find((step) => step.stepNo === activeCase.currentStep) ??
    null
  );
}

/** v2: the exit of a last step, as the admin screen and `to_step` name it. */
const END_STEP = 'END';

/** Statuses a v2 step holder moves on with `advance`; the rest move by receive or decide. */
const ADVANCEABLE_V2: readonly RequestStatus[] = [
  'draft',
  'returned',
  'in_progress',
  'approved',
];

function stuckReasonV2(status: RequestStatus): string {
  if (status === 'submitted') return 'ขั้นนี้รอผู้รับเรื่องกด "รับเรื่อง"';
  if (status === 'pending_approval') return 'ขั้นนี้รอผู้อนุมัติตัดสิน';
  return 'คำขอนี้ไม่ได้อยู่ในขั้นตอนที่เดินต่อได้';
}

/** The column that names who holds a v2 step under each status. */
const HOLDER_COLUMN: Partial<
  Record<
    RequestStatus,
    'stepHolderUserId' | 'receiverUserId' | 'assigneeUserId'
  >
> = {
  draft: 'stepHolderUserId',
  returned: 'stepHolderUserId',
  approved: 'stepHolderUserId',
  submitted: 'receiverUserId',
};

/** The fixed verbs a v2 flow replaces with its own steps. */
function assertNotFlowV2(request: RequestWithType): void {
  if (request.flowVersion?.schemaVersion === 2) {
    throw new AppError(
      'REQ_STEP_INVALID',
      'คำขอนี้เดินตามขั้นตอน — ใช้ "ไปขั้นถัดไป"',
    );
  }
}
