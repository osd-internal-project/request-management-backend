import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CustomerRepository } from '../crm/customer.repository';
import { ProductCatalogService } from '../crm/product-catalog.service';
import { RequestRepository } from '../requests/request.repository';
import {
  billingReference,
  confirmBlocker,
  estimateLine,
  lineProblems,
  lineTotal,
  netTotal,
  prepareBlocker,
  type BillingLineInput,
} from './billing-rules';
import { ServiceBillingErpSyncService } from './service-billing-erp-sync.service';
import { TimeMaterialsService } from './time-materials.service';
import { rebuildLines, type ChargeLine } from './time-material-rules';
import { extraLines } from './extra-work-rules';
import { ExtraWorksService } from './extra-works.service';
import {
  CancelServiceBillingDto,
  ListServiceBillingsQueryDto,
  SaveServiceBillingDto,
} from './support.dto';
import {
  ServiceBillingRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';

interface LineRow {
  lineNo: number;
  productCode: string | null;
  description: string;
  quantity: Prisma.Decimal;
  unit: string | null;
  unitPrice: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  source: string;
}

interface BillingRow {
  id: string;
  companyId: string;
  workOrderId: string;
  requestId: string;
  customerId: string;
  reference: string;
  status: string;
  currency: string;
  netTotal: Prisma.Decimal;
  note: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  erpStatus: string;
  erpDraftNo: string | null;
  erpLastError: string | null;
  erpSyncedAt: Date | null;
  erpInvoiceStatus: string | null;
  erpInvoiceNo: string | null;
  erpInvoiceTotal: Prisma.Decimal | null;
  erpPaid: Prisma.Decimal | null;
  erpCheckedAt: Date | null;
  createdAt: Date;
  lines: LineRow[];
}

interface OrderRow {
  id: string;
  companyId: string;
  requestId: string;
  customerId: string | null;
  billing: string | null;
  ackEstimate: Prisma.Decimal | null;
}

interface CaseRow {
  id: string;
  requestNo: string | null;
  status: string;
  formData: unknown;
}

const LIST_LIMIT = 200;
const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);
const iso = (value: Date | null) => value?.toISOString() ?? null;
const subjectOf = (row: CaseRow | undefined) => {
  const form = (row?.formData ?? {}) as { subject?: unknown };
  return typeof form.subject === 'string' ? form.subject : '';
};

/**
 * CD-242 ส่งข้อมูลเรียกเก็บเงินงานบริการ — a billed service job (CD-239,
 * confirmed `billable`) once its work is done: the charge is prepared from
 * the estimate the customer agreed to, the service team edits the lines
 * (SAP item codes, quantities, prices), confirms, and it goes to SAP B1 as a
 * draft A/R invoice through the queue ({@link ServiceBillingErpSyncService});
 * its posting and payment are read back. A separate road from the project's
 * installment billing (CD-164/193).
 *
 * Who: `service.asset.read` reads; `service.asset.manage` prepares, confirms
 * and cancels.
 */
@Injectable()
export class ServiceBillingService {
  constructor(
    private readonly billings: ServiceBillingRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly requestRows: RequestRepository,
    private readonly customers: CustomerRepository,
    private readonly people: CompanyMemberRepository,
    private readonly sync: ServiceBillingErpSyncService,
    private readonly catalog: ProductCatalogService,
    private readonly timeMaterials: TimeMaterialsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    // CD-228 — out-of-contract work the customer agreed to
    private readonly extraWorks: ExtraWorksService,
  ) {}

