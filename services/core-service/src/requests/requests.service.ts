import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
  accessSubject,
  awaitingDecisionWhere,
  involvedRequestsWhere,
  ledRequestsWhere,
  visibleRequestsWhere,
  resolveTargetCompany,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma } from '@prisma/client';
import type { RequestStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  assertTransition,
  CARRIER_QUEUE_STATUSES,
  OPEN_STATUSES,
} from './request-state-machine';
import { hasAuthority, type Authority } from './available-actions';
import { AttachmentRepository } from './attachment.repository';
import {
  assertKnownDocCode,
  assertKnownReturnReason,
  assertReceiverFormComplete,
  assertSubmittable,
  assertUsableFormSchema,
} from './submit-rules';
import { AFTER_WORK, BEFORE_WORK, type ApprovalStage } from './approval-stage';
import { DocNumberService } from './doc-number.service';
import {
  RequestDetail,
  RequestRepository,
  RequestWithType,
} from './request.repository';
import { RequestTypeRepository } from './request-type.repository';
import { RequestCommentRepository } from './request-comment.repository';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { SlaService } from '../sla/sla.service';
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
  AddAttachmentDto,
  CreateIntegrationRequestDto,
  CreateRequestTypeDto,
  UpdateRequestTypeDto,
  AddCommentDto,
  CloseRequestDto,
  CompleteRequestDto,
} from './dto/request.dto';

