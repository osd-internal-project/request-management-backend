import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  accessSubject,
  auditActor,
  paginated,
  visibleRequestsWhere,
  Principal,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import { NotificationsService } from '../notifications/notifications.service';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import {
  DisbursementKind,
  DisbursementStatus,
  formatBaht,
  fromSatang,
  linesFromItems,
  moveBlocker,
  payBlocker,
  settlement,
  statusForPaid,
  thaiDate,
  totalSatang,
} from './disbursement-rules';
import { WORK_STEP } from '../../../../libs/prisma/disbursement-flows';
import {
  DisbursementRequestSyncService,
  DisbursementSettingsRow,
  lineRows,
} from './disbursement-request-sync.service';
import {
  CloseDisbursementDto,
  ListDisbursementsQueryDto,
  PayDisbursementDto,
  ReturnClearingDto,
  SubmitClearingDto,
  VerifyDisbursementDto,
  VoidPaymentDto,
} from './disbursement.dto';
import {
  DisbursementFileRepository,
  DisbursementMovementRepository,
  DisbursementRepository,
} from './disbursement.repositories';

const READ_ANY = 'disbursement.read.any';
const PAY = 'disbursement.pay';

const DETAIL = {
  lines: { orderBy: [{ phase: 'asc' }, { lineNo: 'asc' }] },
} satisfies Prisma.DisbursementInclude;

type Row = Prisma.DisbursementGetPayload<{ include: typeof DETAIL }>;

export interface Ticket {
  status: string;
  flowVersionId: string | null;
  currentStepCode: string | null;
  assigneeUserId: string | null;
  receiverUserId: string | null;
}

/** What happened to the ticket after the money was recorded. */
export interface TicketMove {
  moved: boolean;
  message: string | null;
}

const satang = (value: Prisma.Decimal | null) =>
  value ? Math.round(Number(value.toString()) * 100) : 0;

/**
 * การเบิก — created once its request is approved: accounting pays in instalments (and may void one),
 * the requester clears, accounting closes. Only a request on a flow from before v3 is moved by these
 * actions; on v3 the request is already done.
 */
@Injectable()
export class DisbursementsService {
  private readonly logger = new Logger(DisbursementsService.name);

