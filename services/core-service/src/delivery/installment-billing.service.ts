import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  Principal,
  PrismaService,
} from '@request-management/share';
import { approvalStateOf } from '../crm/contract-terms';
import { thaiToday } from '../crm/vendor-costs';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { DomainEventsService } from '../events/domain-events.service';
import { RequestsService } from '../requests/requests.service';
import { billingBlockers, installmentReference } from './billing-rules';
import { DeliveriesService } from './deliveries.service';
import { InstallmentErpSyncService } from './installment-erp-sync.service';

const day = (value: Date) => value.toISOString().slice(0, 10);
/** Finance has posted it (or been paid): only a credit note undoes that. */
const POSTED = ['open', 'paid'];

const KIND_TH: Record<string, string> = {
  deposit: 'เงินมัดจำ',
  progress: 'งวดตามความคืบหน้า',
  final: 'งวดสุดท้าย',
  retention: 'คืนเงินประกันผลงาน',
};

interface InvoiceRow {
  id: string;
  seq: number;
  status: string;
  reference: string;
  amount: Prisma.Decimal;
  exceptionStatus: string;
  exceptionRequestId: string | null;
  exceptionReason: string | null;
  confirmedAt: Date | null;
  confirmedBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  erpStatus: string;
  erpDraftNo: string | null;
  erpLastError: string | null;
  erpInvoiceStatus: string | null;
  erpInvoiceNo: string | null;
  erpPaid: Prisma.Decimal | null;
}

/**
 * CD-253 ตัวจุดชนวนวางบิลรายงวด (part of CD-20 Delivery).
 *
 * Every installment of the project's contract, with what still stands in the
 * way of billing it (see billing-rules.ts); once nothing does, the project's
 * manager sends it — a draft A/R invoice in SAP through the store-and-forward
 * queue (CD-242's way), finance posts it, and its invoice number and payment
 * come back into the installment tracking (CD-193). An installment is billed
 * once; a draft finance has not posted can be withdrawn. Open points left by
 * a conditional acceptance block billing unless the company's executives
 * approve an exception (a request of the type set in CRM settings).
 *
 * Who: whoever sees the project reads; its manager or `pm.project.manage`
 * sends, withdraws and asks for an exception, while it runs.
 */
