import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  PrismaTransactionService,
} from '@request-management/share';
import {
  DISBURSEMENT_BINDINGS,
  requiredBindings,
  WORK_STEP,
} from '../../../../libs/prisma/disbursement-flows';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
} from '../events/event-catalog';
import { readBound } from '../requests/form-binding';
import { FormBindingRegistry } from '../requests/form-binding.registry';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { RunNumberClient } from '../run-number/run-number.client';
import {
  DisbursementKind,
  DisbursementStatus,
  fromSatang,
  headerFromForm,
  LineInput,
  leaveBlocker,
  linesFromItems,
  MONEY_OUT,
  RESNAPSHOT_AT,
  startStatus,
  statusOnRequestEvent,
  statusOnStep,
  totalSatang,
  WorkSteps,
} from './disbursement-rules';
import {
  DisbursementRepository,
  DisbursementSettingsRepository,
} from './disbursement.repositories';

interface RequestFacts {
  id: string;
  companyId: string;
  requestNo: string | null;
  typeCode: string;
  status: string;
  requesterId: string;
  requesterOrgUnitId: string | null;
  formData: unknown;
  flowVersionId: string | null;
  currentStepCode: string | null;
  stepFormData: unknown;
  typeSnapshot: unknown;
  flowVersion: { steps: { code: string; scopeStatus: string | null; formSchema: unknown }[] } | null;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

interface RequestPayload {
  request_id?: string;
  step_code?: string;
  status?: string;
}

export interface DisbursementSettingsRow extends WorkSteps {
  advanceTypeCode: string | null;
  pettyCashTypeCode: string | null;
}

interface StatusRow {
  id: string;
  companyId: string;
  docNo: string;
  kind: DisbursementKind;
  status: DisbursementStatus;
  verifiedAt: Date | null;
}

const SYSTEM = { actorId: null, actorUsername: 'system' } as const;

/**
 * การเบิก ↔ its request (docs/request-module-linkage.md): created when the request enters its work
 * step — after the head and the executive approved and accounting received it.
 * Requests on a flow from before v3 (one with a pay step) keep the old path: created at submit,
 * following the ticket's steps, and holding it at the money steps.
 */
@Injectable()
export class DisbursementRequestSyncService implements OnModuleInit {
  private readonly logger = new Logger(DisbursementRequestSyncService.name);

  constructor(
    private readonly disbursements: DisbursementRepository,
    private readonly settingsRows: DisbursementSettingsRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly runNumbers: RunNumberClient,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly bindings: FormBindingRegistry,
  ) {}

  onModuleInit(): void {
    this.bindings.register({
      target: 'disbursement',
      label: 'การเบิก',
      typeCodes: (companyId) => this.typeCodes(companyId),
      required: async (typeCode, companyId) =>
        requiredBindings(
          (await this.kindsOf(typeCode, companyId)).includes('ADVANCE') ? 'ADVANCE' : 'PETTY_CASH',
        ),
    });
    this.requests.addGuard('advance', (request, move) =>
      move ? this.guardAdvance(request, move) : Promise.resolve(),
    );
    this.requests.addGuard('complete', (request) =>
      this.guardComplete(request.id),
    );
    this.requests.addGuard('cancel', (request) => this.guardCancel(request.id));

    this.listen(DOMAIN_EVENTS.requestSubmitted, (p) => this.onSubmitted(p));
    this.listen(DOMAIN_EVENTS.requestResubmitted, (p) => this.onSubmitted(p));
    this.listen(DOMAIN_EVENTS.requestStepEntered, (p) => this.onStep(p));
    // Requests raised before the flow existed keep following the fixed lifecycle.
    this.listen(DOMAIN_EVENTS.requestPreApproved, (p) =>
      this.follow(p, 'pre_approved'),
    );
    this.listen(DOMAIN_EVENTS.requestReturned, (p) => this.follow(p, 'returned'));
    this.listen(DOMAIN_EVENTS.requestRejected, (p) => this.follow(p, 'rejected'));
    this.listen(DOMAIN_EVENTS.requestCancelled, (p) =>
      this.follow(p, 'cancelled'),
    );
  }

  private listen(
    name: DomainEventName,
    handler: (payload: RequestPayload) => Promise<void>,
  ): void {
    this.events.on(name, (event) =>
      handler(event.payload as RequestPayload).catch((error: Error) =>
        this.logger.warn(`disbursement ${name}: ${error.message}`),
      ),
    );
  }