  constructor(
    private readonly disbursements: DisbursementRepository,
    private readonly movements: DisbursementMovementRepository,
    private readonly files: DisbursementFileRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly sync: DisbursementRequestSyncService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(actor: Principal, query: ListDisbursementsQueryDto) {
    const { skip, take } = toSkipTake(query);
    const where = await this.listWhere(actor, query);
    const [rows, total] = await Promise.all([
      this.disbursements.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }) as Promise<Row[]>,
      this.disbursements.count({ where }) as Promise<number>,
    ]);
    return paginated(rows.map(summary), query, total);
  }

  async detail(actor: Principal, docNo: string) {
    const row = await this.require(actor, { docNo });
    const [movements, files, ticket, steps, legacy] = await Promise.all([
      this.movements.findMany({
        where: { disbursementId: row.id },
        orderBy: { actedAt: 'asc' },
      }),
      this.files.findMany({
        where: { disbursementId: row.id, deletedAt: null },
        select: {
          id: true,
          kind: true,
          fileName: true,
          mimeType: true,
          sizeBytes: true,
          uploadedBy: true,
          uploadedAt: true,
        },
        orderBy: { uploadedAt: 'asc' },
      }),
      this.ticketOf(row.requestId),
      this.sync.settingsOf(row.companyId),
      this.sync.isLegacyRequest(row.requestId),
    ]);
    return {
      ...present(row),
      /** Worked through the request's own steps (a flow from before v3). */
      legacy,
      movements,
      files,
      ticket: ticket
        ? {
            requestId: row.requestId,
            status: ticket.status,
            stepCode: ticket.currentStepCode,
            assigneeUserId: ticket.assigneeUserId,
          }
        : null,
      workSteps: steps
        ? {
            verify: steps.verifyStep,
            exec: steps.execStep,
            pay: steps.payStep,
            clear: steps.clearStep,
          }
        : null,
    };
  }

  /** POST from-request — the manual path when the automatic one failed. */
  async fromRequest(actor: Principal, requestNo: string) {
    const request = (await this.requestRows.findFirst({
      where: { requestNo, companyId: actor.activeCompanyId },
      select: { id: true },
    })) as { id: string } | null;
    if (!request) throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ');
    const { docNo, created } = await this.sync.createFromRequest(request.id);
    return { ...(await this.detail(actor, docNo)), created };
  }

  async byRequestNo(actor: Principal, requestNo: string) {
    const row = await this.require(actor, { requestNo });
    return this.detail(actor, row.docNo);
  }

  /** Screen 4 — accounting's checks, then the ticket goes on to the executive. */
  async verify(
    actor: Principal,
    docNo: string,
    dto: VerifyDisbursementDto,
    authorization: string,
  ) {
    const row = await this.require(actor, { docNo });
    if (row.status !== 'PENDING_VERIFY') {
      throw new AppError('CONFLICT', 'ใบเบิกนี้ไม่ได้รอบัญชีตรวจสอบ');
    }
    assertNotRequester(row, actor, 'ตรวจสอบใบเบิก');
    const legacy = await this.sync.isLegacyRequest(row.requestId);
    const ticket = await this.assertWorksTheTicket(row, actor, legacy ? 'verify' : 'work');
    const checks = {
      checked_cost_center: dto.checked_cost_center,
      checked_documents: dto.checked_documents,
      checked_authority: dto.checked_authority,
    };
    // Old flow: the executive approves next on the request. Flowless and v3: verified = payable
    // (on v3 the executive approved before accounting received it).
    const to: DisbursementStatus = legacy && ticket.flowVersionId ? 'PENDING_VERIFY' : 'APPROVED';
    await this.move(actor, row, to, 'disbursement.verified', {
      verifyChecks: checks,
      verifyNote: dto.note,
      verifiedBy: actor.userId,
      verifiedAt: new Date(),
      ...(to === 'APPROVED' ? { approvedAt: new Date() } : {}),
    });
    const move = legacy && ticket.flowVersionId
      ? await this.advanceTicket(row, actor, authorization, 'exec', {
          ...checks,
          note: dto.note,
        })
      : null;
    return { ...(await this.detail(actor, docNo)), ticketMove: move };
  }

  /** Screen 5 — one instalment. Paid in full, an advance waits for clearing; petty cash for closing. */
  async pay(
    actor: Principal,
    docNo: string,
    dto: PayDisbursementDto,
    authorization: string,
  ) {
    const row = await this.require(actor, { docNo });
    if (!['APPROVED', 'PARTIALLY_PAID'].includes(row.status)) {
      throw new AppError('CONFLICT', 'จ่ายได้เฉพาะใบเบิกที่อนุมัติแล้วและยังจ่ายไม่ครบ');
    }
    assertNotRequester(row, actor, 'จ่ายเงิน');
    const amount = Math.round(dto.amount * 100);
    const paidBefore = satang(row.paidAmount);
    const blocker = payBlocker(amount, paidBefore, satang(row.requestedAmount));
    if (blocker) {
      throw new AppError('VALIDATION_FAILED', blocker, [{ field: 'amount', reason: blocker }]);
    }
    const paid = paidBefore + amount;
    const legacy = await this.sync.isLegacyRequest(row.requestId);
    const full = statusForPaid(paid, satang(row.requestedAmount)) === 'PAID';
    // The old flow closed petty cash on payment; v3 waits for accounting to close it.
    const to: DisbursementStatus =
      legacy && full && row.kind === 'PETTY_CASH' ? 'CLOSED' : statusForPaid(paid, satang(row.requestedAmount));
    const now = new Date();
    await this.move(
      actor,
      row,
      to,
      'disbursement.paid',
      {
        paidAmount: fromSatang(paid),
        paidBy: actor.userId,
        paidAt: now,
        ...(to === 'CLOSED' ? { closedBy: actor.userId, closedAt: now } : {}),
      },
      async (prisma) => {
        await prisma.disbursementMovement.create({
          data: {
            companyId: row.companyId,
            disbursementId: row.id,
            type: 'PAYOUT',
            amount: fromSatang(-amount),
            method: dto.method,
            reference: dto.reference ?? null,
            occurredAt: dto.paid_at ? new Date(`${dto.paid_at}T00:00:00Z`) : now,
            actedBy: actor.userId,
          },
        });
      },
      { amount: fromSatang(amount), paidAmount: fromSatang(paid) },
    );
    const clearBy = full && row.kind === 'ADVANCE' ? thaiDate(row.clearBy) : null;
    await this.notifications.disbursementNotice(
      [row.requesterId],
      row.companyId,
      'disbursement.paid',
      row.id,
      {
        doc_no: row.docNo,
        amount: formatBaht(amount),
        clear_note: clearBy ? ` — ส่งเคลียร์ค่าใช้จ่ายภายใน ${clearBy}` : '',
      },
    );
    const ticketMove =
      legacy && full
        ? await this.finishOrAdvance(row, actor, authorization, to === 'CLOSED' ? 'end' : 'clear')
        : null;
    return { ...(await this.detail(actor, docNo)), ticketMove };
  }

  /** Cancels one instalment before clearing starts; the money record is reversed, never deleted. */
  async voidPayment(actor: Principal, docNo: string, movementId: string, dto: VoidPaymentDto) {
    const row = await this.require(actor, { docNo });
    if (!['PARTIALLY_PAID', 'PAID'].includes(row.status)) {
      throw new AppError('CONFLICT', 'ยกเลิกงวดจ่ายได้ก่อนเริ่มเคลียร์หรือก่อนปิดเท่านั้น');
    }
    if (await this.sync.isLegacyRequest(row.requestId)) {
      throw new AppError('CONFLICT', 'ใบเบิกตาม flow เดิมยกเลิกงวดจ่ายไม่ได้');
    }
    assertNotRequester(row, actor, 'ยกเลิกการจ่าย');
    const [payout, voided] = await Promise.all([
      this.movements.findFirst({
        where: { id: movementId, disbursementId: row.id, type: 'PAYOUT' },
      }),
      this.movements.findFirst({
        where: { reversesId: movementId, type: 'PAYOUT_VOID' },
      }),
    ]);
    if (!payout) throw new AppError('NOT_FOUND', 'ไม่พบงวดจ่ายที่ระบุ');
    if (voided) throw new AppError('CONFLICT', 'งวดนี้ถูกยกเลิกไปแล้ว');
    if (payout.actedBy === actor.userId) {
      throw new AppError('FORBIDDEN', 'ผู้จ่ายงวดนี้ยกเลิกเองไม่ได้ ต้องให้เจ้าหน้าที่อีกคนยกเลิก');
    }
    const amount = -satang(payout.amount);
    const paid = satang(row.paidAmount) - amount;
    const to = statusForPaid(paid, satang(row.requestedAmount));
    await this.move(
      actor,
      row,
      to,
      'disbursement.payment_voided',
      { paidAmount: fromSatang(paid) },
      async (prisma) => {
        await prisma.disbursementMovement.create({
          data: {
            companyId: row.companyId,
            disbursementId: row.id,
            type: 'PAYOUT_VOID',
            amount: fromSatang(amount),
            reversesId: payout.id,
            note: dto.reason,
            occurredAt: new Date(),
            actedBy: actor.userId,
          },
        });
      },
      { voided: payout.id, amount: fromSatang(amount), reason: dto.reason },
    );
    await this.notifications.disbursementNotice(
      [row.requesterId],
      row.companyId,
      'disbursement.payment_voided',
      row.id,
      { doc_no: row.docNo, amount: formatBaht(amount), reason: dto.reason },
    );
    return this.detail(actor, docNo);
  }

  /** Screen 6 — the requester's actual spend. */
  async submitClearing(
    actor: Principal,
    docNo: string,
    dto: SubmitClearingDto,
  ) {
    const row = await this.require(actor, { docNo });
    if (row.requesterId !== actor.userId) {
      throw new AppError('FORBIDDEN', 'เฉพาะผู้ขอเบิกเท่านั้นที่ส่งเคลียร์ได้');
    }
    this.assertMove(row, 'CLEARING');
    const { lines, problems } = linesFromItems(dto.items);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'items', reason })),
      );
    }
    await this.move(
      actor,
      row,
      'CLEARING',
      'disbursement.clearing_submitted',
      {
        actualAmount: fromSatang(totalSatang(lines)),
        clearingAt: new Date(),
      },
      async (prisma) => {
        await prisma.disbursementLine.deleteMany({
          where: { disbursementId: row.id, phase: 'ACTUAL' },
        });
        await prisma.disbursementLine.createMany({
          data: lineRows(lines, 'ACTUAL').map((line) => ({
            ...line,
            disbursementId: row.id,
          })),
        });
      },
    );
    await this.notifications.disbursementNotice(
      [row.verifiedBy, row.paidBy],
      row.companyId,
      'disbursement.clearing_submitted',
      row.docNo,
      { doc_no: row.docNo, amount: formatBaht(totalSatang(lines)) },
    );
    return this.detail(actor, docNo);
  }

  async returnClearing(
    actor: Principal,
    docNo: string,
    dto: ReturnClearingDto,
  ) {
    const row = await this.require(actor, { docNo });
    if (row.status !== 'CLEARING') {
      throw new AppError('CONFLICT', 'ใบเบิกนี้ไม่ได้รอตรวจเอกสารเคลียร์');
    }
    await this.move(
      actor,
      row,
      'PAID',
      'disbursement.clearing_returned',
      {},
      undefined,
      { reason: dto.reason },
    );
    await this.notifications.disbursementNotice(
      [row.requesterId],
      row.companyId,
      'disbursement.clearing_returned',
      row.docNo,
      { doc_no: row.docNo, reason: dto.reason },
    );
    return this.detail(actor, docNo);
  }

  /**
   * Screen 7 — an advance settles the difference (refund or extra pay) after clearing;
   * petty cash closes once paid in full. A request on the old flow is then finished.
   */
  async close(
    actor: Principal,
    docNo: string,
    dto: CloseDisbursementDto,
    authorization: string,
  ) {
    const row = await this.require(actor, { docNo });
    const advance = row.kind === 'ADVANCE';
    if (advance ? row.status !== 'CLEARING' : row.status !== 'PAID') {
      throw new AppError(
        'CONFLICT',
        advance ? 'ปิดได้เฉพาะเงินทดรองที่ส่งเคลียร์แล้ว' : 'ปิดได้เมื่อจ่ายเงินสดย่อยครบแล้ว',
      );
    }
    assertNotRequester(row, actor, 'ปิดใบเบิก');
    const { refundSatang, extraPaySatang } = advance
      ? settlement(satang(row.paidAmount), satang(row.actualAmount))
      : { refundSatang: 0, extraPaySatang: 0 };
    if ((refundSatang || extraPaySatang) && !dto.method) {
      throw new AppError(
        'VALIDATION_FAILED',
        'มีส่วนต่าง ต้องระบุวิธีรับคืน/จ่ายเพิ่ม',
        [{ field: 'method', reason: 'required' }],
      );
    }
    const now = new Date();
    await this.move(
      actor,
      row,
      'CLOSED',
      'disbursement.closed',
      {
        refundAmount: fromSatang(refundSatang),
        extraPaidAmount: fromSatang(extraPaySatang),
        closedBy: actor.userId,
        closedAt: now,
      },
      async (prisma) => {
        if (!refundSatang && !extraPaySatang) return;
        await prisma.disbursementMovement.create({
          data: {
            companyId: row.companyId,
            disbursementId: row.id,
            type: refundSatang ? 'REFUND' : 'EXTRA_PAY',
            amount: refundSatang
              ? fromSatang(refundSatang)
              : fromSatang(-extraPaySatang),
            method: dto.method ?? null,
            reference: dto.reference ?? null,
            occurredAt: dto.occurred_at ? new Date(`${dto.occurred_at}T00:00:00Z`) : now,
            counterpartyUserId: dto.counterparty_user_id ?? row.requesterId,
            actedBy: actor.userId,
          },
        });
      },
    );
    await this.notifications.disbursementNotice(
      [row.requesterId],
      row.companyId,
      'disbursement.closed',
      row.id,
      {
        doc_no: row.docNo,
        settlement: refundSatang
          ? `คืนเงิน ${formatBaht(refundSatang)} บาท`
          : extraPaySatang
            ? `เบิกเพิ่ม ${formatBaht(extraPaySatang)} บาท`
            : 'ใช้เงินครบตามยอดเบิก',
      },
    );
    // Closing the disbursement is what lets the request leave its work step for DONE.
    const ticketMove = await this.finishOrAdvance(row, actor, authorization, 'end');
    return { ...(await this.detail(actor, docNo)), ticketMove };
  }

  /** The disbursement row a file belongs to, for `DisbursementFilesService`. */
  async rowFor(actor: Principal, docNo: string) {
    return this.require(actor, { docNo });
  }

  // --- the ticket ------------------------------------------------------------

  /** Flow v2: advance; a flowless request is completed instead at the end. */
  private async finishOrAdvance(
    row: Row,
    actor: Principal,
    authorization: string,
    to: 'clear' | 'end',
  ): Promise<TicketMove> {
    const ticket = await this.ticketOf(row.requestId);
    if (ticket?.flowVersionId) {
      return this.advanceTicket(row, actor, authorization, to);
    }
    if (to === 'end') return this.completeFlowless(row, actor, authorization);
    return { moved: false, message: null };
  }

  /** Outside the money's transaction: a failure leaves the step for whoever holds it to move. */
  private async advanceTicket(
    row: Row,
    actor: Principal,
    authorization: string,
    to: 'exec' | 'clear' | 'end',
    stepForm?: Record<string, unknown>,
  ): Promise<TicketMove> {
    const steps: DisbursementSettingsRow | null = await this.sync.settingsOf(
      row.companyId,
    );
    const target =
      to === 'end'
        ? steps?.doneStep
        : to === 'exec'
          ? steps?.execStep
          : steps?.clearStep;
    if (!target) {
      return { moved: false, message: 'ยังไม่ได้ตั้งรหัสขั้นของการเบิก' };
    }
    try {
      if (stepForm) {
        await this.requests.saveStepForm(row.requestId, { data: stepForm }, actor);
      }
      await this.requests.advance(
        row.requestId,
        { to_step: target },
        actor,
        authorization,
      );
      return { moved: true, message: null };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`disbursement ${row.docNo}: ticket not moved: ${message}`);
      return { moved: false, message };
    }
  }

  private async completeFlowless(
    row: Row,
    actor: Principal,
    authorization: string,
  ): Promise<TicketMove> {
    try {
      await this.requests.complete(row.requestId, actor, authorization, {
        receiver_form_data: {
          ...((row.verifyChecks as Record<string, unknown> | null) ?? {}),
          note: row.verifyNote ?? '',
        },
      });
      return { moved: true, message: null };
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`disbursement ${row.docNo}: request not completed: ${message}`);
      return { moved: false, message };
    }
  }

  private async ticketOf(requestId: string): Promise<Ticket | null> {
    // BaseRepository's return type drops Prisma's `select` generics.
    return (await this.requestRows.findFirst({
      where: { id: requestId },
      select: {
        status: true,
        flowVersionId: true,
        currentStepCode: true,
        assigneeUserId: true,
        receiverUserId: true,
      },
    })) as Ticket | null;
  }

  /** Accounting acts on the ticket it holds, at the step this action belongs to. */
  private async assertWorksTheTicket(
    row: Row,
    actor: Principal,
    step: 'verify' | 'work',
  ): Promise<Ticket> {
    const ticket = await this.ticketOf(row.requestId);
    if (!ticket || ticket.status !== 'in_progress') {
      throw new AppError('CONFLICT', 'ต้องรับคำขอ (receive) ก่อนจึงตรวจสอบได้');
    }
    if (ticket.flowVersionId) {
      const steps = await this.sync.settingsOf(row.companyId);
      const expected = step === 'work' ? WORK_STEP : steps?.verifyStep;
      if (ticket.currentStepCode !== expected) {
        throw new AppError('CONFLICT', `คำขอไม่ได้อยู่ที่ขั้น ${step}`);
      }
    }
    if (![ticket.assigneeUserId, ticket.receiverUserId].includes(actor.userId)) {
      throw new AppError(
        'FORBIDDEN',
        'เฉพาะผู้รับผิดชอบคำขอนี้เท่านั้นที่ตรวจสอบได้',
      );
    }
    return ticket;
  }

  // --- rows --------------------------------------------------------------------

  private async move(
    actor: Principal,
    row: Row,
    to: DisbursementStatus,
    eventType: string,
    data: Prisma.DisbursementUncheckedUpdateManyInput,
    also?: (prisma: Prisma.TransactionClient) => Promise<void>,
    auditExtra: Record<string, unknown> = {},
  ) {
    await this.transactions.execute(async (prisma) => {
      // Guarded on the status and amount it was read at: a second click, or a racing
      // instalment, finds nothing to move instead of paying twice.
      const moved = await prisma.disbursement.updateMany({
        where: { id: row.id, status: row.status, paidAmount: row.paidAmount },
        data: { ...data, status: to, updatedBy: actor.userId },
      });
      if (!moved.count) {
        throw new AppError(
          'CONFLICT',
          'ใบเบิกถูกเปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่',
        );
      }
      if (also) await also(prisma);
      await this.audit.record(
        {
          eventType,
          companyId: row.companyId,
          ...auditActor(actor),
          resourceType: 'disbursement',
          resourceId: row.id,
          before: { status: row.status },
          after: { status: to, ...auditExtra },
        },
        { prisma },
      );
    });
  }

  private assertMove(row: Row, to: DisbursementStatus) {
    const blocker = moveBlocker(
      row.kind as DisbursementKind,
      row.status as DisbursementStatus,
      to,
    );
    if (blocker) throw new AppError('CONFLICT', blocker);
  }

  /**
   * Who sees a disbursement: its requester, anyone who may open its request, and accounting
   * (`read.any` / `pay`). Lists, detail, summary and reports all filter through this one.
   */
  async visibleWhere(actor: Principal, scope?: string): Promise<Prisma.DisbursementWhereInput> {
    const company = { companyId: actor.activeCompanyId };
    if (scope === 'mine') return { ...company, requesterId: actor.userId };
    if (actor.permissions.includes(READ_ANY) || actor.permissions.includes(PAY)) return company;
    const typeCodes = await this.sync.typeCodes(actor.activeCompanyId);
    const requests = (await this.requestRows.findMany({
      where: { AND: [visibleRequestsWhere(accessSubject(actor)), { typeCode: { in: typeCodes } }] },
      select: { id: true },
    })) as { id: string }[];
    return {
      ...company,
      OR: [{ requesterId: actor.userId }, { requestId: { in: requests.map((r) => r.id) } }],
    };
  }

  async listWhere(
    actor: Principal,
    query: Pick<ListDisbursementsQueryDto, 'scope' | 'kind' | 'status' | 'overdue'>,
  ): Promise<Prisma.DisbursementWhereInput> {
    const statuses = (query.status ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    return {
      AND: [
        await this.visibleWhere(actor, query.scope),
        query.kind ? { kind: query.kind } : {},
        statuses.length ? { status: { in: statuses } } : {},
        query.overdue ? overdueWhere(new Date()) : {},
      ],
    };
  }

  /** Out of scope answers 404, like every read (SCOPE-03). */
  private async require(
    actor: Principal,
    key: { docNo: string } | { requestNo: string },
  ): Promise<Row> {
    const row = (await this.disbursements.findFirst({
      where: { AND: [await this.visibleWhere(actor), key] },
      include: DETAIL,
    })) as Row | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบเบิกที่ระบุ');
    return row;
  }
}

