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
import { assertTransition } from './request-state-machine';
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
        status: 'draft',
        createdBy: actor.userId,
      },
    });
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

  // --- REQ-08: closing the work ------------------------------------------

  /**
   * Marks the work done and stops the clock.
   *
   * The receiving team closes this, not the requester: REQ-08 tracks work
   * across teams, and letting the person who raised it declare completion
   * would make the SLA measure their patience rather than the team's response.
   * `request.complete` is the permission that expresses that.
   *
   * `assertTransition` is what refuses a request still sitting in the ladder —
   * `in_progress` is the only state that leads here (§7.1).
   */
  async complete(id: string, actor: Principal) {
    const before = await this.require(id, actor);

    assertTransition(before.status, 'completed');

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

    return updatedRequest;
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
   * REQ-02/03 + APV-02 + SUP-01 — the submit.
   *
   * Everything below happens in **one transaction** on purpose. A request that
   * holds a number but no approval chain sits in nobody's queue and nobody
   * knows it is waiting; one with a chain but no clock never escalates. Either
   * outcome is invisible, which is the worst kind of failure for a system whose
   * job is making sure nothing is silently stuck.
   */
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
      attachmentCodes: before.attachments
        .filter((attachment) => !attachment.deletedAt)
        .map((attachment) => attachment.docCode ?? ''),
    });

    const amount = amountFor(before);

    /**
     * Routing is checked **before** anything is written.
     *
     * The chain is resolved across a service boundary and so cannot join the
     * transaction below. Without this, a submit that fails at routing — no
     * published matrix for the type, or a requester with no supervisor —
     * leaves a request that has consumed a document number, moved to
     * `submitted` and started its clock, yet appears in no approver's queue
     * and refuses to be submitted again. Failing here writes nothing.
     */
    await this.approvals.assertRoutable({
      subjectType: `request:${before.typeCode}`,
      amount,
      requesterId: actor.userId,
      companyId: actor.activeCompanyId,
      authorization,
    });

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

    // APV-02 — outside the transaction because the chain is resolved across a
    // service boundary. `assertRoutable` above has already proved this call
    // can succeed, so the request is not left half-submitted.
    const approvalCase = await this.approvals.openCase(
      {
        subject_type: `request:${before.typeCode}`,
        subject_id: submitted.requestNo ?? id,
        amount,
        requester_user_id: actor.userId,
        payload: before.formData as Record<string, unknown>,
      },
      actor,
      authorization,
    );

    await this.transactions.execute(async (prisma) => {
      await prisma.approvalCase.update({
        where: { id: approvalCase.id },
        data: { requestId: id },
      });

      await prisma.request.update({
        where: { id },
        data: { status: 'pending_approval' },
      });

      await this.recordEvent(prisma, {
        requestId: id,
        type: 'request.routed',
        actor,
        fromStatus: 'submitted',
        toStatus: 'pending_approval',
        data: { caseId: approvalCase.id, steps: approvalCase.steps.length },
      });
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
      // SCOPE-06: anyone in the approval chain can always see it.
      query.view === 'involved'
        ? {
            approvalCases: {
              some: { steps: { some: { approverUserId: actor.userId } } },
            },
          }
        : undefined,
    ) as Prisma.RequestWhereInput;

    const filters: Prisma.RequestWhereInput = {
      // `scoped` already pins the company (SCOPE-03); repeating it here only
      // made the generated query harder to read.
      ...(query.view === 'mine' ? { requesterId: actor.userId } : {}),
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
