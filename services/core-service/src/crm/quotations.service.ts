import { Injectable } from '@nestjs/common';
import type { Prisma, QuotationStatus } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  toSkipTake,
  TQueryClient,
  visibleSalesWhere,
} from '@request-management/share';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import {
  OpportunityRepository,
  QUOTATION_LIST_SELECT,
  QuotationRepository,
} from './sales.repositories';
import { ProductCatalogService } from './product-catalog.service';
import { ProductPriceRepository } from './product.repositories';
import { CustomerSegmentAssignmentRepository } from './segment.repositories';
import { CrmConfigRepository } from './segment.repositories';
import { RunNumberClient } from '../run-number/run-number.client';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  computeQuotationTotals,
  dealMargin,
  defaultValidUntil,
  markupPrice,
  marginNeedsApproval,
  monthlyRecurring,
  priceModelProblems,
  quotationExpired,
  type QuotationLineInput,
} from './quotation-math';
import {
  AcceptQuotationDto,
  CancelQuotationDto,
  CreateQuotationDto,
  DeclineQuotationDto,
  ListQuotationsQueryDto,
  QuotationLineDto,
  SubmitQuotationDto,
  UpdateQuotationDto,
} from './dto/quotation.dto';

/** Defaults while a company has never saved its CRM settings. */
const CONFIG_DEFAULTS = {
  minMarginPct: 15,
  quotationValidityDays: 30,
  vatPct: 7,
  quotationApprovalTypeCode: 'PRA',
};

/** Versions that may be replaced by a new one. */
const REVISABLE: QuotationStatus[] = [
  'pending_approval',
  'approved',
  'sent',
  'declined',
];

const CANCELLABLE: QuotationStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
];