  /** The ticket may not leave a money step before the money is recorded. */
  async guardAdvance(
    request: { id: string; companyId: string },
    move: { from: string; backward: boolean },
  ): Promise<void> {
    const row = await this.statusOf(request.id);
    if (!row) return;
    if (move.from === WORK_STEP && !move.backward && row.status !== 'CLOSED') {
      throw new AppError('CONFLICT', `ใบเบิก ${row.docNo} ยังไม่ปิด — ปิดการเบิกก่อน คำขอจึงไปขั้นปิดรายการได้`);
    }
    const steps = await this.settingsOf(request.companyId);
    if (!steps) return;
    const blocker = leaveBlocker(
      steps,
      { kind: row.kind, status: row.status, verified: Boolean(row.verifiedAt) },
      move,
    );
    if (blocker) throw new AppError('CONFLICT', `ใบเบิก ${row.docNo}: ${blocker}`);
  }

  /** Flowless requests: complete waits for the disbursement to close. */
  async guardComplete(requestId: string): Promise<void> {
    const row = await this.statusOf(requestId);
    if (row && row.status !== 'CLOSED') {
      throw new AppError(
        'CONFLICT',
        `ใบเบิก ${row.docNo} ยังไม่ปิด — ปิดการเบิกก่อนจึงจะจบคำขอได้`,
      );
    }
  }

  /** Once money is out it is cleared, not cancelled. */
  async guardCancel(requestId: string): Promise<void> {
    const row = await this.statusOf(requestId);
    if (row && MONEY_OUT.includes(row.status)) {
      throw new AppError(
        'CONFLICT',
        `ใบเบิก ${row.docNo} จ่ายเงินแล้ว — ยกเลิกคำขอไม่ได้ ต้องเคลียร์และปิดการเบิก`,
      );
    }
  }

  /** Old flows only: the disbursement is created (or re-read) when the request is sent. */
  async onSubmitted(payload: RequestPayload): Promise<void> {
    if (!payload.request_id) return;
    const request = await this.requestFacts(payload.request_id);
    if (!request) return;
    const kind = await this.kindOf(request.companyId, request.typeCode);
    const settings = await this.settingsOf(request.companyId);
    if (!kind || !settings || !isLegacy(request, settings)) return;

    const existing = await this.statusOf(request.id);
    if (existing) {
      if (RESNAPSHOT_AT.includes(existing.status)) {
        await this.resnapshot(existing.id, request, kind);
      }
      return;
    }
    await this.create(request, kind, settings, startStatus(request.status), 'legacy');
  }

  /**
   * The manual path when the work-step handler failed (handlers only log).
   * Idempotent: a request that already has its disbursement answers with that one's docNo.
   */
  async createFromRequest(requestId: string): Promise<{ docNo: string; created: boolean }> {
    const request = await this.requestFacts(requestId);
    if (!request) throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ');
    const existing = await this.statusOf(request.id);
    if (existing) return { docNo: existing.docNo, created: false };
    const atWork = request.status === 'in_progress' && request.currentStepCode === WORK_STEP;
    if (!atWork && !['approved', 'closed'].includes(request.status)) {
      throw new AppError('CONFLICT', 'สร้างใบเบิกได้เมื่อผู้บริหารอนุมัติและบัญชีรับเรื่องแล้วเท่านั้น');
    }
    const docNo = await this.createIfDue(request);
    if (!docNo) throw new AppError('CONFLICT', 'คำขอประเภทนี้ไม่ได้ผูกกับการเบิก');
    return { docNo, created: true };
  }

  private async createIfDue(request: RequestFacts): Promise<string | null> {
    const kind = await this.kindOf(request.companyId, request.typeCode);
    const settings = await this.settingsOf(request.companyId);
    if (!kind || !settings || isLegacy(request, settings)) return null;
    if (await this.statusOf(request.id)) return null;
    return this.create(request, kind, settings, 'PENDING_VERIFY', 'v3');
  }

  /**
   * The ticket moved. Entering the work step (after the executive approved and accounting
   * received) creates the disbursement; on an old flow its status follows the step.
   */
  async onStep(payload: RequestPayload): Promise<void> {
    if (!payload.request_id || !payload.step_code) return;
    if (payload.step_code === WORK_STEP && payload.status === 'in_progress') {
      const request = await this.requestFacts(payload.request_id);
      if (request) await this.createIfDue(request);
      return;
    }
    const row = await this.statusOf(payload.request_id);
    if (!row) return;
    const steps = await this.settingsOf(row.companyId);
    if (!steps) return;
    const to = statusOnStep(steps, row.status, {
      stepCode: payload.step_code,
      status: payload.status ?? '',
    });
    if (to) {
      await this.setStatus(row, to, 'disbursement.step_followed', payload.step_code);
    }
  }

