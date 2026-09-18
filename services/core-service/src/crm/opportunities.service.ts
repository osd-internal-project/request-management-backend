import { Injectable } from '@nestjs/common';
import type { OpportunityStage, Prisma } from '@prisma/client';
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
  OPPORTUNITY_LIST_SELECT,
  OpportunityLostReasonRepository,
  OpportunityProductRepository,
  OpportunityRepository,
  SALE_ORDER_LIST_SELECT,
} from './sales.repositories';
import { OpportunityCodeService } from './opportunity-code.service';
import { CustomerRepository } from './customer.repository';
import { KycProductRuleRepository } from './kyc-product.repository';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  CreateOpportunityDto,
  ListOpportunitiesQueryDto,
  LoseOpportunityDto,
  UpdateOpportunityDto,
} from './dto/sales.dto';

const OPEN_STAGES: OpportunityStage[] = [
  'qualifying',
  'proposing',
  'negotiating',
];

/**
 * CRM โอกาสการขาย — ขั้น มูลค่า ความน่าจะเป็น วันคาดปิด; ปิดแพ้เป็น endpoint
 * ของตัวเองและต้องมีเหตุผลมาตรฐาน (วิเคราะห์ได้). ทุกเหตุการณ์สำคัญไหลเข้า
 * ไทม์ไลน์ลูกค้า (C360-03) และชุดงาน B จบที่นี่: โอกาสการขายที่มี product เข้า
 * เงื่อนไข KYC + ลูกค้ายังไม่ verified = คำเตือน ไม่ block.
 *
 * PO 10 ก.ย. 2569: **การเปิดโอกาสการขายยังไม่ถือเป็นลูกค้า** — `customerId` ว่าง
 * ได้ (ผู้มุ่งหวัง ถือชื่อ/เลขภาษี/ผู้ติดต่อไว้ใน `prospect*`), ลูกค้าในทะเบียน
 * เกิดเมื่อเปิดใบสั่งขายเท่านั้น (`SaleOrdersService.open`) ซึ่งเป็นทางเดียวที่
 * โอกาสการขายจะปิดชนะ — จึงไม่มี endpoint `win` แยกอีก. ไทม์ไลน์ลูกค้าเขียนได้
 * เฉพาะเมื่อมีลูกค้าแล้ว.
 */
