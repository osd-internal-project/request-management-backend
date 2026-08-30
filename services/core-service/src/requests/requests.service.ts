import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
  buildScopeWhere,
  resolveTargetCompany,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Prisma, RequestStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { assertTransition, OPEN_STATUSES } from './request-state-machine';
import { AttachmentRepository } from './attachment.repository';
import {
  assertKnownDocCode,
  assertKnownReturnReason,
  assertSubmittable,
  assertUsableFormSchema,
} from './submit-rules';
import { DocNumberService } from './doc-number.service';
import {
  RequestDetail,
  RequestRepository,
  RequestWithType,
} from './request.repository';
import { RequestTypeRepository } from './request-type.repository';
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
} from './dto/request.dto';

/** Columns `buildScopeWhere` pins a request query to (SCOPE-02). */
const SCOPE_COLUMNS = {
  owner: 'requesterId',
  orgUnit: 'requesterOrgUnitId',
  company: 'companyId',
} as const;

@Injectable()
export class RequestsService {
  constructor(
    private readonly requests: RequestRepository,
    private readonly attachments: AttachmentRepository,
    private readonly types: RequestTypeRepository,
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
  listTypes(actor: Principal) {
    return this.types.findMany({
      where: {
        active: true,
        companies: { some: { companyId: actor.activeCompanyId, active: true } },
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
          requiredDocs: (dto.required_docs ??
            []) as unknown as Prisma.InputJsonValue,
          returnReasonCodes: (dto.return_reason_codes ??
            []) as unknown as Prisma.InputJsonValue,
          approvalPolicy: (dto.approval_policy ?? {}) as Prisma.InputJsonValue,
          slaHours: dto.sla_hours ?? null,
          slaBusinessHours: dto.sla_business_hours ?? true,
          active: dto.active ?? false,
          createdBy: actor.userId,
          updatedBy: actor.userId,
          companies: {
            create: companyIds.map((companyId) => ({ companyId })),
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

      return type;
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
          ...(dto.sla_business_hours !== undefined
            ? { slaBusinessHours: dto.sla_business_hours }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          updatedBy: actor.userId,
        },
      });

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

      return updated;
    });
  }

  // --- REQ-01/REQ-03: draft, edit, submit --------------------------------

  async create(dto: CreateRequestDto, actor: Principal) {
    const type = await this.requireType(dto.type_code, actor.activeCompanyId);

    if (dto.parent_request_id) {
      await this.assertUsableParent(dto.parent_request_id, actor);
    }

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
        parentRequestId: dto.parent_request_id ?? null,
        status: 'draft',
        createdBy: actor.userId,
      },
    });
  }

  /**
   * A request may hang under another one, but not under itself.
   *
   * One piece of work commonly becomes several — `06_EXAMPLE` traces ten across
   * eight departments — and each child holds its parent open. A cycle would
   * hold every request in it open for ever, with no way for anyone to finish
   * any of them, so the chain is walked upward before the link is made.
   */
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
  async close(id: string, actor: Principal) {
    const before = await this.require(id, actor);

    if (before.requesterId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'ปิดคำขอได้เฉพาะผู้ยื่นคำขอ');
    }

    assertTransition(before.status, 'closed');

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
  async complete(id: string, actor: Principal, authorization: string) {
    const before = await this.require(id, actor);

    assertTransition(before.status, 'completed');

    await this.assertNoOpenChildren(id);

    const updatedRequest = await this.transactions.execute(async (prisma) => {
      const updated = await prisma.request.update({
        where: { id },
        data: {
          status: 'completed',
          completedAt: new Date(),
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

    return this.routeForApproval(before, actor, authorization, updatedRequest);
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
  ) {
    const id = completed.id;

    const hasMatrix = await this.approvals.hasPublishedMatrix(
      `request:${before.typeCode}`,
      before.companyId,
      authorization,
    );

    if (!hasMatrix) {
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
        subject_type: `request:${before.typeCode}`,
        subject_id: before.requestNo ?? id,
        amount: amountFor(before),
        requester_user_id: before.requesterId,
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
        fromStatus: 'completed',
        toStatus: 'pending_approval',
        data: { caseId: approvalCase.id, steps: approvalCase.steps.length },
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
  async submit(id: string, actor: Principal, _authorization: string) {
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
            requiredDocs: before.requestType.requiredDocs,
            returnReasonCodes: before.requestType.returnReasonCodes,
            approvalPolicy: before.requestType.approvalPolicy,
            slaHours: before.requestType.slaHours,
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

    return this.requests.findDetail(id) as Promise<RequestDetail>;
  }

  // --- REQ-04/05: return and cancel --------------------------------------

  /** REQ-04: bounced back to the requester, with a countable reason. */
  async returnToRequester(id: string, dto: ReturnRequestDto, actor: Principal) {
    const before = await this.require(id, actor);

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
    const where = this.scopedWhere(actor, query);

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

  // --- internals ----------------------------------------------------------

  private scopedWhere(
    actor: Principal,
    // Partial because `visibleTo` reuses this with no filters at all — the
    // scope half is what it needs, not the search box.
    query: Partial<ListRequestsQueryDto>,
  ): Prisma.RequestWhereInput {
    const scope = actor.scopes.request ?? 'own';

    const scoped = buildScopeWhere(
      scope,
      SCOPE_COLUMNS,
      {
        userId: actor.userId,
        activeCompanyId: actor.activeCompanyId,
        teamOrgUnitIds: actor.teamOrgUnitIds,
        departmentOrgUnitIds: actor.departmentOrgUnitIds,
      },
      // SCOPE-06: anyone in the approval chain can always see it — and so can
      // the person a ticket was handed to, for the same reason: relatedness to
      // this particular row, not the breadth of what they may generally see.
      query.view === 'involved'
        ? {
            approvalCases: {
              some: { steps: { some: { approverUserId: actor.userId } } },
            },
          }
        : query.view === 'incoming'
          ? {
              OR: [
                { receiverUserId: actor.userId },
                { assigneeUserId: actor.userId },
              ],
            }
          : undefined,
    ) as Prisma.RequestWhereInput;

    const filters: Prisma.RequestWhereInput = {
      // `scoped` already pins the company (SCOPE-03); repeating it here only
      // made the generated query harder to read.
      ...(query.view === 'mine' ? { requesterId: actor.userId } : {}),
      /*
        `incoming` means "waiting for me to do something with it", so it stops
        at the point the ticket is no longer mine to move. Everything I have
        ever received would be a history, not a queue.
      */
      ...(query.view === 'incoming'
        ? {
            OR: [
              { receiverUserId: actor.userId },
              { assigneeUserId: actor.userId },
            ],
            status: { in: ['submitted', 'in_progress', 'on_hold'] },
          }
        : {}),
      ...(query.status ? { status: query.status as RequestStatus } : {}),
      ...(query.type_code ? { typeCode: query.type_code } : {}),
      ...(query.q
        ? {
            OR: [
              { requestNo: { contains: query.q, mode: 'insensitive' } },
              { refId: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.overdue === 'true'
        ? { slaClock: { is: { breachedAt: { not: null } } } }
        : {}),
    };

    return { AND: [scoped, filters] };
  }

  private async visibleTo(
    found: RequestDetail,
    actor: Principal,
  ): Promise<boolean> {
    if (found.companyId !== actor.activeCompanyId) return false;
    if (found.requesterId === actor.userId) return true;

    const where = this.scopedWhere(actor, {});
    const match = await this.requests.countWhere({
      AND: [where, { id: found.id }],
    });

    if (match > 0) return true;

    // SCOPE-06 fallback: an approver on the chain sees it regardless of scope.
    const asApprover = await this.requests.countWhere({
      id: found.id,
      approvalCases: {
        some: { steps: { some: { approverUserId: actor.userId } } },
      },
    });

    return asApprover > 0;
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

/**
 * The value APV-02 measures against the matrix ceilings.
 *
 * Which field that is comes from the type's `approvalPolicy`, not from code —
 * a type with no monetary dimension (lead handover) simply names none, and
 * `selectTier` then routes it through step 1 only.
 */
function amountFor(request: RequestWithType): string | null {
  const policy = request.requestType.approvalPolicy as {
    amount_field?: string | null;
  } | null;

  const field = policy?.amount_field;
  if (!field) return null;

  const value = (request.formData as Record<string, unknown>)[field];
  return typeof value === 'number' || typeof value === 'string'
    ? String(value)
    : null;
}
