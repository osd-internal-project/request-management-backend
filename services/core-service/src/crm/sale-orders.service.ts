import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  toSkipTake,
  visibleSalesWhere,
} from '@request-management/share';
import {
  LeadRepository,
  OpportunityRepository,
  QuotationRepository,
  SALE_ORDER_LIST_SELECT,
  SaleOrderRepository,
} from './sales.repositories';
import { RunNumberClient } from '../run-number/run-number.client';
import { CustomerRepository } from './customer.repository';
import { CustomersService } from './customers.service';
import { CustomerTimelineService } from './customer-timeline.service';
import type { CreateCustomerDto } from './dto/customer.dto';
import { SaleOrderErpSyncService } from './sale-order-erp-sync.service';
import { ProductCatalogService } from './product-catalog.service';
import { computeQuotationTotals } from './quotation-math';
import {
  CancelSaleOrderDto,
  ListSaleOrdersQueryDto,
  OpenSaleOrderDto,
} from './dto/sales.dto';

/**
 * CRM ใบสั่งขาย (Sale Order) — โครงระยะ 1 ของ CD-77 และ **จุดเดียวที่ลูกค้าใน
 * ทะเบียนเกิด** (PO 10 ก.ย. 2569: "การเปิด opportunity ยังไม่ถือเป็น customer
 * — customer จะเกิดได้ต้องเป็นการเปิด Sale order แล้วเท่านั้น").
 *
 * `open` ทำสามอย่างเป็นก้อนเดียว: หา/สร้างลูกค้าจากผู้มุ่งหวังของโอกาสการขาย
 * (ผ่าน `CustomersService.create` — ออกรหัส, dedup CM-03, SAP sync เหมือนสร้าง
 * จากหน้าจอ), ออกเลข SO, แล้วผูกลูกค้ากลับไปที่โอกาสการขาย (+ Lead ต้นทาง) และ
 * ปิดโอกาสการขายเป็น won.
 *
 * CD-88: เปิดตามใบเสนอราคา = copy รายการสินค้าของใบนั้นมาเป็น `SaleOrderLine`
 * (snapshot) แล้วส่งเข้า SAP หลัง commit ผ่าน `SaleOrderErpSyncService` —
 * SAP ล่มไม่ทำให้เปิดใบไม่ได้. เปิดตรงจากโอกาสการขาย: กรอกรายการเองได้ (PO 24
 * ก.ย. 2569) — มีรายการ = ส่ง SAP เหมือนกัน, ไม่มี = `not_ready`.
 */
@Injectable()
export class SaleOrdersService {
  constructor(
    private readonly saleOrders: SaleOrderRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly leads: LeadRepository,
    private readonly customers: CustomerRepository,
    private readonly customersService: CustomersService,
    private readonly runNumbers: RunNumberClient,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly quotations: QuotationRepository,
    private readonly erpSync: SaleOrderErpSyncService,
    private readonly catalog: ProductCatalogService,
  ) {}

  async list(actor: Principal, query: ListSaleOrdersQueryDto) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.SaleOrderWhereInput = {};

    if (query.status) filters.status = query.status;
    if (query.erp_status) filters.erpStatus = query.erp_status;
    if (query.opportunity_id) filters.opportunityId = query.opportunity_id;
    if (query.customer_id) filters.customerId = query.customer_id;
    if (query.view === 'mine') filters.ownerUserId = actor.userId;
    if (query.search?.trim()) {
      const q = query.search.trim();
      filters.OR = [
        { saleOrderCode: { contains: q, mode: 'insensitive' } },
        { erpOrderNo: { contains: q, mode: 'insensitive' } },
        { customer: { customerCode: { contains: q, mode: 'insensitive' } } },
        { customer: { nameTh: { contains: q, mode: 'insensitive' } } },
        {
          opportunity: {
            opportunityCode: { contains: q, mode: 'insensitive' },
          },
        },
      ];
    }

    const where = {
      AND: [visibleSalesWhere(salesAccessSubject(actor)), filters],
    } as Prisma.SaleOrderWhereInput;

    const [rows, total] = await Promise.all([
      this.saleOrders.findMany({
        where,
        select: SALE_ORDER_LIST_SELECT,
        skip,
        take,
        orderBy: { orderedAt: 'desc' },
      }),
      this.saleOrders.count({ where }),
    ]);