@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly opportunities: OpportunityRepository,
    private readonly products: OpportunityProductRepository,
    private readonly lostReasons: OpportunityLostReasonRepository,
    private readonly customers: CustomerRepository,
    private readonly kycProducts: KycProductRuleRepository,
    private readonly codes: OpportunityCodeService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(actor: Principal, query: ListOpportunitiesQueryDto) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.OpportunityWhereInput = {};

    if (query.stage) filters.stage = query.stage;
    if (query.open === 'true') filters.stage = { in: OPEN_STAGES };
    if (query.customer_id) filters.customerId = query.customer_id;
    if (query.view === 'mine') filters.ownerUserId = actor.userId;
    if (query.follow_up === 'overdue') {
      filters.nextFollowUpAt = { lt: new Date() };
      filters.stage = { in: OPEN_STAGES };
    }
    if (query.follow_up === 'stale') {
      filters.staleAlertedAt = { not: null };
      filters.stage = { in: OPEN_STAGES };
    }
    if (query.search) {
      const q = query.search.trim();
      filters.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { opportunityCode: { contains: q, mode: 'insensitive' } },
        { customer: { nameTh: { contains: q, mode: 'insensitive' } } },
        { prospectName: { contains: q, mode: 'insensitive' } },
      ];
    }

    const where = {
      AND: [visibleSalesWhere(salesAccessSubject(actor)), filters],
    } as Prisma.OpportunityWhereInput;

    const [rows, total] = await Promise.all([
      this.opportunities.findMany({
        where,
        select: OPPORTUNITY_LIST_SELECT,
        skip,
        take,
        orderBy: { updatedAt: 'desc' },
      }),
      this.opportunities.count({ where }),
    ]);

    return paginated(rows as unknown[], query, total);
  }

  /** Detail + the ชุดงาน B answer: does this opportunity demand KYC attention? */
  async findOne(id: string, actor: Principal) {
    const found = (await this.opportunities.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      include: {
        customer: {
          select: {
            id: true,
            customerCode: true,
            nameTh: true,
            branchCode: true,
            branchName: true,
            kycVerified: true,
          },
        },
        products: { select: { productCode: true, name: true } },
        fromLead: { select: { id: true, name: true, sourceCode: true } },
        saleOrders: {
          select: SALE_ORDER_LIST_SELECT,
          orderBy: { orderedAt: 'desc' },
        },
      },
    })) as
      | ({
          companyId: string;
          products: { productCode: string; name: string | null }[];
          customer: { kycVerified: boolean } | null;
        } & Record<string, unknown>)
      | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');

    // CM-04 ชุดงาน B — เงื่อนไขระดับ product: เตือน ไม่ block (PO 8 ก.ย. 2569).
    // ผู้มุ่งหวัง (ยังไม่มีลูกค้า) นับว่ายังไม่ verified — ยื่น KYC ได้เมื่อเปิดใบสั่งขายแล้ว.
    let kycWarning: { required: boolean; products: string[] } = {
      required: false,
      products: [],
    };
    if (!found.customer?.kycVerified && found.products.length) {
      const rules = (await this.kycProducts.findMany({
        where: {
          companyId: found.companyId,
          active: true,
          productCode: { in: found.products.map((p) => p.productCode) },
        },
        select: { productCode: true },
      })) as { productCode: string }[];
      kycWarning = {
        required: rules.length > 0,
        products: rules.map((rule) => rule.productCode),
      };
    }

    return { ...found, kycWarning };
  }

  async lostReasonOptions(actor: Principal) {
    return this.lostReasons.findMany({
      where: { companyId: actor.activeCompanyId, active: true },
      select: { code: true, name: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async create(
    dto: CreateOpportunityDto,
    actor: Principal,
    options?: { fromLeadId?: string },
  ) {
    // PO 10 ก.ย. 2569: ลูกค้าเดิม หรือ ผู้มุ่งหวัง อย่างใดอย่างหนึ่ง — ไม่บังคับให้
    // มีทะเบียนลูกค้าก่อน (ลูกค้าเกิดตอนเปิดใบสั่งขาย).
    const customer = dto.customer_id
      ? await this.assertCustomer(dto.customer_id, actor)
      : null;
    const prospect = customer
      ? null
      : {
          prospectName: dto.prospect_name?.trim() || null,
          prospectTaxId: dto.prospect_tax_id?.replace(/[^0-9]/g, '') || null,
          prospectContactName: dto.prospect_contact_name?.trim() || null,
          prospectPhone: dto.prospect_phone?.trim() || null,
          prospectEmail: dto.prospect_email?.trim() || null,
        };

    if (!customer && !prospect?.prospectName) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุลูกค้าเดิมในทะเบียน หรือชื่อผู้มุ่งหวัง อย่างใดอย่างหนึ่ง',
        [{ field: 'prospect_name', reason: 'required_without_customer_id' }],
      );
    }

    const partyName = customer?.nameTh ?? prospect?.prospectName ?? '';

    const created = await this.transactions.execute(async (prisma) => {
      const opportunityCode = await this.codes.issue(
        actor.activeCompanyId,
        prisma,
      );

      const row = (await this.opportunities.create(
        {
          data: {
            opportunityCode,
            companyId: actor.activeCompanyId,
            customerId: customer?.id ?? null,
            ...(prospect ?? {}),
            title: dto.title.trim(),
            amount: dto.amount ?? null,
            probability: dto.probability ?? null,
            expectedCloseAt: dto.expected_close_at
              ? new Date(dto.expected_close_at)
              : null,
            ownerUserId: actor.userId,
            ownerOrgUnitId: actor.orgUnitId,
            createdBy: actor.userId,
            products: {
              create: dedupe(dto.product_codes).map((code) => ({
                productCode: code,
              })),
            },
          },
        },
        { prisma },
      )) as { id: string; opportunityCode: string };

      await this.audit.record(
        {
          eventType: 'crm.opportunity.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: row.id,
          after: {
            opportunityCode,
            title: dto.title,
            customerId: customer?.id ?? null,
            prospectName: prospect?.prospectName ?? null,
            amount: dto.amount ?? null,
            fromLeadId: options?.fromLeadId ?? null,
          },
        },
        { prisma },
      );

      // ไทม์ไลน์เป็นของลูกค้า — ผู้มุ่งหวังยังไม่มีหน้า 360° ให้ลง.
      if (customer) {
        await this.timeline.publish(
          {
            companyId: actor.activeCompanyId,
            customerId: customer.id,
            refType: 'opportunity',
            refId: row.id,
            eventType: 'opportunity.created',
            summary: `เปิดโอกาสการขาย ${opportunityCode} · ${dto.title.trim()} (${partyName})`,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );
      }

      return row;
    });

    return created;
  }

  async update(id: string, dto: UpdateOpportunityDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);

    await this.transactions.execute(async (prisma) => {
      await this.opportunities.update(
        {
          where: { id },
          data: {
            ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
            ...(dto.stage !== undefined ? { stage: dto.stage } : {}),
            ...(dto.amount !== undefined ? { amount: dto.amount } : {}),
            ...(dto.probability !== undefined
              ? { probability: dto.probability }
              : {}),
            ...(dto.expected_close_at !== undefined
              ? {
                  expectedCloseAt: dto.expected_close_at
                    ? new Date(dto.expected_close_at)
                    : null,
                }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      if (dto.product_codes !== undefined) {
        await prisma.opportunityProduct.deleteMany({
          where: { opportunityId: id },
        });
        const codes = dedupe(dto.product_codes);
        if (codes.length) {
          await this.products.createMany(
            {
              data: codes.map((code) => ({
                opportunityId: id,
                productCode: code,
              })),
            },
            { prisma },
          );
        }
      }

      if (
        dto.stage !== undefined &&
        dto.stage !== found.stage &&
        found.customerId
      ) {
        await this.timeline.publish(
          {
            companyId: actor.activeCompanyId,
            customerId: found.customerId,
            refType: 'opportunity',
            refId: id,
            eventType: 'opportunity.stage_changed',
            summary: `โอกาสการขาย ${found.opportunityCode} เปลี่ยนขั้น ${found.stage} → ${dto.stage}`,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );
      }
    });

    return this.findOne(id, actor);
  }

  /**
   * ปิดแพ้ — เหตุผลจากรายการมาตรฐานเท่านั้น (spec CRM). ปิดชนะไม่มีที่นี่:
   * PO 10 ก.ย. 2569 — ชนะ = เปิดใบสั่งขาย (`SaleOrdersService.open`).
   */
  async lose(id: string, dto: LoseOpportunityDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);

    const reason = (await this.lostReasons.findFirst({
      where: {
        companyId: actor.activeCompanyId,
        code: dto.reason_code,
        active: true,
      },
      select: { code: true, name: true },
    })) as { code: string; name: string } | null;

    if (!reason) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เหตุผลปิดแพ้ต้องเลือกจากรายการมาตรฐาน',
        [{ field: 'reason_code', reason: dto.reason_code }],
      );
    }

    return this.close(found, 'lost', actor, {
      lostReasonCode: reason.code,
      lostReasonText: dto.reason_text?.trim() || null,
      reasonName: reason.name,
    });
  }

  private async close(
    found: OpenOpportunity,
    to: 'lost',
    actor: Principal,
    extra: {
      lostReasonCode?: string;
      lostReasonText?: string | null;
      reasonName?: string;
    },
  ) {
    await this.transactions.execute(async (prisma) => {
      await this.opportunities.update(
        {
          where: { id: found.id },
          data: {
            stage: to,
            lostAt: new Date(),
            lostReasonCode: extra.lostReasonCode ?? null,
            lostReasonText: extra.lostReasonText ?? null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: 'crm.opportunity.lost',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'opportunity',
          resourceId: found.id,
          before: { stage: found.stage },
          after: {
            stage: to,
            reasonCode: extra.lostReasonCode ?? null,
            reasonText: extra.lostReasonText ?? null,
          },
        },
        { prisma },
      );

      if (found.customerId) {
        await this.timeline.publish(
          {
            companyId: actor.activeCompanyId,
            customerId: found.customerId,
            refType: 'opportunity',
            refId: found.id,
            eventType: 'opportunity.lost',
            summary: `ปิดโอกาสการขาย ${found.opportunityCode} — แพ้ (${extra.reasonName})`,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );
      }
    });

    return this.findOne(found.id, actor);
  }

  /** Visible AND still open. SCOPE-03: unseen = 404. */
  private async requireOpen(
    id: string,
    actor: Principal,
  ): Promise<OpenOpportunity> {
    const found = (await this.opportunities.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: {
        id: true,
        opportunityCode: true,
        stage: true,
        customerId: true,
      },
    })) as OpenOpportunity | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    if (found.stage === 'won' || found.stage === 'lost') {
      throw new AppError('CONFLICT', 'โอกาสการขายนี้ปิดแล้ว — แก้ไขไม่ได้');
    }

    return found;
  }

  private async assertCustomer(customerId: string, actor: Principal) {
    const customer = (await this.customers.findFirst({
      where: {
        id: customerId,
        companyId: actor.activeCompanyId,
        mergedIntoCustomerId: null,
      },
      select: { id: true, nameTh: true },
    })) as { id: string; nameTh: string } | null;

    if (!customer) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบลูกค้าที่ระบุ', [
        { field: 'customer_id', reason: customerId },
      ]);
    }

    return customer;
  }
}

interface OpenOpportunity {
  id: string;
  opportunityCode: string;
  stage: OpportunityStage;
  /** null = ผู้มุ่งหวัง (ยังไม่เปิดใบสั่งขาย). */
  customerId: string | null;
}

function dedupe(codes: string[] | undefined): string[] {
  return [...new Set((codes ?? []).map((code) => code.trim()).filter(Boolean))];
}