function summary(row: Row) {
  return {
    docNo: row.docNo,
    kind: row.kind,
    status: row.status,
    requestNo: row.requestNo,
    requesterId: row.requesterId,
    purpose: row.purpose,
    requestedAmount: row.requestedAmount.toString(),
    paidAmount: row.paidAmount.toString(),
    actualAmount: row.actualAmount?.toString() ?? null,
    clearBy: row.clearBy,
    createdAt: row.createdAt,
  };
}

function present(row: Row) {
  const pick = (phase: string) =>
    (row.lines ?? [])
      .filter((line) => line.phase === phase)
      .map((line) => ({
        lineNo: line.lineNo,
        description: line.description,
        costCenter: line.costCenter,
        amount: line.amount.toString(),
        note: line.note,
        receiptDate: line.receiptDate,
      }));
  const { refundSatang, extraPaySatang } = settlement(
    satang(row.paidAmount),
    satang(row.actualAmount),
  );
  return {
    ...summary(row),
    requestId: row.requestId,
    orgUnitId: row.orgUnitId,
    payee: row.payee,
    costCenter: row.costCenter,
    neededBy: row.neededBy,
    references: {
      soNo: row.soNo,
      soSubject: row.soSubject,
      ticketNo: row.ticketNo,
      projectCode: row.projectCode,
    },
    currency: row.currency,
    refundAmount: row.refundAmount.toString(),
    extraPaidAmount: row.extraPaidAmount.toString(),
    /** What closing would settle now, from the amounts on record. */
    pending:
      row.status === 'CLEARING'
        ? {
            refund: fromSatang(refundSatang),
            extraPay: fromSatang(extraPaySatang),
          }
        : null,
    verify: row.verifiedAt
      ? {
          checks: row.verifyChecks,
          note: row.verifyNote,
          by: row.verifiedBy,
          at: row.verifiedAt,
        }
      : null,
    approvedAt: row.approvedAt,
    paidBy: row.paidBy,
    paidAt: row.paidAt,
    clearingAt: row.clearingAt,
    closedBy: row.closedBy,
    closedAt: row.closedAt,
    estimate: pick('ESTIMATE'),
    actual: pick('ACTUAL'),
  };
}

/** Separation of duties: nobody pays, voids or closes their own disbursement. */
function assertNotRequester(row: { requesterId: string }, actor: Principal, action: string) {
  if (row.requesterId === actor.userId) {
    throw new AppError('FORBIDDEN', `ผู้ขอเบิก${action}ของตัวเองไม่ได้`);
  }
}

/** An advance paid out but not closed, past its clearing date. */
export function overdueWhere(today: Date): Prisma.DisbursementWhereInput {
  const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return { kind: 'ADVANCE', status: { in: ['PAID', 'CLEARING'] }, clearBy: { lt: day } };
}