    return paginated(rows as unknown[], query, total);
  }

  /** SCOPE-03: unseen = 404. */
  async findOne(id: string, actor: Principal) {
    const found = await this.saleOrders.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: SALE_ORDER_LIST_SELECT,
    });

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งขายที่ระบุ');
    return found;
  }

  /**
   * เปิดใบสั่งขายจากโอกาสการขายที่ยังเปิดอยู่. ลำดับ:
   *   1. ลูกค้า — รายที่โอกาสการขายผูกอยู่ → รายที่ผู้ใช้เลือก (`customer_id`) →
   *      รายเดิมที่เลขภาษี+สาขาตรง (ไม่สร้างซ้ำ) → สร้างใหม่จากผู้มุ่งหวัง.
   *      การสร้างเป็น transaction ของตัวเอง (ออกรหัส + SAP หลัง commit) — ถ้า
   *      ขั้นถัดไปล้ม ลูกค้ายังอยู่และรอบต่อไปจะจับคู่ด้วยเลขภาษีได้เอง.
   *   2. ออกเลข SO, สร้างแถว, ผูกลูกค้ากลับที่โอกาสการขาย + Lead, ปิดชนะ —
   *      transaction เดียว.
   */
  async open(opportunityId: string, dto: OpenSaleOrderDto, actor: Principal) {
    const opportunity = await this.requireOpenOpportunity(opportunityId, actor);
    // Checked before the customer is resolved: a wrong quotation must not leave
    // a freshly created customer behind it.
    const quotation = dto.quotation_id
      ? await this.requireAcceptedQuotation(
          dto.quotation_id,
          opportunity.id,
          actor,
        )
      : null;
    // Same reason: manual lines are checked before anything is written.
    const manual = await this.manualLines(dto, actor);
    const customer = await this.resolveCustomer(opportunity, dto, actor);

    // ออกเลขนอก transaction และหลังตรวจทุกอย่างผ่าน — docs/run-number.md
    const saleOrderCode = await this.runNumbers.issueUnused(
      { companyId: actor.activeCompanyId, docType: 'SALE_ORDER' },
      (code) => this.saleOrders.codeTaken(code),
    );

    const created = await this.transactions.execute(async (prisma) => {
      const amount =
        manual?.netTotal ??
        dto.amount ??
        quotation?.netTotal ??
        opportunity.amount ??
        null;
      const lines: SaleOrderLineRow[] = quotation
        ? quotation.lines.map((line) => ({
            lineNo: line.lineNo,
            productCode: line.productCode,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
            discountPct: line.discountPct,
            lineTotal: line.lineTotal,
            quotationLineId: line.id,
          }))
        : (manual?.lines ?? []);

      const row = (await this.saleOrders.create(
        {
          data: {
            saleOrderCode,
            companyId: actor.activeCompanyId,
            opportunityId: opportunity.id,
            customerId: customer.id,
            amount,
            currency: opportunity.currency,
            note: dto.note?.trim() || null,
            quotationId: quotation?.id ?? null,
            ownerUserId: opportunity.ownerUserId,
            ownerOrgUnitId: opportunity.ownerOrgUnitId,
            createdBy: actor.userId,
            erpStatus: lines.length ? 'pending' : 'not_ready',
            lines: { create: lines },
          },
        },
        { prisma },
      )) as { id: string; saleOrderCode: string };

      await this.opportunities.update(
        {
          where: { id: opportunity.id },
          data: {
            customerId: customer.id,
            stage: 'won',
            wonAt: new Date(),
            lostReasonCode: null,
            lostReasonText: null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      if (opportunity.fromLead && !opportunity.fromLead.customerId) {
        await this.leads.update(
          {
            where: { id: opportunity.fromLead.id },
            data: { customerId: customer.id, updatedBy: actor.userId },
          },
          { prisma },
        );
      }

      // ใบเสนอราคาที่ออกตอนยังเป็นผู้มุ่งหวังไม่มีลูกค้าผูก — ผูกให้พร้อมกัน
      // ไม่งั้นแท็บใบเสนอราคาและไทม์ไลน์ของลูกค้ามองไม่เห็นใบพวกนี้
      await this.quotations.updateMany(
        {
          where: { opportunityId: opportunity.id, customerId: null },
          data: { customerId: customer.id },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.sale_order.opened',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'sale_order',
          resourceId: row.id,
          after: {
            saleOrderCode,
            opportunityId: opportunity.id,
            opportunityCode: opportunity.opportunityCode,
            customerId: customer.id,
            customerCode: customer.customerCode,
            customerCreated: customer.created,
            amount,
            quotationId: quotation?.id ?? null,
            quotationNo: quotation
              ? `${quotation.quotationNo} v${quotation.version}`
              : null,
            lines: lines.length,
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.opportunity.won',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: opportunity.id,
          before: {
            stage: opportunity.stage,
            customerId: opportunity.customerId,
          },
          after: { stage: 'won', customerId: customer.id, saleOrderCode },
        },
        { prisma },
      );

      const actorMeta = {
        actorId: auditActor(actor).actorId,
        actorName: actor.displayName,
      };

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: customer.id,
          refType: 'opportunity',
          refId: opportunity.id,
          eventType: 'opportunity.won',
          summary: `ปิดโอกาสการขาย ${opportunity.opportunityCode} สำเร็จ (ชนะ) — เปิดใบสั่งขาย ${saleOrderCode}`,
          ...actorMeta,
        },
        { prisma },
      );

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: customer.id,
          refType: 'sale_order',
          refId: row.id,
          eventType: 'sale_order.opened',
          summary: `เปิดใบสั่งขาย ${saleOrderCode} · ${opportunity.title}${
            customer.created ? ' — สร้างทะเบียนลูกค้าจากผู้มุ่งหวัง' : ''
          }`,
          ...actorMeta,
        },
        { prisma },
      );

      return { ...row, lineCount: lines.length };
    });

    // CD-88: SAP is called AFTER the commit — the user never waits on it.
    if (created.lineCount) this.erpSync.kickCreate(created.id);

    const saleOrder = await this.findOne(created.id, actor);
    return {
      ...saleOrder,
      customerCreated: customer.created,
    };
  }

  /** ยกเลิก — สถานะ + เหตุผล, ไม่มีการลบ; โอกาสการขายคงสถานะ won ไว้เป็นประวัติ. */
  async cancel(id: string, dto: CancelSaleOrderDto, actor: Principal) {
    const found = (await this.saleOrders.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: {
        id: true,
        saleOrderCode: true,
        status: true,
        customerId: true,
        erpStatus: true,
        erpOrderNo: true,
      },
    })) as {
      id: string;
      saleOrderCode: string;
      status: string;
      customerId: string;
      erpStatus: string;
      erpOrderNo: string | null;
    } | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งขายที่ระบุ');
    if (found.status === 'cancelled') {
      throw new AppError('CONFLICT', 'ใบสั่งขายนี้ถูกยกเลิกแล้ว');
    }

    await this.transactions.execute(async (prisma) => {
      await this.saleOrders.update(
        {
          where: { id },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelReason: dto.reason.trim(),
            updatedBy: actor.userId,
            // CD-88: in SAP → cancel it there too; still on its way (pending)
            // → the create job sees the cancel and skips; otherwise nothing to send.
            erpStatus:
              found.erpOrderNo || found.erpStatus === 'pending'
                ? 'pending'
                : 'skipped',
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.sale_order.cancelled',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'sale_order',
          resourceId: id,
          before: { status: found.status },
          after: { status: 'cancelled', reason: dto.reason },
        },
        { prisma },
      );

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: found.customerId,
          refType: 'sale_order',
          refId: id,
          eventType: 'sale_order.cancelled',
          summary: `ยกเลิกใบสั่งขาย ${found.saleOrderCode} — ${dto.reason.trim()}`,
          actorId: auditActor(actor).actorId,
          actorName: actor.displayName,
        },
        { prisma },
      );
    });

    if (found.erpOrderNo) this.erpSync.kickCancel(id);

    return this.findOne(id, actor);
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * บรรทัดที่กรอกเอง (ไม่มีใบเสนอราคา): รหัสต้องอยู่ในรายการสินค้าจาก SAP,
   * ยอดคำนวณด้วยสูตรเดียวกับใบเสนอราคา, และถ้าผู้ใช้ระบุมูลค่ามาต้องเท่ากับยอด
   * รวมบรรทัด — ใบเดียวต้องไม่มีสองตัวเลข (CTD กับ SAP).
   */
  private async manualLines(
    dto: OpenSaleOrderDto,
    actor: Principal,
  ): Promise<{ lines: SaleOrderLineRow[]; netTotal: Prisma.Decimal } | null> {
    const input = dto.lines ?? [];
    if (!input.length) return null;

    if (dto.quotation_id) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เปิดตามใบเสนอราคาแล้วกรอกรายการเองไม่ได้ — รายการมาจากใบเสนอราคา',
        [{ field: 'lines', reason: 'quotation_has_lines' }],
      );
    }

    await this.catalog.assertKnownCodes(actor.activeCompanyId, input);

    const totals = computeQuotationTotals(
      input.map((line) => ({
        quantity: line.quantity,
        unit_price: line.unit_price,
        discount_pct: line.discount_pct,
      })),
      0,
    );

    if (
      dto.amount !== undefined &&
      totals.netTotal.minus(dto.amount).abs().gt(0.005)
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        `มูลค่าต้องเท่ากับยอดรวมรายการ (${totals.netTotal.toFixed(2)}) — เว้นว่างให้ระบบคำนวณเอง`,
        [{ field: 'amount', reason: totals.netTotal.toFixed(2) }],
      );
    }

    return {
      netTotal: totals.netTotal,
      lines: input.map((line, index) => ({
        lineNo: index + 1,
        productCode: line.product_code?.trim() || null,
        description: line.description.trim(),
        quantity: line.quantity,
        unit: line.unit?.trim() || null,
        unitPrice: line.unit_price,
        discountPct: line.discount_pct ?? 0,
        lineTotal: totals.lines[index].lineTotal,
        quotationLineId: null,
      })),
    };
  }

  /**
   * CD-77: "สร้างจากใบเสนอราคาที่ลูกค้ายอมรับ" — only an `accepted` version of a
   * quotation on this same opportunity. Another opportunity's quotation is
   * reported as not found for this one rather than as a scope question.
   */
  private async requireAcceptedQuotation(
    id: string,
    opportunityId: string,
    actor: Principal,
  ) {
    const found = (await this.quotations.findFirst({
      where: {
        id,
        opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: {
        id: true,
        quotationNo: true,
        version: true,
        status: true,
        netTotal: true,
        lines: {
          orderBy: { lineNo: 'asc' },
          select: {
            id: true,
            lineNo: true,
            productCode: true,
            description: true,
            quantity: true,
            unit: true,
            unitPrice: true,
            discountPct: true,
            lineTotal: true,
          },
        },
      },
    })) as {
      id: string;
      quotationNo: string;
      version: number;
      status: string;
      netTotal: Prisma.Decimal;
      lines: QuotationLineForSale[];
    } | null;

    if (!found) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ไม่พบใบเสนอราคานี้ในโอกาสการขายที่ระบุ',
        [{ field: 'quotation_id', reason: id }],
      );
    }
    if (found.status !== 'accepted') {
      throw new AppError(
        'CRM_QUOTATION_STATE_INVALID',
        'เปิดใบสั่งขายได้จากใบเสนอราคาที่ลูกค้ายอมรับแล้วเท่านั้น',
        [{ field: 'quotation_id', reason: found.status }],
      );
    }
    return found;
  }

  /** Visible AND still open (not won/lost). SCOPE-03: unseen = 404. */
  private async requireOpenOpportunity(
    id: string,
    actor: Principal,
  ): Promise<OpenOpportunityForSale> {
    const found = (await this.opportunities.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: {
        id: true,
        opportunityCode: true,
        title: true,
        stage: true,
        amount: true,
        currency: true,
        customerId: true,
        prospectName: true,
        prospectTaxId: true,
        prospectContactName: true,
        prospectPhone: true,
        prospectEmail: true,
        ownerUserId: true,
        ownerOrgUnitId: true,
        fromLead: {
          select: {
            id: true,
            customerId: true,
            nameEn: true,
            contactPosition: true,
            addressLine: true,
            district: true,
            province: true,
            postalCode: true,
            country: true,
          },
        },
      },
    })) as OpenOpportunityForSale | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    if (found.stage === 'won' || found.stage === 'lost') {
      throw new AppError(
        'CONFLICT',
        'โอกาสการขายนี้ปิดแล้ว — เปิดใบสั่งขายได้เฉพาะโอกาสการขายที่ยังเปิดอยู่',
      );
    }

    return found;
  }

  private async resolveCustomer(
    opportunity: OpenOpportunityForSale,
    dto: OpenSaleOrderDto,
    actor: Principal,
  ): Promise<ResolvedCustomer> {
    // 1) โอกาสการขายของลูกค้าเดิม — ไม่มีอะไรต้องสร้าง.
    if (opportunity.customerId) {
      return this.existing(opportunity.customerId, actor, 'customer_id');
    }

    // 2) ผู้ใช้ชี้ลูกค้าเดิมเอง (เช่น หลังระบบเตือนชื่อคล้าย).
    if (dto.customer_id) {
      return this.existing(dto.customer_id, actor, 'customer_id');
    }

    // 3) เลขภาษี + สาขา ตรงกับรายเดิม → ใช้รายเดิม (ไม่ชนกับ CM-03 hard block).
    const taxId = digits(dto.customer?.tax_id ?? opportunity.prospectTaxId);
    const branchCode = dto.customer?.branch_code ?? '00000';
    if (taxId) {
      const match = (await this.customers.findFirst({
        where: {
          companyId: actor.activeCompanyId,
          taxId,
          branchCode,
          mergedIntoCustomerId: null,
        },
        select: { id: true, customerCode: true, nameTh: true },
      })) as Omit<ResolvedCustomer, 'created'> | null;
      if (match) return { ...match, created: false };
    }

    // 4) สร้างใหม่จากผู้มุ่งหวัง — ทางเดียวกับหน้าจอสร้างลูกค้า (รหัส, dedup, SAP).
    const nameTh = dto.customer?.name_th?.trim() || opportunity.prospectName;
    if (!nameTh) {
      throw new AppError(
        'VALIDATION_FAILED',
        'โอกาสการขายนี้ไม่มีชื่อผู้มุ่งหวัง — ระบุชื่อลูกค้าเพื่อสร้างทะเบียน',
        [{ field: 'customer.name_th', reason: 'required' }],
      );
    }

    const lead = opportunity.fromLead;
    const customerDto: CreateCustomerDto = {
      type: dto.customer?.type ?? 'corporate',
      name_th: nameTh,
      name_en: dto.customer?.name_en?.trim() || lead?.nameEn || undefined,
      tax_id: taxId || undefined,
      branch_code: dto.customer?.branch_code,
      branch_name: dto.customer?.branch_name?.trim() || undefined,
      account_owner_user_id: opportunity.ownerUserId,
      status: 'active',
      contacts: opportunity.prospectContactName
        ? [
            {
              name: opportunity.prospectContactName,
              position: lead?.contactPosition ?? undefined,
              phone: opportunity.prospectPhone ?? undefined,
              email: opportunity.prospectEmail ?? undefined,
              is_primary: true,
            },
          ]
        : [],
      locations: lead?.addressLine
        ? [
            {
              name: 'ที่อยู่จดทะเบียน',
              line1: lead.addressLine,
              district: lead.district ?? undefined,
              province: lead.province ?? undefined,
              postal_code: /^\d{5}$/.test(lead.postalCode ?? '')
                ? (lead.postalCode as string)
                : undefined,
              country: lead.country ?? undefined,
              is_billing: true,
              is_primary: true,
            },
          ]
        : [],
      confirm_duplicate: dto.customer?.confirm_duplicate,
      override_reason: dto.customer?.override_reason,
    };

    const created = (await this.customersService.create(
      customerDto,
      actor,
    )) as {
      id: string;
      customerCode: string;
      nameTh: string;
    };

    return {
      id: created.id,
      customerCode: created.customerCode,
      nameTh: created.nameTh,
      created: true,
    };
  }

  private async existing(
    customerId: string,
    actor: Principal,
    field: string,
  ): Promise<ResolvedCustomer> {
    const customer = (await this.customers.findFirst({
      where: {
        id: customerId,
        companyId: actor.activeCompanyId,
        mergedIntoCustomerId: null,
      },
      select: { id: true, customerCode: true, nameTh: true },
    })) as Omit<ResolvedCustomer, 'created'> | null;

    if (!customer) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบลูกค้าที่ระบุ', [
        { field, reason: customerId },
      ]);
    }

    return { ...customer, created: false };
  }
}

