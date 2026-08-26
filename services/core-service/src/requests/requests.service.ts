import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
  buildScopeWhere,
  paginated,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { Prisma, RequestStatus } from '@prisma/client';
import { assertTransition } from './request-state-machine';
import { assertKnownReturnReason, assertSubmittable } from './submit-rules';
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
import {
  CancelRequestDto,
  CreateRequestDto,
  ListRequestsQueryDto,
  ReturnRequestDto,
  UpdateRequestDto,
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
    private readonly types: RequestTypeRepository,
    private readonly docNumbers: DocNumberService,
    private readonly approvals: ApprovalsService,
    private readonly sla: SlaService,
    private readonly notifications: NotificationsService,
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
    // service boundary; a failure here leaves a submitted request with no case,
    // which `pending_approval` below would not be reached for.
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

    return this.transactions.execute(async (prisma) => {
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