/**
 * CRM ใบเสนอราคา (CD-76) — "สร้างจาก BOQ และราคาที่อนุมัติแล้ว ควบคุมเวอร์ชัน มีวัน
 * หมดอายุ — ฉบับที่ส่งลูกค้าแล้วแก้ไม่ได้ ต้องออกเวอร์ชันใหม่ · รวมการตรวจ margin
 * ก่อนออกใบเสนอราคา".
 *
 * วงจร: `draft` (แก้ได้อย่างเดียวที่นี่) → `submit` ตรวจ margin เทียบเกณฑ์ของบริษัท:
 * ผ่าน = `approved` ทันที, ต่ำกว่า = ระบบร่างคำขออนุมัติ (ประเภทตาม CRM settings,
 * ค่าตั้งต้น DSC) แล้วรอเป็น `pending_approval` — ผลกลับมาทาง
 * `QuotationApprovalSyncService` → `send` (ล็อกฉบับ) → ลูกค้า `accept`/`decline`.
 * การแก้หลังยื่นแล้วคือ `revise`: เวอร์ชันใหม่เป็น draft, ฉบับเดิม `superseded`.
 *
 * ต้นทุนกรอกเองต่อบรรทัด (ผู้ใช้ 15 ก.ย. 2569) จนกว่าจะมี BOQ (CD-11)/Pricing (CD-12).
 * ยอดทุกตัวคำนวณที่ server — ไม่รับยอดจาก client.
 */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly quotations: QuotationRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestsService: RequestsService,
    private readonly requestRows: RequestRepository,
    private readonly runNumbers: RunNumberClient,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly catalog: ProductCatalogService,
    private readonly prices: ProductPriceRepository,
    private readonly segmentAssignments: CustomerSegmentAssignmentRepository,
  ) {}

  async list(actor: Principal, query: ListQuotationsQueryDto) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.QuotationWhereInput = {};

    if (query.opportunity_id) filters.opportunityId = query.opportunity_id;
    // ใบที่ออกก่อนเปิดใบสั่งขายยังไม่มี customerId ของตัวเอง — ดูผ่านโอกาสการขายด้วย
    const customerFilter: Prisma.QuotationWhereInput | null = query.customer_id
      ? {
          OR: [
            { customerId: query.customer_id },
            { opportunity: { customerId: query.customer_id } },
          ],
        }
      : null;
    if (query.status) filters.status = query.status;
    else if (query.current === 'true') filters.status = { not: 'superseded' };
    if (query.view === 'mine') filters.ownerUserId = actor.userId;
    if (query.search) {
      const q = query.search.trim();
      filters.OR = [
        { quotationNo: { contains: q, mode: 'insensitive' } },
        { title: { contains: q, mode: 'insensitive' } },
        { partyName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const where = {
      AND: [
        visibleSalesWhere(salesAccessSubject(actor)),
        filters,
        ...(customerFilter ? [customerFilter] : []),
      ],
    } as Prisma.QuotationWhereInput;

    const [rows, total] = await Promise.all([
      this.quotations.findMany({
        where,
        select: QUOTATION_LIST_SELECT,
        skip,
        take,
        orderBy: [{ updatedAt: 'desc' }],
      }),
      this.quotations.count({ where }),
    ]);

    return paginated(
      (rows as { validUntil: Date | null; status: QuotationStatus }[]).map(
        withExpiry,
      ),
      query,
      total,
    );
  }

  /** Detail + lines + every version of the same number + the approval request. SCOPE-03: 404. */
  async findOne(id: string, actor: Principal) {
    const found = (await this.quotations.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        opportunity: {
          select: {
            id: true,
            opportunityCode: true,
            title: true,
            stage: true,
            customerId: true,
          },
        },
        customer: { select: { id: true, customerCode: true, nameTh: true } },
        saleOrders: {
          select: { id: true, saleOrderCode: true, status: true },
          orderBy: { orderedAt: 'desc' },
        },
      },
    })) as
      | ({
          quotationNo: string;
          companyId: string;
          validUntil: Date | null;
          status: QuotationStatus;
          approvalRequestId: string | null;
        } & Record<string, unknown>)
      | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบใบเสนอราคาที่ระบุ');

    const [versions, approvalRequest] = await Promise.all([
      this.quotations.findMany({
        where: { companyId: found.companyId, quotationNo: found.quotationNo },
        select: {
          id: true,
          version: true,
          status: true,
          netTotal: true,
          createdAt: true,
        },
        orderBy: { version: 'desc' },
      }),
      found.approvalRequestId
        ? this.requestRows.findFirst({
            where: { id: found.approvalRequestId },
            select: { id: true, requestNo: true, status: true, typeCode: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      ...withExpiry(found),
      // CD-196 — the monthly charge beside the totals (which cover the term).
      monthlyRecurring: monthlyRecurring(
        found.lines as {
          priceModel: string;
          termMonths: number | null;
          lineTotal: Prisma.Decimal;
        }[],
      ),
      versions,
      approvalRequest,
    };
  }

  /**
   * CD-199 — the deal's margin over the latest standing version of each of
   * its quotations, with the company minimum to compare against. Cost and
   * margin are masked by the route like any quotation (SCOPE-04).
   */
  async dealMarginOf(opportunityId: string, actor: Principal) {
    const deal = (await this.opportunities.findFirst({
      where: {
        id: opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: { id: true, companyId: true, currency: true },
    })) as { id: string; companyId: string; currency: string } | null;
    // SCOPE-03: out of reach answers 404.
    if (!deal) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    const rows = (await this.quotations.findMany({
      where: { opportunityId: deal.id, companyId: deal.companyId },
      select: {
        id: true,
        quotationNo: true,
        version: true,
        status: true,
        validUntil: true,
        netTotal: true,
        costTotal: true,
        marginAmount: true,
        marginPct: true,
      },
    })) as {
      id: string;
      quotationNo: string;
      version: number;
      status: string;
      validUntil: Date | null;
      netTotal: Prisma.Decimal;
      costTotal: Prisma.Decimal;
      marginAmount: Prisma.Decimal;
      marginPct: Prisma.Decimal | null;
    }[];
    const config = await this.configOf(deal.companyId);
    return {
      ...dealMargin(rows),
      currency: deal.currency,
      minMarginPct: config.minMarginPct,
    };
  }

  /** ร่างใหม่ (เวอร์ชัน 1) จากโอกาสการขายที่ยังเปิดอยู่. */
  async createForOpportunity(
    opportunityId: string,
    dto: CreateQuotationDto,
    actor: Principal,
    /**
     * CD-198 — set when Pricing starts the quotation from an approved
     * Solution: the version it came from and each line's cost source.
     */
    origin?: {
      solutionId: string;
      solutionVersionNo: number;
      costSources: readonly (string | null)[];
    },
  ) {
    const opportunity = await this.requireOpenOpportunity(opportunityId, actor);
    const config = await this.configOf(actor.activeCompanyId);
    const lines = dto.lines ?? [];
    // CD-27: รหัสที่ SAP ไม่รู้จักจะทำให้ใบสั่งขายที่ตามมาถูกปฏิเสธ — กันตั้งแต่ร่าง
    await this.catalog.assertKnownCodes(actor.activeCompanyId, lines);
    assertPriceModels(lines);
    const totals = computeQuotationTotals(lines.map(lineInput), config.vatPct);

    // ออกเลขนอก transaction และหลังตรวจทุกอย่างผ่าน — docs/run-number.md
    const quotationNo = await this.runNumbers.issueUnused(
      { companyId: actor.activeCompanyId, docType: 'QUOTATION' },
      (code) => this.quotations.codeTaken(code),
    );

    const created = await this.transactions.execute(async (prisma) => {
      const row = (await this.quotations.create(
        {
          data: {
            quotationNo,
            version: 1,
            companyId: actor.activeCompanyId,
            opportunityId: opportunity.id,
            ...partyOf(opportunity),
            title: dto.title?.trim() || opportunity.title,
            currency: opportunity.currency,
            validUntil: dto.valid_until
              ? new Date(dto.valid_until)
              : defaultValidUntil(config.quotationValidityDays),
            paymentTerms: dto.payment_terms?.trim() || null,
            note: dto.note?.trim() || null,
            ...totalsData(totals),
            ownerUserId: opportunity.ownerUserId,
            ownerOrgUnitId: opportunity.ownerOrgUnitId,
            createdBy: actor.userId,
            ...(origin
              ? {
                  solutionId: origin.solutionId,
                  solutionVersionNo: origin.solutionVersionNo,
                }
              : {}),
            lines: {
              create: linesData(
                lines,
                totals,
                await this.priceRefs(
                  actor.activeCompanyId,
                  opportunity.currency,
                  lines,
                  opportunity.id,
                ),
              ).map((line, index) => ({
                ...line,
                costSource: origin?.costSources[index] ?? null,
              })),
            },
          },
        },
        { prisma },
      )) as { id: string; quotationNo: string; customerId: string | null };

      await this.audit.record(
        {
          eventType: 'crm.quotation.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'quotation',
          resourceId: row.id,
          after: {
            quotationNo,
            version: 1,
            opportunityId: opportunity.id,
            lines: lines.length,
            netTotal: totals.netTotal.toFixed(2),
          },
        },
        { prisma },
      );

      await this.publishTimeline(prisma, actor, row.customerId, row.id, {
        eventType: 'quotation.created',
        summary: `สร้างใบเสนอราคา ${quotationNo} (ร่าง) · ${opportunity.opportunityCode}`,
      });

      return row;
    });

    return this.findOne(created.id, actor);
  }

  /** แก้ร่าง — `lines` ถ้าส่งมาแทนที่ทั้งชุดและคำนวณยอดใหม่. */
  async update(id: string, dto: UpdateQuotationDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    assertStatus(
      found,
      ['draft'],
      'แก้ไขได้เฉพาะใบเสนอราคาที่ยังเป็นร่าง — ฉบับที่ยื่นแล้วต้องออกเวอร์ชันใหม่',
    );

    if (dto.lines !== undefined) {
      await this.catalog.assertKnownCodes(actor.activeCompanyId, dto.lines);
      assertPriceModels(dto.lines);
    }

    const totals =
      dto.lines !== undefined
        ? computeQuotationTotals(
            dto.lines.map(lineInput),
            found.vatPct.toString(),
          )
        : null;

    await this.transactions.execute(async (prisma) => {
      await this.quotations.update(
        {
          where: { id },
          data: {
            ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
            ...(dto.valid_until !== undefined
              ? { validUntil: new Date(dto.valid_until) }
              : {}),
            ...(dto.payment_terms !== undefined
              ? { paymentTerms: dto.payment_terms.trim() || null }
              : {}),
            ...(dto.note !== undefined
              ? { note: dto.note.trim() || null }
              : {}),
            ...(totals ? totalsData(totals) : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      if (dto.lines !== undefined && totals) {
        const refs = await this.priceRefs(
          actor.activeCompanyId,
          found.currency,
          dto.lines,
          found.opportunityId,
        );
        await prisma.quotationLine.deleteMany({ where: { quotationId: id } });
        if (dto.lines.length) {
          await prisma.quotationLine.createMany({
            data: linesData(dto.lines, totals, refs).map((line, index) => ({
              ...line,
              // CD-198 — the cost source survives an edit only while the
              // line still is the same product at the same cost.
              costSource: keptCostSource(found.lines[index], dto.lines![index]),
              quotationId: id,
            })),
          });
        }
      }

      await this.audit.record(
        {
          eventType: 'crm.quotation.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'quotation',
          resourceId: id,
          after: {
            fields: Object.keys(dto),
            ...(totals ? { netTotal: totals.netTotal.toFixed(2) } : {}),
          },
        },
        { prisma },
      );
    });

    return this.findOne(id, actor);
  }

  /**
   * ยื่นออกใบเสนอราคา = การตรวจ margin (กลไกคุมกำไรตาม CD-76).
   *
   * เกณฑ์อ่านจาก CRM settings ตอนนี้ แล้ว **เก็บลงใบ** (`minMarginPct`) — แก้เกณฑ์
   * ภายหลังต้องไม่ตัดสินใบที่ยื่นไปแล้วใหม่ (non-negotiable 7).
   *
   * ต่ำกว่าเกณฑ์: สร้าง **ร่าง** คำขออนุมัติให้ผู้ยื่น พร้อมตัวเลขจากใบนี้ — ยังไม่ยื่น
   * ให้ เพราะประเภทคำขอบังคับแนบเอกสารและผู้รับเรื่อง ซึ่งเป็นสิ่งที่คนต้องเลือกเอง.
   * คำขอถูกสร้างก่อนแก้สถานะใบ: ถ้าสร้างไม่ได้ (ประเภทไม่เปิดให้บริษัทนี้) ใบยังเป็น
   * ร่างเหมือนเดิม ไม่ค้างอยู่ที่ "รออนุมัติ" ที่ไม่มีคำขอให้ใครอนุมัติ.
   */
  /**
   * CD-201 — every version goes to price approval: one request per version,
   * routed by the ladder of the approval type (amount levels live there, on
   * `net_total`). Margin below the minimum only adds the reason to that same
   * request. The approval belongs to this version alone — a change after it
   * is a new version and a new request.
   */
  async submit(
    id: string,
    dto: SubmitQuotationDto,
    actor: Principal,
    authorization?: string,
  ) {
    const found = await this.requireVisible(id, actor);
    assertStatus(found, ['draft'], 'ยื่นได้เฉพาะใบเสนอราคาที่เป็นร่าง');

    if (found.lineCount === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ใบเสนอราคาต้องมีอย่างน้อยหนึ่งรายการ',
        [{ field: 'lines', reason: 'required' }],
      );
    }
    if (!found.validUntil) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุวันหมดอายุของใบเสนอราคา',
        [{ field: 'valid_until', reason: 'required' }],
      );
    }
    assertNotExpired(found);
    await this.assertPricesInEffect(found);

    const config = await this.configOf(actor.activeCompanyId);
    const marginPct = found.marginPct;
    const marginBelow = marginNeedsApproval(marginPct, config.minMarginPct);
    const now = new Date();

    const reason = dto.reason?.trim();
    if (marginBelow && !reason) {
      throw new AppError(
        'VALIDATION_FAILED',
        `margin ต่ำกว่าเกณฑ์ ${config.minMarginPct}% — ต้องระบุเหตุผลเพื่อขออนุมัติ`,
        [{ field: 'reason', reason: 'required_when_margin_below_minimum' }],
      );
    }

    let request: { id: string };
    try {
      request = await this.requestsService.create(
        {
          type_code: config.quotationApprovalTypeCode,
          ref_type: 'quotation',
          ref_id: found.id,
          form_data: {
            customer_name: found.partyName,
            quotation_no: found.quotationNo,
            version_no: found.version,
            // What a ladder level's condition routes on (CD-201).
            net_total: Number(found.netTotal.toFixed(2)),
            // CD-80 — value before discount, the discount, and the cost: the
            // three inputs the DSC form computes its margin from, so the
            // request shows the same margin the quotation does. Four decimals
            // on the discount keep the recomputed margin within rounding.
            deal_value: Number(found.subtotal.toFixed(2)),
            discount_pct: found.subtotal.gt(0)
              ? Number(
                  found.discountTotal.div(found.subtotal).mul(100).toFixed(4),
                )
              : 0,
            cost: Number(found.costTotal.toFixed(2)),
            // Kept for an approval type whose form does not compute it yet;
            // on one that does, the computed value replaces this.
            est_margin_pct:
              marginPct === null ? 0 : Number(marginPct.toFixed(2)),
            margin_below_minimum: marginBelow ? 'yes' : 'no',
            // The margin itself travels only in `est_margin_pct`, which the
            // masking rule covers; repeating it in free text leaked it to
            // everyone who can read the request (CD-127).
            reason: marginBelow
              ? `${label(found)} · margin ต่ำกว่าเกณฑ์ ${config.minMarginPct}% — ${reason}`
              : `${label(found)} · ขออนุมัติราคา${reason ? ` — ${reason}` : ''}`,
          },
        },
        actor,
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw new AppError(
        'CRM_QUOTATION_APPROVAL_UNAVAILABLE',
        `ยื่นขออนุมัติไม่ได้ — ประเภทคำขอ ${config.quotationApprovalTypeCode} ไม่เปิดให้บริษัทนี้ใช้ (ตั้งค่าได้ที่ ตั้งค่า CRM)`,
        [
          {
            field: 'quotation_approval_type_code',
            reason: config.quotationApprovalTypeCode,
          },
        ],
      );
    }

    await this.transition(found, actor, {
      from: ['draft'],
      data: {
        status: 'pending_approval',
        submittedAt: now,
        minMarginPct: config.minMarginPct,
        approvalRequired: true,
        approvalRequestId: request.id,
      },
      eventType: 'crm.quotation.submitted_for_approval',
      auditAfter: {
        marginPct: marginPct?.toFixed(2) ?? null,
        minMarginPct: config.minMarginPct,
        marginBelowMinimum: marginBelow,
        approvalRequestId: request.id,
        ...(reason ? { reason } : {}),
      },
      timeline: {
        eventType: 'quotation.pending_approval',
        summary: marginBelow
          ? `ใบเสนอราคา ${label(found)} รออนุมัติราคา (margin ต่ำกว่าเกณฑ์)`
          : `ใบเสนอราคา ${label(found)} รออนุมัติราคา`,
      },
    });

    // Filed for the salesperson; a type that asks for more than the system
    // fills (a document, a receiver) stays a draft they open and finish.
    if (authorization) {
      try {
        await this.requestsService.submit(request.id, actor, authorization);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
      }
    }

    return this.findOne(id, actor);
  }

  /** ส่งลูกค้า — ล็อกฉบับนี้ (แก้ไม่ได้อีก). */
  async send(id: string, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    assertStatus(
      found,
      ['approved'],
      'ส่งลูกค้าได้เฉพาะใบเสนอราคาที่อนุมัติแล้ว',
    );
    assertNotExpired(found);

    await this.transition(found, actor, {
      from: ['approved'],
      data: { status: 'sent', sentAt: new Date() },
      eventType: 'crm.quotation.sent',
      timeline: {
        eventType: 'quotation.sent',
        summary: `ส่งใบเสนอราคา ${label(found)} ให้ลูกค้า · ยอดสุทธิ ${found.netTotal.toFixed(2)} ${found.currency}`,
      },
    });

    return this.findOne(id, actor);
  }

  async accept(id: string, dto: AcceptQuotationDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    assertStatus(
      found,
      ['sent'],
      'บันทึกลูกค้ายอมรับได้เฉพาะใบเสนอราคาที่ส่งแล้ว',
    );
    assertNotExpired(found);

    await this.transition(found, actor, {
      from: ['sent'],
      data: {
        status: 'accepted',
        respondedAt: new Date(),
        responseNote: dto.note?.trim() || null,
      },
      eventType: 'crm.quotation.accepted',
      auditAfter: { note: dto.note ?? null },
      timeline: {
        eventType: 'quotation.accepted',
        summary: `ลูกค้ายอมรับใบเสนอราคา ${label(found)}`,
      },
    });

    return this.findOne(id, actor);
  }

  async decline(id: string, dto: DeclineQuotationDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    assertStatus(
      found,
      ['sent'],
      'บันทึกลูกค้าปฏิเสธได้เฉพาะใบเสนอราคาที่ส่งแล้ว',
    );

    await this.transition(found, actor, {
      from: ['sent'],
      data: {
        status: 'declined',
        respondedAt: new Date(),
        responseNote: dto.reason.trim(),
      },
      eventType: 'crm.quotation.declined',
      auditAfter: { reason: dto.reason },
      timeline: {
        eventType: 'quotation.declined',
        summary: `ลูกค้าปฏิเสธใบเสนอราคา ${label(found)} — ${dto.reason.trim()}`,
      },
    });

    return this.findOne(id, actor);
  }

  async cancel(id: string, dto: CancelQuotationDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    assertStatus(
      found,
      CANCELLABLE,
      'ใบเสนอราคานี้ยกเลิกไม่ได้ในสถานะปัจจุบัน',
    );

    await this.transition(found, actor, {
      from: CANCELLABLE,
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: dto.reason.trim(),
      },
      eventType: 'crm.quotation.cancelled',
      auditAfter: { reason: dto.reason },
      timeline: {
        eventType: 'quotation.cancelled',
        summary: `ยกเลิกใบเสนอราคา ${label(found)} — ${dto.reason.trim()}`,
      },
    });

    return this.findOne(id, actor);
  }

  /**
   * ออกเวอร์ชันใหม่ — ทางเดียวที่จะ "แก้" ใบที่ยื่น/ส่งไปแล้ว. คัดลอกหัวและรายการเป็น
   * ร่างเวอร์ชันถัดไป (ข้อมูลคู่ค้า snapshot ใหม่จากโอกาสการขาย เพราะอาจเปิดใบสั่งขาย
   * สร้างลูกค้าไปแล้ว, วันหมดอายุนับใหม่) แล้วติด `superseded` ให้ฉบับเดิม — ในทาง
   * transaction เดียว. ต้องเป็นเวอร์ชันล่าสุดของเลขนั้น.
   */
  async revise(id: string, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    assertStatus(
      found,
      REVISABLE,
      found.status === 'draft'
        ? 'ใบนี้ยังเป็นร่าง — แก้ไขได้เลยโดยไม่ต้องออกเวอร์ชันใหม่'
        : 'ออกเวอร์ชันใหม่ไม่ได้จากสถานะปัจจุบัน',
    );

    const opportunity = await this.requireOpenOpportunity(
      found.opportunityId,
      actor,
    );
    const config = await this.configOf(actor.activeCompanyId);

    const created = await this.transactions.execute(async (prisma) => {
      const latest = await prisma.quotation.findFirst({
        where: { companyId: found.companyId, quotationNo: found.quotationNo },
        orderBy: { version: 'desc' },
        select: { id: true, version: true },
      });
      if (latest?.id !== found.id) {
        throw new AppError(
          'CRM_QUOTATION_STATE_INVALID',
          'มีเวอร์ชันที่ใหม่กว่านี้แล้ว — ออกเวอร์ชันใหม่จากฉบับล่าสุด',
          [{ field: 'version', reason: String(latest?.version ?? '') }],
        );
      }

      const superseded = await prisma.quotation.updateMany({
        where: { id: found.id, status: { in: REVISABLE } },
        data: { status: 'superseded', updatedBy: actor.userId },
      });
      if (superseded.count !== 1) {
        throw new AppError(
          'CRM_QUOTATION_STATE_INVALID',
          'สถานะใบเสนอราคาเปลี่ยนไปแล้ว — โหลดใหม่แล้วลองอีกครั้ง',
        );
      }

      const version = found.version + 1;
      const row = (await this.quotations.create(
        {
          data: {
            quotationNo: found.quotationNo,
            version,
            companyId: found.companyId,
            opportunityId: found.opportunityId,
            ...partyOf(opportunity),
            title: found.title,
            currency: found.currency,
            validUntil: defaultValidUntil(config.quotationValidityDays),
            paymentTerms: found.paymentTerms,
            note: found.note,
            subtotal: found.subtotal,
            discountTotal: found.discountTotal,
            netTotal: found.netTotal,
            vatPct: found.vatPct,
            vatAmount: found.vatAmount,
            grandTotal: found.grandTotal,
            costTotal: found.costTotal,
            marginAmount: found.marginAmount,
            marginPct: found.marginPct,
            ownerUserId: found.ownerUserId,
            ownerOrgUnitId: found.ownerOrgUnitId,
            // CD-198 — a new version of a quotation from a Solution still is one.
            solutionId: found.solutionId,
            solutionVersionNo: found.solutionVersionNo,
            createdBy: actor.userId,
            lines: {
              create: found.lines.map((line) => ({
                lineNo: line.lineNo,
                productCode: line.productCode,
                description: line.description,
                quantity: line.quantity,
                unit: line.unit,
                unitPrice: line.unitPrice,
                unitCost: line.unitCost,
                discountPct: line.discountPct,
                lineTotal: line.lineTotal,
                lineCost: line.lineCost,
                priceId: line.priceId,
                priceModel: line.priceModel,
                termMonths: line.termMonths,
                costSource: line.costSource,
                workType: line.workType,
                markupPct: line.markupPct,
              })),
            },
          },
        },
        { prisma },
      )) as { id: string; customerId: string | null };

      await this.audit.record(
        {
          eventType: 'crm.quotation.revised',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'quotation',
          resourceId: row.id,
          before: {
            id: found.id,
            version: found.version,
            status: found.status,
          },
          after: { id: row.id, version, status: 'draft' },
        },
        { prisma },
      );

      await this.publishTimeline(prisma, actor, row.customerId, row.id, {
        eventType: 'quotation.revised',
        summary: `ออกใบเสนอราคา ${found.quotationNo} เวอร์ชัน ${version} แทนเวอร์ชัน ${found.version}`,
      });

      return row;
    });

    return this.findOne(created.id, actor);
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * One status move, guarded by the status it was read in (`updateMany … where
   * status in from`) so two clicks racing cannot both apply — the loser gets a
   * conflict instead of a second audit entry for a move that did not happen.
   */
  private async transition(
    found: QuotationForAction,
    actor: Principal,
    move: {
      from: QuotationStatus[];
      data: Prisma.QuotationUpdateManyMutationInput;
      eventType: string;
      auditAfter?: Record<string, unknown>;
      timeline: { eventType: string; summary: string };
    },
  ) {
    await this.transactions.execute(async (prisma) => {
      const result = await prisma.quotation.updateMany({
        where: { id: found.id, status: { in: move.from } },
        data: { ...move.data, updatedBy: actor.userId },
      });
      if (result.count !== 1) {
        throw new AppError(
          'CRM_QUOTATION_STATE_INVALID',
          'สถานะใบเสนอราคาเปลี่ยนไปแล้ว — โหลดใหม่แล้วลองอีกครั้ง',
        );
      }

      await this.audit.record(
        {
          eventType: move.eventType,
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'quotation',
          resourceId: found.id,
          before: { status: found.status },
          after: { status: move.data.status, ...(move.auditAfter ?? {}) },
        },
        { prisma },
      );

      await this.publishTimeline(
        prisma,
        actor,
        found.customerId,
        found.id,
        move.timeline,
      );
    });
  }

  /** ไทม์ไลน์เป็นของลูกค้า — ผู้มุ่งหวังยังไม่มีหน้า 360° ให้ลง (เหมือนโอกาสการขาย). */
  private async publishTimeline(
    prisma: TQueryClient,
    actor: Principal,
    customerId: string | null,
    quotationId: string,
    event: { eventType: string; summary: string },
  ) {
    if (!customerId) return;
    await this.timeline.publish(
      {
        companyId: actor.activeCompanyId,
        customerId,
        refType: 'quotation',
        refId: quotationId,
        eventType: event.eventType,
        summary: event.summary,
        actorId: auditActor(actor).actorId,
        actorName: actor.displayName,
      },
      { prisma },
    );
  }

  /**
   * CD-195 — which lines really carry a standard price: the one named must
   * exist for the same code and currency, be in effect today and equal the
   * line's unit price. Anything else is a price typed by hand (null).
   */
  private async priceRefs(
    companyId: string,
    currency: string,
    lines: readonly QuotationLineDto[],
    opportunityId: string,
  ): Promise<(string | null)[]> {
    const ids = [
      ...new Set(lines.map((line) => line.price_id).filter(Boolean)),
    ] as string[];
    if (!ids.length) return lines.map(() => null);
    const today = startOfToday();
    const rows = (await this.prices.findMany({
      where: {
        id: { in: ids },
        companyId,
        currency,
        deletedAt: null,
        validFrom: { lte: today },
        OR: [{ validTo: null }, { validTo: { gte: today } }],
      },
      select: {
        id: true,
        productCode: true,
        unitPrice: true,
        priceModel: true,
        scope: true,
        customerId: true,
        segmentValueId: true,
        opportunityId: true,
      },
    })) as {
      id: string;
      productCode: string;
      unitPrice: Prisma.Decimal;
      priceModel: string;
      scope: string;
      customerId: string | null;
      segmentValueId: string | null;
      opportunityId: string | null;
    }[];
    const applies = await this.specialPriceScope(opportunityId, rows);
    const byId = new Map(rows.map((row) => [row.id, row]));
    return lines.map((line) => {
      const price = line.price_id ? byId.get(line.price_id) : undefined;
      return price &&
        applies(price) &&
        price.productCode === line.product_code?.trim() &&
        price.priceModel === (line.price_model ?? 'unit') &&
        Number(price.unitPrice) === line.unit_price
        ? price.id
        : null;
    });
  }

  /**
   * CD-197 — a special price counts only on its own deal, its own customer's
   * quotations, or a customer in its group. The deal's customer is read now:
   * a prospect's quotation gains one when the sale order opens.
   */
  private async specialPriceScope(
    opportunityId: string,
    rows: readonly { scope: string }[],
  ): Promise<
    (price: {
      scope: string;
      customerId: string | null;
      segmentValueId: string | null;
      opportunityId: string | null;
    }) => boolean
  > {
    if (rows.every((row) => row.scope === 'standard')) return () => true;
    const deal = (await this.opportunities.findFirst({
      where: { id: opportunityId },
      select: { customerId: true },
    })) as { customerId: string | null } | null;
    const customerId = deal?.customerId ?? null;
    const segments = customerId
      ? (
          (await this.segmentAssignments.findMany({
            where: { customerId },
            select: { valueId: true },
          })) as { valueId: string }[]
        ).map((row) => row.valueId)
      : [];
    return (price) =>
      price.scope === 'standard' ||
      (price.scope === 'opportunity' &&
        price.opportunityId === opportunityId) ||
      (price.scope === 'customer' &&
        customerId !== null &&
        price.customerId === customerId) ||
      (price.scope === 'segment' &&
        price.segmentValueId !== null &&
        segments.includes(price.segmentValueId));
  }

  /** CD-195 — a line's standard price must still be in effect on submit. */
  private async assertPricesInEffect(found: QuotationForAction) {
    const ids = [
      ...new Set(found.lines.map((line) => line.priceId).filter(Boolean)),
    ] as string[];
    if (!ids.length) return;
    const today = startOfToday();
    const live = (await this.prices.findMany({
      where: {
        id: { in: ids },
        deletedAt: null,
        validFrom: { lte: today },
        OR: [{ validTo: null }, { validTo: { gte: today } }],
      },
      select: { id: true },
    })) as { id: string }[];
    const ok = new Set(live.map((row) => row.id));
    const stale = found.lines.filter(
      (line) => line.priceId && !ok.has(line.priceId),
    );
    if (stale.length) {
      throw new AppError(
        'CONFLICT',
        `ราคามาตรฐานของ ${stale.map((line) => line.productCode ?? `บรรทัด ${line.lineNo}`).join(', ')} ไม่มีผลแล้ว — เลือกสินค้าใหม่เพื่อดึงราคาปัจจุบันก่อนยื่น`,
        stale.map((line) => ({
          field: `lines[${line.lineNo - 1}].price_id`,
          reason: 'price_not_in_effect',
        })),
      );
    }
  }

  private async requireVisible(
    id: string,
    actor: Principal,
  ): Promise<QuotationForAction> {
    const found = (await this.quotations.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    })) as
      | (Omit<QuotationForAction, 'lineCount'> & {
          lines: QuotationForAction['lines'];
        })
      | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบใบเสนอราคาที่ระบุ');
    return { ...found, lineCount: found.lines.length };
  }

  /** Visible AND still open. SCOPE-03: unseen = 404. */
  private async requireOpenOpportunity(
    id: string,
    actor: Principal,
  ): Promise<OpportunityForQuotation> {
    const found = (await this.opportunities.findFirst({
      where: { id, AND: [visibleSalesWhere(salesAccessSubject(actor))] },
      select: {
        id: true,
        opportunityCode: true,
        title: true,
        stage: true,
        currency: true,
        customerId: true,
        customer: { select: { nameTh: true, taxId: true } },
        prospectName: true,
        prospectTaxId: true,
        prospectContactName: true,
        ownerUserId: true,
        ownerOrgUnitId: true,
      },
    })) as OpportunityForQuotation | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    if (found.stage === 'won' || found.stage === 'lost') {
      throw new AppError(
        'CONFLICT',
        'โอกาสการขายนี้ปิดแล้ว — ออกใบเสนอราคาได้เฉพาะโอกาสการขายที่ยังเปิดอยู่',
      );
    }
    return found;
  }

  private async configOf(companyId: string) {
    const found = (await this.configs.findFirst({
      where: { companyId },
      select: {
        minMarginPct: true,
        quotationValidityDays: true,
        vatPct: true,
        quotationApprovalTypeCode: true,
      },
    })) as typeof CONFIG_DEFAULTS | null;
    return found ?? CONFIG_DEFAULTS;
  }
}

interface QuotationForAction {
  id: string;
  quotationNo: string;
  version: number;
  companyId: string;
  opportunityId: string;
  customerId: string | null;
  partyName: string;
  title: string;
  status: QuotationStatus;
  currency: string;
  validUntil: Date | null;
  paymentTerms: string | null;
  note: string | null;
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  netTotal: Prisma.Decimal;
  vatPct: Prisma.Decimal;
  vatAmount: Prisma.Decimal;
  grandTotal: Prisma.Decimal;
  costTotal: Prisma.Decimal;
  marginAmount: Prisma.Decimal;
  marginPct: Prisma.Decimal | null;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
  lineCount: number;
  lines: {
    lineNo: number;
    productCode: string | null;
    description: string;
    quantity: Prisma.Decimal;
    unit: string | null;
    unitPrice: Prisma.Decimal;
    unitCost: Prisma.Decimal;
    discountPct: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
    lineCost: Prisma.Decimal;
    priceId: string | null;
    priceModel: string;
    termMonths: number | null;
    costSource: string | null;
    workType: string | null;
    markupPct: Prisma.Decimal | null;
  }[];
  solutionId: string | null;
  solutionVersionNo: number | null;
}

interface OpportunityForQuotation {
  id: string;
  opportunityCode: string;
  title: string;
  stage: string;
  currency: string;
  customerId: string | null;
  customer: { nameTh: string; taxId: string | null } | null;
  prospectName: string | null;
  prospectTaxId: string | null;
  prospectContactName: string | null;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
}

function assertStatus(
  found: { status: QuotationStatus },
  allowed: QuotationStatus[],
  message: string,
): void {
  if (!allowed.includes(found.status)) {
    throw new AppError('CRM_QUOTATION_STATE_INVALID', message, [
      { field: 'status', reason: found.status },
    ]);
  }
}

function assertNotExpired(found: { validUntil: Date | null }): void {
  if (quotationExpired(found.validUntil, new Date())) {
    throw new AppError(
      'CRM_QUOTATION_EXPIRED',
      'ใบเสนอราคาหมดอายุแล้ว — ออกเวอร์ชันใหม่เพื่อกำหนดวันหมดอายุใหม่',
      [{ field: 'valid_until', reason: found.validUntil?.toISOString() ?? '' }],
    );
  }
}

function withExpiry<
  T extends { validUntil: Date | null; status: QuotationStatus },
>(row: T): T & { expired: boolean } {
  const live = ['draft', 'pending_approval', 'approved', 'sent'].includes(
    row.status,
  );
  return {
    ...row,
    expired: live && quotationExpired(row.validUntil, new Date()),
  };
}

function label(found: { quotationNo: string; version: number }): string {
  return `${found.quotationNo} v${found.version}`;
}

/** คู่ค้าบนเอกสาร — ลูกค้าในทะเบียนถ้าผูกแล้ว ไม่งั้นผู้มุ่งหวัง. */
function partyOf(opportunity: OpportunityForQuotation) {
  return {
    customerId: opportunity.customerId,
    partyName:
      opportunity.customer?.nameTh ??
      opportunity.prospectName ??
      opportunity.title,
    partyTaxId:
      opportunity.customer?.taxId ?? opportunity.prospectTaxId ?? null,
    contactName: opportunity.prospectContactName ?? null,
  };
}

function lineInput(line: QuotationLineDto): QuotationLineInput {
  return {
    quantity: line.quantity,
    unit_price: line.unit_price,
    unit_cost: line.unit_cost,
    discount_pct: line.discount_pct,
    price_model: line.price_model,
    term_months: line.term_months,
  };
}

/** CD-196 — a monthly line needs its months. */
function assertPriceModels(lines: readonly QuotationLineDto[]) {
  const problems = priceModelProblems(lines.map(lineInput));
  if (problems.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      'บรรทัดราคารายเดือนต้องระบุจำนวนเดือน (1–120)',
      problems,
    );
  }
}

function linesData(
  lines: QuotationLineDto[],
  totals: ReturnType<typeof computeQuotationTotals>,
  priceRefs: readonly (string | null)[] = [],
) {
  return lines.map((line, index) => ({
    lineNo: index + 1,
    productCode: line.product_code?.trim() || null,
    description: line.description.trim(),
    // CD-196 — a lump sum is one job, whatever was typed.
    quantity: line.price_model === 'lump_sum' ? 1 : line.quantity,
    unit: line.unit?.trim() || null,
    unitPrice: line.unit_price,
    unitCost: line.unit_cost ?? 0,
    discountPct: line.discount_pct ?? 0,
    lineTotal: totals.lines[index].lineTotal,
    lineCost: totals.lines[index].lineCost,
    priceId: priceRefs[index] ?? null,
    priceModel: line.price_model ?? 'unit',
    termMonths:
      line.price_model === 'monthly' ? (line.term_months ?? null) : null,
    workType: line.work_type ?? null,
    // CD-200 — the markup stays only while it still explains the price.
    markupPct:
      line.markup_pct !== undefined &&
      markupPrice(line.unit_cost ?? 0, line.markup_pct) === line.unit_price
        ? line.markup_pct
        : null,
  }));
}

function totalsData(totals: ReturnType<typeof computeQuotationTotals>) {
  return {
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    netTotal: totals.netTotal,
    vatPct: totals.vatPct,
    vatAmount: totals.vatAmount,
    grandTotal: totals.grandTotal,
    costTotal: totals.costTotal,
    marginAmount: totals.marginAmount,
    marginPct: totals.marginPct,
  };
}

/** Today as a UTC date, matching the `@db.Date` price columns. */
function startOfToday(): Date {
  return new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
}

/** CD-198 — keep a line's cost source while its product and cost stand. */
function keptCostSource(
  before:
    | {
        productCode: string | null;
        unitCost: Prisma.Decimal;
        costSource: string | null;
      }
    | undefined,
  after: QuotationLineDto,
): string | null {
  if (!before?.costSource) return null;
  return (before.productCode ?? '') === (after.product_code?.trim() ?? '') &&
    Number(before.unitCost) === (after.unit_cost ?? 0)
    ? before.costSource
    : null;
}