/** What one node of the สายคำขอ panel needs — never the whole request. */
const REQUEST_TREE_SELECT = {
  id: true,
  requestNo: true,
  typeCode: true,
  status: true,
  parentRequestId: true,
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
    private readonly docNumbers: DocNumberService,
    private readonly approvals: ApprovalsService,
    private readonly sla: SlaService,
    private readonly notifications: NotificationsService,
    private readonly domainEvents: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  // --- REQ-01: types are configuration -----------------------------------

  /**
   * The types a requester may raise — active, in their active company.
   *
   * REQ-01: an inactive type is one still being configured, so offering it on
   * the submit screen would produce requests nobody can route.
   */
  async listTypes(actor: Principal) {
    /*
      A type may name the groups allowed to raise it, and naming a group covers
      everything under it. Resolved by asking which groups the requester sits
      beneath — one closure read — rather than expanding each named group's
      subtree, which would be a query per group on every submit screen.

      A type with no rows is open to everybody, which is the default and what
      all forty imported types carry.
    */
    const ancestors = actor.orgUnitId
      ? await this.orgUnits.ancestorIdsOf(actor.orgUnitId)
      : [];

    return this.types.findMany({
      where: {
        active: true,
        companies: { some: { companyId: actor.activeCompanyId, active: true } },
        OR: [
          { eligibleUnits: { none: {} } },
          { eligibleUnits: { some: { orgUnitId: { in: ancestors } } } },
        ],
      },
      // The receiving team travels with the type so the submit screen can
      // both preselect it and name it. Reading the chart directly is not open
      // to a requester — `GET /admin/org-units` needs `admin.org.manage` — and
      // a page that fetches what its viewer cannot read is a guaranteed 403.
      include: {
        receiverOrgUnit: { select: { id: true, name: true } },
        eligibleUnits: { select: { orgUnitId: true } },
      },
      orderBy: { code: 'asc' },
    });
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
  listAdminTypes(actor: Principal, companyId?: string) {
    const target = resolveTargetCompany(actor, companyId);

    return this.types.findMany({
      where: { companies: { some: { companyId: target } } },
      // A2 edits both of these, so both travel with the row rather than being
      // fetched again per selection.
      include: {
        receiverOrgUnit: { select: { id: true, name: true } },
        eligibleUnits: { select: { orgUnitId: true } },
      },
      orderBy: { code: 'asc' },
    });
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

    const created = await this.transactions.execute(async (prisma) => {
      const type = await prisma.requestType.create({
        data: {
          code: dto.code,
          name: dto.name,
          receiverOrgUnitId: dto.receiver_org_unit_id ?? null,
          formSchema: dto.form_schema as Prisma.InputJsonValue,
          receiverFormSchema:
            (dto.receiver_form_schema as Prisma.InputJsonValue) ?? undefined,
          requiredDocs: (dto.required_docs ??
            []) as unknown as Prisma.InputJsonValue,
          returnReasonCodes: (dto.return_reason_codes ??
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
        include: { eligibleUnits: true },
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

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.requestType.update({
        where: { code },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.receiver_org_unit_id !== undefined
            ? { receiverOrgUnitId: dto.receiver_org_unit_id }
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
          },
          after: {
            name: updated.name,
            active: updated.active,
            slaHours: updated.slaHours,
            formSchema: updated.formSchema as Prisma.InputJsonValue,
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
      return prisma.requestType.findUniqueOrThrow({
        where: { id: updated.id },
        include: { eligibleUnits: true },
      });
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

    const [requests, matrices] = await Promise.all([
      this.requests.countWhere({ requestTypeId: before.id }),
      this.approvals.countMatricesFor(`request:${code}`),
    ]);

    const blockers = [
      requests && { field: 'requests', reason: `คำขอ ${requests}` },
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

    return this.requests.create({
      data: {
        requestTypeId: type.id,
        typeCode: type.code,
        companyId: actor.activeCompanyId,
        requesterId: actor.userId,
        requesterOrgUnitId: actor.orgUnitId,
        formData: (dto.form_data ?? {}) as Prisma.InputJsonValue,
        refType: dto.ref_type ?? null,
        refId: dto.ref_id ?? null,
        receiverUserId: dto.receiver_user_id ?? null,
        // The type's `ทีมผู้รับ` is the starting point; the requester may send
        // it somewhere else. Copied onto the row rather than read back off the
        // type, so a later edit to the type cannot re-route this (REQ-01).
        receiverOrgUnitId: await this.resolveReceiverUnit(
          dto.receiver_org_unit_id,
          type.receiverOrgUnitId,
          actor.activeCompanyId,
        ),
        parentRequestId: dto.parent_request_id ?? null,
        ancestorIds,
        status: 'draft',
        createdBy: actor.userId,
      },
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
          ? { formData: dto.form_data as Prisma.InputJsonValue }
          : {}),
        ...(dto.ref_type !== undefined ? { refType: dto.ref_type } : {}),
        ...(dto.ref_id !== undefined ? { refId: dto.ref_id } : {}),
        ...(dto.receiver_user_id !== undefined
          ? { receiverUserId: dto.receiver_user_id }
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
   * Records an attached document. **No bytes are stored** — see
   * `AddAttachmentDto` and open question G.
   *
   * Editable states only, and only the requester: an approver who could add a
   * document to a case already in the ladder would change what the earlier
   * approvers agreed to, which is the same reason `update` is fenced.
   */
  async addAttachment(id: string, dto: AddAttachmentDto, actor: Principal) {
    const found = await this.requireEditableOwn(id, actor, 'แนบเอกสาร');

    assertKnownDocCode(found.requestType.requiredDocs, dto.doc_code);

    const created = await this.attachments.create({
      data: {
        requestId: found.id,
        docCode: dto.doc_code ?? null,
        fileName: dto.file_name,
        mimeType: dto.mime_type,
        sizeBytes: dto.size_bytes,
        // Deliberately not a path: nothing was written anywhere, and a value
        // that looks like a location would invite a download route that could
        // only ever 404.
        storageKey: `pending://${randomUUID()}`,
        uploadedById: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'request.attachment.added',
      companyId: found.companyId,
      ...auditActor(actor),
      resourceType: 'request_attachment',
      resourceId: created.id,
      after: {
        requestId: found.id,
        docCode: dto.doc_code ?? null,
        fileName: dto.file_name,
        sizeBytes: dto.size_bytes,
      },
    });

    return created;
  }

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
        formData: (dto.form_data ?? {}) as Prisma.InputJsonValue,
        refType: dto.ref_type ?? null,
        refId: dto.ref_id ?? null,
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

    assertTransition(before.status, 'in_progress');

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
    this.assertMayAct(before, actor, 'carrier', 'มอบหมายงาน');

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

    return this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: { assigneeUserId: dto.assignee_user_id, updatedBy: actor.userId },
      });

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
    this.assertMayAct(before, actor, 'carrier', 'แจ้งงานเสร็จ');

    assertTransition(before.status, 'completed');

    await this.assertNoOpenChildren(id);

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

      // `met` rather than a bare stop: `stop` decides between `met` and
      // `breached` by comparing now against the deadline, which is what lets
      // REQ-09 tell a success from a failure afterwards.
      await this.sla.stop(prisma, id, 'met');

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
      // Nothing to check at this stage. The pre-work stage simply hands the
      // ticket on, which is what every type without a `:pre` matrix does —
      // that is, all of them until somebody publishes one.
      if (!stage.recordsAcceptance) return completed;

      return this.transactions.execute(async (prisma) => {
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
          data: { reason: 'no_approval_matrix' },
        });

        return updated;
      });
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
        payload: before.formData as Record<string, unknown>,
      },
      actor,
      authorization,
    );

    return this.transactions.execute(async (prisma) => {
      await prisma.approvalCase.update({
        where: { id: approvalCase.id },
        data: { requestId: id },
      });

      const updated = await prisma.request.update({
        where: { id },
        data: { status: 'pending_approval', updatedBy: actor.userId },
      });

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
   * The gate both attachment routes share: the request exists, is visible to
   * this caller, is still editable, and is theirs.
   */
  private async requireEditableOwn(
    id: string,
    actor: Principal,
    action: string,
  ) {
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

    /**
     * A ticket has to be handed to somebody.
     *
     * Checked before anything is written, for the same reason routing used to
     * be: a request that consumed a number and started its clock but sits in
     * no one's queue is invisible, and invisible is the failure mode this
     * whole system exists to prevent.
     */
    await this.assertReceivable(before);

    const submitted = await this.transactions.execute(async (prisma) => {
      // REQ-02: the number is issued **once**, at the first submit. A resubmit
      // after a return keeps it — re-issuing would give one request two
      // identities over its life, and a number already quoted in an email would
      // stop resolving.
      const requestNo =
        before.requestNo ??
        (await this.docNumbers.issue(
          before.companyId,
          before.typeCode,
          prisma,
        ));

      const now = new Date();

      const updated = await prisma.request.update({
        where: { id },
        data: {
          requestNo,
          status: 'submitted',
          submittedAt: now,
          // §7: running work keeps the rules it started under.
          typeSnapshot: {
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
          },
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

      // SUP-01: a first submit starts the clock; a resubmit resumes the one
      // paused on return, pushing the deadline out by however long it sat with
      // the requester. Restarting would hand back the full SLA every bounce,
      // making a request that was returned three times look punctual.
      if (before.requestNo) {
        await this.sla.resume(prisma, id, now);
      } else {
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
    this.assertMayAct(before, actor, 'carrier_or_lead', 'ตีกลับคำขอ');

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
    this.assertMayAct(before, actor, 'requester_or_lead', 'ยกเลิกคำขอ');

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

  // --- §7.1 amendment: hold and resume ------------------------------------

  /**
   * Parks work that is waiting on an external factor. Only `in_progress` can
   * be held (§7.1 amendment) — a request awaiting approval is somebody's
   * queue, not an external wait.
   */
  async hold(id: string, dto: HoldRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

    this.assertMayAct(before, actor, 'carrier', 'พักงาน');

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

    this.assertMayAct(before, actor, 'carrier', 'กลับมาดำเนินการ');

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

    return paginated(rows, query, total);
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
    await this.findOne(id, actor);

    return this.comments.create({
      data: { requestId: id, authorId: actor.userId, body: dto.body },
      include: { author: { select: { displayName: true } } },
    });
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

  private scopedWhere(
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
      `incoming` means "still mine to finish", so it stops when the request
      closes — not when it moves on to a stage somebody else acts in.
      Everything I have ever received would be a history, not a queue.

      The old list stopped at `submitted | in_progress | on_hold`, which took
      a ticket off its carrier's queue the moment they sent the result for
      approval (`pending_approval`) or the requester sent it back
      (`returned`) — the two states where it most plainly is still their work.
    */
    if (query.view === 'incoming') {
      narrowing.push({
        OR: [
          { receiverUserId: actor.userId },
          { assigneeUserId: actor.userId },
        ],
        status: { in: [...CARRIER_QUEUE_STATUSES] },
      });
    }

    if (query.view === 'approver') {
      narrowing.push(awaitingDecisionWhere(subject));
    }

    if (query.view === 'led') {
      narrowing.push(ledRequestsWhere(subject));
    }

    if (query.status) {
      narrowing.push({ status: query.status as RequestStatus });
    }

    if (query.type_code) narrowing.push({ typeCode: query.type_code });

    if (query.q) {
      narrowing.push({
        OR: [
          { requestNo: { contains: query.q, mode: 'insensitive' } },
          { refId: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    if (query.overdue === 'true') {
      narrowing.push({ slaClock: { is: { breachedAt: { not: null } } } });
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
     * Which of the flow's roles may do this.
     *
     * The vocabulary and the test both live in `available-actions.ts`, which
     * the external API's "what can I do with this?" endpoint also reads. Two
     * implementations would mean a list of choices that the handler behind
     * them can refuse — and by then the caller has already told somebody it
     * would work.
     *
     * `carrier_or_lead` / `requester_or_lead` reach group heads and, since
     * 2 ก.ย. 2569, anybody whose group holds a scope grant ticked
     * `ทำงานต่อได้` — `scopedActUnitIds`, never `scopedUnitIds`: a grant that
     * only lets a group read another group's work must not let them move it.
     */
    authority: Authority,
    action: string,
  ): void {
    if (hasAuthority(authority, request, actor)) return;

    throw new AppError(
      'FORBIDDEN',
      `${action}ได้เฉพาะผู้ที่เกี่ยวข้องกับคำขอนี้`,
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
   * REQ-07: one append-only entry per status change.
   *
   * `seq` is assigned from the current count so the timeline has a stable
   * order even when two events land in the same millisecond.
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
    const seq = await prisma.requestEvent.count({
      where: { requestId: entry.requestId },
    });

    return prisma.requestEvent.create({
      data: {
        requestId: entry.requestId,
        seq: seq + 1,
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

/** The `typeSnapshot` a running request carries, if it has one yet. */
function snapshotOf(request: RequestWithType): Record<string, unknown> {
  return typeof request.typeSnapshot === 'object' && request.typeSnapshot
    ? (request.typeSnapshot as Record<string, unknown>)
    : {};
}