@Injectable()
export class InstallmentBillingService implements OnModuleInit {
  private readonly logger = new Logger(InstallmentBillingService.name);

  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly prisma: PrismaService,
    private readonly requests: RequestsService,
    private readonly events: DomainEventsService,
    private readonly erpSync: InstallmentErpSyncService,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    // the executives' answer to an exception
    for (const name of [
      DOMAIN_EVENTS.requestApproved,
      DOMAIN_EVENTS.requestCompleted,
      DOMAIN_EVENTS.requestRejected,
      DOMAIN_EVENTS.requestCancelled,
    ]) {
      this.events.on(name, (event) => {
        const payload = event.payload as { request_id?: string };
        if (!payload.request_id) return Promise.resolve();
        return this.syncException(payload.request_id).catch((error: Error) =>
          this.logger.warn(`billing exception not synced: ${error.message}`),
        );
      });
    }
  }

  /** The schedule with each installment's state and what blocks it. */
  async view(actor: Principal, projectId: string) {
    const { project } = await this.deliveries.access(actor, projectId);
    const ctx = await this.context(projectId);
    // a decision the event did not carry is read here
    for (const row of ctx.invoices.filter(
      (i) => i.exceptionStatus === 'submitted',
    )) {
      if (row.exceptionRequestId)
        await this.syncException(row.exceptionRequestId);
    }
    const fresh = await this.context(projectId);
    return {
      contract: {
        id: fresh.contract.id,
        contractNo: fresh.contract.contractNo,
        currency: fresh.contract.currency,
        signedOn: fresh.contract.signedOn ? day(fresh.contract.signedOn) : null,
      },
      canBill: this.mayBill(actor, project),
      exceptionTypeSet: Boolean(fresh.exceptionTypeCode),
      installments: fresh.installments.map((inst) => {
        const facts = this.factsOf(fresh, inst);
        const gate = billingBlockers(facts);
        const invoice = fresh.invoices.find((i) => i.seq === inst.seq) ?? null;
        return {
          seq: inst.seq,
          kind: inst.kind,
          kindLabel: KIND_TH[inst.kind] ?? inst.kind,
          label: inst.label,
          amount: Number(inst.amount),
          dueOn: inst.dueOn ? day(inst.dueOn) : null,
          milestone: inst.milestone
            ? {
                id: inst.milestone.id,
                title: inst.milestone.title,
                status: inst.milestone.status,
              }
            : null,
          reference: installmentReference(fresh.contract.contractNo, inst.seq),
          blockers: gate.blockers,
          exceptionable: gate.exceptionable,
          invoice: invoice && {
            status: invoice.status,
            confirmedAt: invoice.confirmedAt,
            cancelledAt: invoice.cancelledAt,
            cancelReason: invoice.cancelReason,
            exceptionStatus: invoice.exceptionStatus,
            exceptionReason: invoice.exceptionReason,
            exceptionRequestId: invoice.exceptionRequestId,
            erpStatus: invoice.erpStatus,
            erpLastError: invoice.erpLastError,
            erpInvoiceStatus: invoice.erpInvoiceStatus,
            erpInvoiceNo: invoice.erpInvoiceNo,
            erpPaid: invoice.erpPaid === null ? null : Number(invoice.erpPaid),
          },
        };
      }),
    };
  }

  /** The manager's go: the installment becomes a draft invoice in SAP. */
  async send(actor: Principal, projectId: string, seq: number, note: string) {
    const { project } = await this.deliveries.access(actor, projectId);
    this.assertBiller(actor, project);
    const ctx = await this.context(projectId);
    const inst = ctx.installments.find((i) => i.seq === seq);
    if (!inst) throw new AppError('NOT_FOUND', 'ไม่พบงวดที่ระบุ');
    const gate = billingBlockers(this.factsOf(ctx, inst));
    if (gate.blockers.length) {
      throw new AppError(
        'CONFLICT',
        `ยังวางบิลงวดนี้ไม่ได้ — ${gate.blockers[0]}`,
        gate.blockers.map((reason) => ({ field: 'installment', reason })),
      );
    }
    const reference = installmentReference(ctx.contract.contractNo, seq);
    const data = {
      kind: inst.kind,
      label: inst.label,
      reference,
      customerId: ctx.contract.customerId!,
      currency: ctx.contract.currency,
      amount: inst.amount,
      acceptanceId: inst.round?.id ?? null,
      status: 'sent',
      note: note.trim() || null,
      confirmedBy: actor.userId,
      confirmedAt: new Date(),
      cancelledBy: null,
      cancelledAt: null,
      cancelReason: null,
      erpStatus: 'pending',
      erpLastError: null,
    };
    const saved = await this.prisma.installmentInvoice.upsert({
      where: { contractId_seq: { contractId: ctx.contract.id, seq } },
      create: {
        ...data,
        companyId: project.companyId,
        projectId,
        contractId: ctx.contract.id,
        seq,
        createdBy: actor.userId,
      },
      update: { ...data, updatedBy: actor.userId },
      select: { id: true },
    });
    await this.audit.record({
      eventType: 'delivery.billing.sent',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { seq, reference, amount: Number(inst.amount), kind: inst.kind },
    });
    this.erpSync.kickCreate(saved.id);
    return this.view(actor, projectId);
  }

  /** Withdraw a sent installment while finance has not posted it. */
  async cancel(
    actor: Principal,
    projectId: string,
    seq: number,
    reason: string,
  ) {
    const { project } = await this.deliveries.access(actor, projectId);
    this.assertBiller(actor, project);
    const row = await this.invoiceOf(projectId, seq);
    if (!row || row.status !== 'sent') {
      throw new AppError('CONFLICT', 'งวดนี้ไม่ได้อยู่ระหว่างวางบิล');
    }
    if (row.erpInvoiceStatus && POSTED.includes(row.erpInvoiceStatus)) {
      throw new AppError(
        'CONFLICT',
        `ฝ่ายการเงินออกใบแจ้งหนี้ ${row.erpInvoiceNo ?? ''} แล้ว — ยกเลิกต้องออกใบลดหนี้ใน SAP`,
      );
    }
    if (!reason.trim())
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผล');
    await this.prisma.installmentInvoice.update({
      where: { id: row.id },
      data: {
        status: 'cancelled',
        cancelledBy: actor.userId,
        cancelledAt: new Date(),
        cancelReason: reason.trim(),
        erpStatus: row.erpDraftNo ? 'pending' : 'skipped',
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'delivery.billing.cancelled',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { seq, reference: row.reference, reason: reason.trim() },
    });
    if (row.erpDraftNo) this.erpSync.kickCancel(row.id);
    return this.view(actor, projectId);
  }

  /**
   * Ask the executives to bill before the open points are closed — a request
   * of the type set in CRM settings; approved, the installment may be sent.
   */
  async requestException(
    actor: Principal,
    projectId: string,
    seq: number,
    reason: string,
    authorization: string,
  ) {
    const { project } = await this.deliveries.access(actor, projectId);
    this.assertBiller(actor, project);
    if (!reason.trim())
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผล');
    const ctx = await this.context(projectId);
    if (!ctx.exceptionTypeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอยกเว้นการวางบิลในหน้าตั้งค่า CRM',
      );
    }
    const inst = ctx.installments.find((i) => i.seq === seq);
    if (!inst) throw new AppError('NOT_FOUND', 'ไม่พบงวดที่ระบุ');
    const gate = billingBlockers(this.factsOf(ctx, inst));
    if (!gate.exceptionable) {
      throw new AppError(
        'CONFLICT',
        gate.blockers.length
          ? `ขอยกเว้นได้เฉพาะเมื่อติดแค่รายการค้าง — ${gate.blockers[0]}`
          : 'งวดนี้วางบิลได้อยู่แล้ว',
      );
    }
    const existing = await this.invoiceOf(projectId, seq);
    if (existing?.exceptionStatus === 'submitted') {
      throw new AppError('CONFLICT', 'ส่งคำขอยกเว้นของงวดนี้ไปแล้ว รอผล');
    }
    const created = (await this.requests.create(
      {
        type_code: ctx.exceptionTypeCode,
        ref_type: 'project',
        ref_id: ctx.projectNo,
        form_data: {
          subject: `ขอวางบิล ${inst.label} ก่อนปิดรายการค้าง — ${ctx.projectNo}`,
          project_no: ctx.projectNo,
          contract_no: ctx.contract.contractNo,
          installment: `${inst.seq}. ${inst.label}`,
          amount: Number(inst.amount),
          open_points: inst.openPoints,
          reason: reason.trim(),
          detail: `${ctx.projectNo} — ${inst.label} ${Number(inst.amount).toLocaleString('th-TH')} ${ctx.contract.currency} · รายการค้าง ${inst.openPoints} ข้อ · เหตุผล: ${reason.trim()}`,
        },
      },
      actor,
    )) as { id: string };
    await this.requests.submit(created.id, actor, authorization);
    const base = {
      exceptionStatus: 'submitted',
      exceptionRequestId: created.id,
      exceptionReason: reason.trim(),
    };
    await this.prisma.installmentInvoice.upsert({
      where: { contractId_seq: { contractId: ctx.contract.id, seq } },
      create: {
        companyId: project.companyId,
        projectId,
        contractId: ctx.contract.id,
        seq,
        kind: inst.kind,
        label: inst.label,
        reference: installmentReference(ctx.contract.contractNo, seq),
        customerId: ctx.contract.customerId ?? '',
        currency: ctx.contract.currency,
        amount: inst.amount,
        createdBy: actor.userId,
        ...base,
      },
      update: { ...base, updatedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'delivery.billing.exception_requested',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { seq, requestId: created.id, reason: reason.trim() },
    });
    return this.view(actor, projectId);
  }

  /** The exception request's outcome, from the request engine. */
  async syncException(requestId: string) {
    const row = await this.prisma.installmentInvoice.findFirst({
      where: { exceptionRequestId: requestId, exceptionStatus: 'submitted' },
      select: { id: true, companyId: true, projectId: true, seq: true },
    });
    if (!row) return;
    const request = await this.prisma.request.findUnique({
      where: { id: requestId },
      select: { status: true },
    });
    const state = approvalStateOf(true, request);
    if (state !== 'approved' && state !== 'rejected') return;
    const claimed = await this.prisma.installmentInvoice.updateMany({
      where: { id: row.id, exceptionStatus: 'submitted' },
      data: { exceptionStatus: state },
    });
    if (!claimed.count) return;
    await this.audit.record({
      eventType: `delivery.billing.exception_${state}`,
      companyId: row.companyId,
      actorId: null,
      actorUsername: 'system',
      resourceType: 'project',
      resourceId: row.projectId,
      after: { seq: row.seq, requestId },
    });
  }

  // --- helpers ----------------------------------------------------------------

  private mayBill(
    actor: Principal,
    project: { status: string; managerUserId: string },
  ) {
    const running = project.status === 'active' || project.status === 'on_hold';
    return (
      running &&
      (hasPermission(actor, 'pm.project.manage') ||
        project.managerUserId === actor.userId)
    );
  }

  private assertBiller(
    actor: Principal,
    project: { status: string; managerUserId: string },
  ) {
    if (!this.mayBill(actor, project)) {
      throw new AppError(
        'FORBIDDEN',
        'ส่งวางบิลได้เฉพาะผู้จัดการโครงการ ขณะโครงการดำเนินอยู่',
      );
    }
  }

  private invoiceOf(projectId: string, seq: number) {
    return this.prisma.installmentInvoice.findFirst({
      where: { projectId, seq },
    }) as unknown as Promise<
      (InvoiceRow & { erpDraftNo: string | null }) | null
    >;
  }

  private factsOf(
    ctx: Awaited<ReturnType<InstallmentBillingService['context']>>,
    inst: Awaited<
      ReturnType<InstallmentBillingService['context']>
    >['installments'][number],
  ) {
    const invoice = ctx.invoices.find((i) => i.seq === inst.seq);
    const manual = ctx.manual.find((m) => m.seq === inst.seq);
    return {
      kind: inst.kind,
      today: thaiToday(),
      contractSigned: Boolean(ctx.contract.signedOn),
      hasCustomer: Boolean(ctx.contract.customerId),
      billed:
        invoice?.status === 'sent'
          ? ('here' as const)
          : manual &&
              manual.source !== 'sap' &&
              (manual.invoiceNo || manual.invoicedOn)
            ? ('manual' as const)
            : null,
      milestone: inst.milestone,
      certificateSigned: inst.certificateSigned,
      openPoints: inst.openPoints,
      exceptionApproved: invoice?.exceptionStatus === 'approved',
      milestonesOpen: ctx.milestonesOpen,
      warrantyEnds: ctx.warrantyEnds,
    };
  }

  /** Everything the gate reads, for one project, in a handful of queries. */
  private async context(projectId: string) {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: {
        projectNo: true,
        companyId: true,
        contract: {
          select: {
            id: true,
            contractNo: true,
            currency: true,
            signedOn: true,
            customerId: true,
            installments: {
              orderBy: { seq: 'asc' },
              select: {
                seq: true,
                kind: true,
                label: true,
                amount: true,
                dueOn: true,
                projectMilestone: {
                  select: { id: true, title: true, status: true },
                },
              },
            },
          },
        },
      },
    });
    if (!project) throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    const contract = project.contract;
    const milestoneIds = contract.installments
      .map((i) => i.projectMilestone?.id)
      .filter((id): id is string => !!id);
    const [rounds, invoices, manual, milestonesOpen, warranty, config] =
      await Promise.all([
        this.prisma.projectAcceptance.findMany({
          where: {
            projectId,
            milestoneId: { in: milestoneIds },
            status: { in: ['accepted', 'conditional'] },
          },
          select: { id: true, milestoneId: true, seq: true },
          orderBy: { seq: 'desc' },
        }),
        this.prisma.installmentInvoice.findMany({
          where: { contractId: contract.id },
        }) as unknown as Promise<InvoiceRow[]>,
        this.prisma.contractInstallmentBilling.findMany({
          where: { contractId: contract.id },
          select: {
            seq: true,
            source: true,
            invoiceNo: true,
            invoicedOn: true,
          },
        }),
        this.prisma.projectMilestone.count({
          where: { projectId, status: { notIn: ['achieved', 'cancelled'] } },
        }),
        this.prisma.serviceEntitlement.aggregate({
          where: {
            kind: 'warranty',
            cancelledAt: null,
            OR: [{ contractId: contract.id }, { projectId }],
          },
          _max: { endOn: true },
        }),
        this.prisma.crmCompanyConfig.findUnique({
          where: { companyId: project.companyId },
          select: { deliveryBillingExceptionTypeCode: true },
        }),
      ]);
    const roundIds = rounds.map((r) => r.id);
    const [signed, open] = await Promise.all([
      this.prisma.acceptanceCertificate.findMany({
        where: { acceptanceId: { in: roundIds }, status: 'signed' },
        select: { acceptanceId: true },
      }),
      this.prisma.projectAcceptanceItem.groupBy({
        by: ['acceptanceId'],
        where: { acceptanceId: { in: roundIds }, status: 'open' },
        _count: { _all: true },
      }),
    ]);
    const signedSet = new Set(signed.map((s) => s.acceptanceId));
    return {
      projectNo: project.projectNo,
      exceptionTypeCode: config?.deliveryBillingExceptionTypeCode ?? null,
      contract,
      invoices,
      manual,
      milestonesOpen,
      warrantyEnds: warranty._max.endOn ? day(warranty._max.endOn) : null,
      installments: contract.installments.map((inst) => {
        // the latest accepted round of its milestone
        const round = inst.projectMilestone
          ? (rounds.find((r) => r.milestoneId === inst.projectMilestone!.id) ??
            null)
          : null;
        return {
          ...inst,
          milestone: inst.projectMilestone,
          round,
          certificateSigned: round ? signedSet.has(round.id) : false,
          openPoints: round
            ? (open.find((o) => o.acceptanceId === round.id)?._count._all ?? 0)
            : 0,
        };
      }),
    };
  }
}