  async follow(
    payload: RequestPayload,
    event: Parameters<typeof statusOnRequestEvent>[1],
  ): Promise<void> {
    if (!payload.request_id) return;
    const row = await this.statusOf(payload.request_id);
    if (!row) return;
    const to = statusOnRequestEvent(row.status, event);
    if (to) await this.setStatus(row, to, `disbursement.request_${event}`);
  }

  private async create(
    request: RequestFacts,
    kind: DisbursementKind,
    settings: DisbursementSettingsRow,
    status: DisbursementStatus,
    mode: 'legacy' | 'v3',
  ): Promise<string> {
    const form = formOf(request);
    const { lines, problems } = linesFromItems(form.expense_items);
    if (problems.length) {
      this.logger.warn(
        `request ${request.requestNo ?? request.id}: ${problems.join('; ')}`,
      );
    }

    // Issued before the transaction, like every run number (docs/run-number.md).
    const docNo = await this.runNumbers.issueUnused(
      {
        companyId: request.companyId,
        docType: kind,
        idempotencyKey: `disbursement:${request.id}`,
      },
      async (code) =>
        (await this.disbursements.count({
          where: { companyId: request.companyId, docNo: code },
        })) > 0,
    );
    const v3 = mode === 'v3';
    const now = new Date();

    await this.transactions.execute(async (prisma) => {
      const row = await prisma.disbursement.create({
        data: {
          companyId: request.companyId,
          docNo,
          kind,
          requestId: request.id,
          requestNo: request.requestNo,
          requesterId: request.requesterId,
          orgUnitId: request.requesterOrgUnitId,
          ...headerData(headerFromForm(form), kind),
          status,
          requestedAmount: fromSatang(totalSatang(lines)),
          createdBy: request.requesterId,
          lines: { create: lineRows(lines, 'ESTIMATE') },
          // The head and the executive have approved on the request by now.
          ...(v3
            ? {
                approvedAt: now,
                sourceSnapshot: {
                  requestNo: request.requestNo,
                  flowVersionId: request.flowVersionId,
                  formData: asRecord(request.formData) as Prisma.InputJsonObject,
                  approvedAt: now.toISOString(),
                },
              }
            : {}),
        },
      });
      await this.audit.record(
        {
          eventType: 'disbursement.created',
          companyId: request.companyId,
          ...SYSTEM,
          resourceType: 'disbursement',
          resourceId: row.id,
          after: {
            docNo,
            kind,
            requestId: request.id,
            status,
            requestedAmount: row.requestedAmount.toString(),
          },
        },
        { prisma },
      );
    });
    return docNo;
  }

  private async resnapshot(
    id: string,
    request: RequestFacts,
    kind: DisbursementKind,
  ) {
    const form = formOf(request);
    const { lines } = linesFromItems(form.expense_items);
    const status = startStatus(request.status);
    await this.transactions.execute(async (prisma) => {
      await prisma.disbursementLine.deleteMany({
        where: { disbursementId: id, phase: 'ESTIMATE' },
      });
      await prisma.disbursement.update({
        where: { id },
        data: {
          ...headerData(headerFromForm(form), kind),
          status,
          requestedAmount: fromSatang(totalSatang(lines)),
          updatedBy: request.requesterId,
          lines: { create: lineRows(lines, 'ESTIMATE') },
        },
      });
      await this.audit.record(
        {
          eventType: 'disbursement.resubmitted',
          companyId: request.companyId,
          ...SYSTEM,
          resourceType: 'disbursement',
          resourceId: id,
          after: { status, requestedAmount: fromSatang(totalSatang(lines)) },
        },
        { prisma },
      );
    });
  }