  async list(actor: Principal, query: ListServiceBillingsQueryDto) {
    const rows = (await this.billings.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.erp_status ? { erpStatus: query.erp_status } : {}),
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
      orderBy: [{ createdAt: 'desc' }],
      take: LIST_LIMIT,
    })) as unknown as BillingRow[];
    return this.views(rows);
  }

  /** The charge of a work order, or null when none was prepared yet. */
  async ofWorkOrder(actor: Principal, workOrderId: string) {
    const row = (await this.billings.findFirst({
      where: { workOrderId, companyId: actor.activeCompanyId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    })) as unknown as BillingRow | null;
    if (!row) return null;
    const [view] = await this.views([row]);
    return view;
  }

  /** The charge started from the customer's agreed estimate (CD-239). */
  async prepare(actor: Principal, workOrderId: string) {
    const companyId = actor.activeCompanyId;
    const order = (await this.orders.findFirst({
      where: { id: workOrderId, companyId },
      select: {
        id: true,
        companyId: true,
        requestId: true,
        customerId: true,
        billing: true,
        ackEstimate: true,
      },
    })) as OrderRow | null;
    if (!order) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    const request = await this.caseOf(order.requestId);
    const extras = await this.extraLinesOf(workOrderId);
    const blocker = prepareBlocker(order, request.status, extras.length);
    if (blocker) throw new AppError('CONFLICT', blocker);
    if (!order.customerId) {
      throw new AppError('CONFLICT', 'ใบสั่งงานนี้ไม่ได้ระบุลูกค้า');
    }
    if (await this.billings.count({ where: { workOrderId } })) {
      throw new AppError('CONFLICT', 'งานนี้มีใบเรียกเก็บแล้ว');
    }
    // CD-243 — the actual time and materials when there are any, else the
    // estimate the customer agreed to
    // CD-228 — an in-contract job charges only what was agreed beyond it
    const billable = order.billing === 'billable';
    const actual = billable
      ? await this.timeMaterials.chargeLines(companyId, workOrderId)
      : [];
    const first = billable
      ? estimateLine(subjectOf(request), num(order.ackEstimate))
      : null;
    const lines: ChargeLine[] = [
      ...(actual.length
        ? actual
        : first
          ? [{ ...first, source: 'estimate' as const }]
          : []),
      ...extras,
    ];
    const created = await this.transactions.execute(async (prisma) => {
      const row = await prisma.serviceBilling.create({
        data: {
          companyId,
          workOrderId,
          requestId: order.requestId,
          customerId: order.customerId!,
          reference: billingReference(request.requestNo, order.requestId),
          netTotal: netTotal(lines),
          createdBy: actor.userId,
          lines: {
            create: lines.map((line, index) => ({
              ...this.lineData(line, index),
              source: line.source,
            })),
          },
        },
        select: { id: true, reference: true },
      });
      await this.audit.record(
        {
          eventType: 'service.billing.prepared',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_billing',
          resourceId: row.id,
          after: {
            workOrderId,
            reference: row.reference,
            netTotal: netTotal(lines),
          },
        },
        { prisma },
      );
      return row;
    });
    return this.detail(actor, created.id);
  }

  /** The lines and note, while it is still a draft. */
  async save(actor: Principal, id: string, dto: SaveServiceBillingDto) {
    const before = await this.require(actor.activeCompanyId, id);
    if (before.status !== 'draft') {
      throw new AppError('CONFLICT', 'แก้ได้เฉพาะใบที่ยังไม่ยืนยันส่ง');
    }
    const lines: BillingLineInput[] = dto.lines.map((line) => ({
      productCode: line.product_code?.trim() || null,
      description: line.description,
      quantity: line.quantity,
      unit: line.unit?.trim() || null,
      unitPrice: line.unit_price,
      discountPct: line.discount_pct ?? 0,
    }));
    const problems = lineProblems(lines);
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    // an item code must be one SAP sells (CD-27), as on a quotation
    await this.catalog.assertCodes(
      before.companyId,
      lines.map((line, index) => ({
        code: line.productCode,
        field: `lines[${index}].product_code`,
      })),
    );
    const sources = new Map(
      before.lines.map((line) => [line.lineNo, line.source]),
    );
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceBillingLine.deleteMany({ where: { billingId: id } });
      await prisma.serviceBilling.update({
        where: { id },
        data: {
          netTotal: netTotal(lines),
          note: dto.note?.trim() || null,
          updatedBy: actor.userId,
          lines: {
            create: lines.map((line, index) => ({
              ...this.lineData(line, index),
              // a line kept in place keeps where it came from
              source:
                dto.lines[index].source ?? sources.get(index + 1) ?? 'manual',
            })),
          },
        },
      });
      await this.audit.record(
        {
          eventType: 'service.billing.saved',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'service_billing',
          resourceId: id,
          before: { netTotal: Number(before.netTotal) },
          after: { netTotal: netTotal(lines), lines: lines.length },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  /**
   * CD-243 — the draft's labour and material lines rebuilt from the job's
   * time and materials now; typed lines stay, the estimate goes once there
   * is something actual to charge.
   */
  async pull(actor: Principal, id: string) {
    const before = await this.require(actor.activeCompanyId, id);
    if (before.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        'ดึงเวลาและวัสดุได้เฉพาะใบที่ยังไม่ยืนยันส่ง',
      );
    }
    const order = (await this.orders.findFirst({
      where: { id: before.workOrderId },
      select: { billing: true },
    })) as { billing: string | null } | null;
    const fresh = [
      ...(order?.billing === 'billable'
        ? await this.timeMaterials.chargeLines(
            before.companyId,
            before.workOrderId,
          )
        : []),
      ...(await this.extraLinesOf(before.workOrderId)),
    ];
    const lines = rebuildLines(
      before.lines.map((line) => ({
        ...lineInput(line),
        source: line.source as ChargeLine['source'],
      })),
      fresh,
    );
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceBillingLine.deleteMany({ where: { billingId: id } });
      await prisma.serviceBilling.update({
        where: { id },
        data: {
          netTotal: netTotal(lines),
          updatedBy: actor.userId,
          lines: {
            create: lines.map((line, index) => ({
              ...this.lineData(line, index),
              source: line.source,
            })),
          },
        },
      });
      await this.audit.record(
        {
          eventType: 'service.billing.pulled',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'service_billing',
          resourceId: id,
          before: { netTotal: Number(before.netTotal) },
          after: { netTotal: netTotal(lines), lines: lines.length },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  /** Confirmed: locked and sent to SAP as a draft A/R invoice. */
  async confirm(actor: Principal, id: string) {
    const before = await this.require(actor.activeCompanyId, id);
    if (before.status !== 'draft') {
      throw new AppError('CONFLICT', 'ใบนี้ยืนยันส่งไปแล้ว');
    }
    const blocker = confirmBlocker(before.lines.map(lineInput));
    if (blocker) throw new AppError('VALIDATION_FAILED', blocker);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceBilling.update({
        where: { id },
        data: {
          status: 'confirmed',
          confirmedBy: actor.userId,
          confirmedAt: new Date(),
          erpStatus: 'pending',
          erpLastError: null,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.billing.confirmed',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'service_billing',
          resourceId: id,
          after: {
            reference: before.reference,
            netTotal: Number(before.netTotal),
          },
        },
        { prisma },
      );
    });
    this.sync.kickCreate(id);
    return this.detail(actor, id);
  }

  /**
   * Withdrawn, with a reason: a sent draft is deleted in SAP. Once finance
   * has posted the invoice it cannot be — that is a credit note in SAP.
   */
  async cancel(actor: Principal, id: string, dto: CancelServiceBillingDto) {
    const before = await this.require(actor.activeCompanyId, id);
    if (before.status === 'cancelled') {
      throw new AppError('CONFLICT', 'ใบนี้ยกเลิกแล้ว');
    }
    if (['open', 'paid'].includes(before.erpInvoiceStatus ?? '')) {
      throw new AppError(
        'CONFLICT',
        `การเงินออกใบแจ้งหนี้ ${before.erpInvoiceNo ?? ''} แล้ว — ยกเลิกต้องออกใบลดหนี้ใน SAP`,
      );
    }
    const sent = before.status === 'confirmed';
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceBilling.update({
        where: { id },
        data: {
          status: 'cancelled',
          cancelledBy: actor.userId,
          cancelledAt: new Date(),
          cancelReason: dto.reason.trim(),
          ...(sent ? { erpStatus: 'pending' } : {}),
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.billing.cancelled',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'service_billing',
          resourceId: id,
          before: { status: before.status, erpDraftNo: before.erpDraftNo },
          after: { status: 'cancelled', reason: dto.reason.trim() },
        },
        { prisma },
      );
    });
    if (sent) this.sync.kickCancel(id);
    return this.detail(actor, id);
  }

  /** Read SAP now instead of waiting for the hourly round. */
  async refresh(actor: Principal, id: string) {
    const before = await this.require(actor.activeCompanyId, id);
    if (!before.erpDraftNo) {
      throw new AppError('CONFLICT', 'ใบนี้ยังไม่ถึง SAP');
    }
    await this.sync.refresh(id);
    return this.detail(actor, id);
  }

  async detail(actor: Principal, id: string) {
    const row = await this.require(actor.activeCompanyId, id);
    const [view] = await this.views([row]);
    return view;
  }

  // --- helpers ---------------------------------------------------------------

  private lineData(line: BillingLineInput, index: number) {
    return {
      lineNo: index + 1,
      productCode: line.productCode,
      description: line.description.trim(),
      quantity: line.quantity,
      unit: line.unit,
      unitPrice: line.unitPrice,
      discountPct: line.discountPct,
      lineTotal: lineTotal(line),
    };
  }

  private async views(rows: BillingRow[]) {
    const [cases, customers, names] = await Promise.all([
      this.requestRows.findMany({
        where: { id: { in: rows.map((row) => row.requestId) } },
        select: { id: true, requestNo: true, status: true, formData: true },
      }) as Promise<CaseRow[]>,
      this.customers.findMany({
        where: { id: { in: rows.map((row) => row.customerId) } },
        select: { id: true, customerCode: true, nameTh: true },
      }) as Promise<{ id: string; customerCode: string; nameTh: string }[]>,
      this.names(rows.map((row) => row.confirmedBy)),
    ]);
    const caseById = new Map(cases.map((row) => [row.id, row]));
    const customerById = new Map(customers.map((row) => [row.id, row]));
    return rows.map((row) => {
      const request = caseById.get(row.requestId);
      const customer = customerById.get(row.customerId);
      return {
        id: row.id,
        workOrderId: row.workOrderId,
        requestId: row.requestId,
        reference: row.reference,
        status: row.status,
        currency: row.currency,
        netTotal: Number(row.netTotal),
        note: row.note,
        request: request
          ? {
              requestNo: request.requestNo,
              status: request.status,
              subject: subjectOf(request),
            }
          : null,
        customer: customer
          ? {
              id: customer.id,
              code: customer.customerCode,
              name: customer.nameTh,
            }
          : null,
        lines: row.lines.map((line) => ({
          lineNo: line.lineNo,
          productCode: line.productCode,
          description: line.description,
          quantity: Number(line.quantity),
          unit: line.unit,
          unitPrice: Number(line.unitPrice),
          discountPct: Number(line.discountPct),
          lineTotal: Number(line.lineTotal),
          source: line.source,
        })),
        confirmedAt: iso(row.confirmedAt),
        confirmedByName: row.confirmedBy
          ? (names.get(row.confirmedBy) ?? row.confirmedBy)
          : null,
        cancelledAt: iso(row.cancelledAt),
        cancelReason: row.cancelReason,
        erp: {
          status: row.erpStatus,
          draftNo: row.erpDraftNo,
          lastError: row.erpLastError,
          syncedAt: iso(row.erpSyncedAt),
          invoiceStatus: row.erpInvoiceStatus,
          invoiceNo: row.erpInvoiceNo,
          invoiceTotal: num(row.erpInvoiceTotal),
          paid: num(row.erpPaid),
          checkedAt: iso(row.erpCheckedAt),
        },
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  /** CD-228 — the agreed out-of-contract items as charge lines. */
  private async extraLinesOf(workOrderId: string): Promise<ChargeLine[]> {
    return extraLines(await this.extraWorks.agreedOf(workOrderId)).map(
      (line) => ({ ...line, source: 'extra' as const }),
    );
  }

  private async caseOf(requestId: string) {
    const row = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { id: true, requestNo: true, status: true, formData: true },
    })) as CaseRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบคำขอของใบสั่งงาน');
    return row;
  }

  private async require(companyId: string, id: string) {
    const row = (await this.billings.findFirst({
      where: { id, companyId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    })) as unknown as BillingRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบเรียกเก็บ');
    return row;
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

function lineInput(line: LineRow): BillingLineInput {
  return {
    productCode: line.productCode,
    description: line.description,
    quantity: Number(line.quantity),
    unit: line.unit,
    unitPrice: Number(line.unitPrice),
    discountPct: Number(line.discountPct),
  };
}