interface OpenOpportunityForSale {
  id: string;
  opportunityCode: string;
  title: string;
  stage: string;
  amount: Prisma.Decimal | null;
  currency: string;
  customerId: string | null;
  prospectName: string | null;
  prospectTaxId: string | null;
  prospectContactName: string | null;
  prospectPhone: string | null;
  prospectEmail: string | null;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
  fromLead: {
    id: string;
    customerId: string | null;
    nameEn: string | null;
    contactPosition: string | null;
    addressLine: string | null;
    district: string | null;
    province: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
}

/** What becomes a `sale_order_lines` row — from a quotation or typed in. */
interface SaleOrderLineRow {
  lineNo: number;
  productCode: string | null;
  description: string;
  quantity: Prisma.Decimal | number;
  unit: string | null;
  unitPrice: Prisma.Decimal | number;
  discountPct: Prisma.Decimal | number;
  lineTotal: Prisma.Decimal;
  quotationLineId: string | null;
}

interface QuotationLineForSale {
  id: string;
  lineNo: number;
  productCode: string | null;
  description: string;
  quantity: Prisma.Decimal;
  unit: string | null;
  unitPrice: Prisma.Decimal;
  discountPct: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
}

interface ResolvedCustomer {
  id: string;
  customerCode: string;
  nameTh: string;
  /** true = ทะเบียนลูกค้าเพิ่งเกิดจากใบสั่งขายนี้. */
  created: boolean;
}

function digits(value: string | null | undefined): string | null {
  const only = (value ?? '').replace(/[^0-9]/g, '');
  return only.length ? only : null;
}