  private async setStatus(
    row: StatusRow,
    to: DisbursementStatus,
    eventType: string,
    stepCode?: string,
  ) {
    await this.transactions.execute(async (prisma) => {
      // Guarded on the status it was read at, so a racing event changes nothing.
      const moved = await prisma.disbursement.updateMany({
        where: { id: row.id, status: row.status },
        data: {
          status: to,
          ...(to === 'APPROVED' ? { approvedAt: new Date() } : {}),
          ...(to === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
        },
      });
      if (!moved.count) return;
      await this.audit.record(
        {
          eventType,
          companyId: row.companyId,
          ...SYSTEM,
          resourceType: 'disbursement',
          resourceId: row.id,
          before: { status: row.status },
          after: { status: to, ...(stepCode ? { step: stepCode } : {}) },
        },
        { prisma },
      );
    });
  }

  /** The type codes mapped to a disbursement, in one company or in all of them. */
  async typeCodes(companyId?: string): Promise<string[]> {
    const rows = (await this.settingsRows.findMany({
      where: companyId ? { companyId } : {},
    })) as DisbursementSettingsRow[];
    return rows.flatMap((row) =>
      [row.advanceTypeCode, row.pettyCashTypeCode].filter((code): code is string => !!code),
    );
  }

  private async kindsOf(typeCode: string, companyId?: string): Promise<DisbursementKind[]> {
    const rows = (await this.settingsRows.findMany({
      where: companyId ? { companyId } : {},
    })) as DisbursementSettingsRow[];
    return rows.flatMap((row): DisbursementKind[] => [
      ...(row.advanceTypeCode === typeCode ? (['ADVANCE'] as const) : []),
      ...(row.pettyCashTypeCode === typeCode ? (['PETTY_CASH'] as const) : []),
    ]);
  }

  /** Whether this request's disbursement is still worked through the request's own steps. */
  async isLegacyRequest(requestId: string): Promise<boolean> {
    const request = await this.requestFacts(requestId);
    if (!request) return false;
    const settings = await this.settingsOf(request.companyId);
    return !!settings && isLegacy(request, settings);
  }

  /** The company's mapping, or null when it has none. */
  async settingsOf(companyId: string): Promise<DisbursementSettingsRow | null> {
    // BaseRepository's return type drops Prisma's generics.
    return (await this.settingsRows.findFirst({
      where: { companyId },
    })) as DisbursementSettingsRow | null;
  }

  private async kindOf(
    companyId: string,
    typeCode: string,
  ): Promise<DisbursementKind | null> {
    const config = await this.settingsOf(companyId);
    if (config?.advanceTypeCode === typeCode) return 'ADVANCE';
    if (config?.pettyCashTypeCode === typeCode) return 'PETTY_CASH';
    return null;
  }

  private async statusOf(requestId: string): Promise<StatusRow | null> {
    return (await this.disbursements.findFirst({
      where: { requestId },
      select: {
        id: true,
        companyId: true,
        docNo: true,
        kind: true,
        status: true,
        verifiedAt: true,
      },
    })) as StatusRow | null;
  }

  private async requestFacts(requestId: string): Promise<RequestFacts | null> {
    return (await this.requestRows.findFirst({
      where: { id: requestId },
      select: {
        id: true,
        companyId: true,
        requestNo: true,
        typeCode: true,
        status: true,
        requesterId: true,
        requesterOrgUnitId: true,
        formData: true,
        flowVersionId: true,
        currentStepCode: true,
        stepFormData: true,
        typeSnapshot: true,
        flowVersion: {
          select: {
            steps: {
              orderBy: { sortOrder: 'asc' },
              select: { code: true, scopeStatus: true, formSchema: true },
            },
          },
        },
      },
    })) as RequestFacts | null;
  }
}

/**
 * A request on a flow from before v3 — none at all, or one with the pay step — keeps the old
 * path: created at submit, its money worked through the request's own steps.
 */
export function isLegacy(
  request: Pick<RequestFacts, 'flowVersionId' | 'flowVersion'>,
  settings: Pick<WorkSteps, 'payStep'>,
): boolean {
  if (!request.flowVersionId) return true;
  return !!settings.payStep && !!request.flowVersion?.steps.some((step) => step.code === settings.payStep);
}

/** The request form read through `x-bind`, in the key shape `headerFromForm` / `linesFromItems` take. */
function formOf(request: RequestFacts): Record<string, unknown> {
  const schema =
    request.flowVersion?.steps.find((step) => step.scopeStatus === 'draft')?.formSchema ??
    asRecord(request.typeSnapshot).formSchema;
  const bound = readBound(schema, request.formData, 'disbursement', DISBURSEMENT_BINDINGS);
  return { ...bound, expense_items: bound.lines };
}

function headerData(
  header: ReturnType<typeof headerFromForm>,
  kind: DisbursementKind,
) {
  return {
    payee: header.payee,
    costCenter: header.costCenter,
    purpose: header.purpose,
    neededBy: dateOrNull(header.neededBy),
    clearBy: kind === 'ADVANCE' ? dateOrNull(header.clearBy) : null,
    soNo: header.soNo,
    soSubject: header.soSubject,
    ticketNo: header.ticketNo,
    projectCode: header.projectCode,
  };
}

function dateOrNull(value: string | null): Date | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : null;
}

export function lineRows(
  lines: readonly LineInput[],
  phase: 'ESTIMATE' | 'ACTUAL',
) {
  return lines.map((line, index) => ({
    phase,
    lineNo: index + 1,
    description: line.description,
    costCenter: line.costCenter,
    amount: fromSatang(line.amountSatang),
    note: line.note,
    receiptDate: dateOrNull(line.receiptDate),
  }));
}
