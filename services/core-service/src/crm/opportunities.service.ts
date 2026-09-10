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

const OPEN_STAGES: OpportunityStage[] = ['qualifying', 'proposing', 'negotiating'];

/**
 * CRM โอกาสการขาย — ขั้น มูลค่า ความน่าจะเป็น วันคาดปิด; ปิดชนะ/แพ้เป็น
 * endpoint ของตัวเอง และปิดแพ้ต้องมีเหตุผลมาตรฐาน (วิเคราะห์ได้). ทุก
 * เหตุการณ์สำคัญไหลเข้าไทม์ไลน์ลูกค้า (C360-03) และชุดงาน B จบที่นี่:
 * โอกาสการขายที่มี product เข้าเงื่อนไข KYC + ลูกค้ายังไม่ verified = คำเตือน ไม่ block.
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
    if (query.search) {
      const q = query.search.trim();
      filters.OR = [
        { title: { contains: q, mode: 'insensitive' } },
        { opportunityCode: { contains: q, mode: 'insensitive' } },
        { customer: { nameTh: { contains: q, mode: 'insensitive' } } },
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
      } as Prisma.OpportunityWhereInput,
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
      },
    })) as
      | ({
          companyId: string;
          products: { productCode: string; name: string | null }[];
          customer: { kycVerified: boolean };
        } & Record<string, unknown>)
      | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');

    // CM-04 ชุดงาน B — เงื่อนไขระดับ product: เตือน ไม่ block (PO 8 ก.ย. 2569).
    let kycWarning: { required: boolean; products: string[] } = {
      required: false,
      products: [],
    };
    if (!found.customer.kycVerified && found.products.length) {
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
    const customer = await this.assertCustomer(dto.customer_id, actor);

    const created = await this.transactions.execute(async (prisma) => {
      const opportunityCode = await this.codes.issue(actor.activeCompanyId, prisma);

      const row = (await this.opportunities.create(
        {
          data: {
            opportunityCode,
            companyId: actor.activeCompanyId,
            customerId: dto.customer_id,
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
            customerId: dto.customer_id,
            amount: dto.amount ?? null,
            fromLeadId: options?.fromLeadId ?? null,
          },
        },
        { prisma },
      );

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: dto.customer_id,
          refType: 'opportunity',
          refId: row.id,
          eventType: 'opportunity.created',
          summary: `เปิดโอกาสการขาย ${opportunityCode} · ${dto.title.trim()} (${customer.nameTh})`,
          actorId: auditActor(actor).actorId,
          actorName: actor.displayName,
        },
        { prisma },
      );

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
        await prisma.opportunityProduct.deleteMany({ where: { opportunityId: id } });
        const codes = dedupe(dto.product_codes);
        if (codes.length) {
          await this.products.createMany(
            { data: codes.map((code) => ({ opportunityId: id, productCode: code })) },
            { prisma },
          );
        }
      }

      if (dto.stage !== undefined && dto.stage !== found.stage) {
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

  async win(id: string, actor: Principal) {
    const found = await this.requireOpen(id, actor);
    return this.close(found, 'won', actor, {});
  }

  /** ปิดแพ้ — เหตุผลจากรายการมาตรฐานเท่านั้น (spec CRM). */
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
    to: 'won' | 'lost',
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
            ...(to === 'won' ? { wonAt: new Date() } : { lostAt: new Date() }),
            lostReasonCode: extra.lostReasonCode ?? null,
            lostReasonText: extra.lostReasonText ?? null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );

      await this.audit.record(
        {
          eventType: to === 'won' ? 'crm.opportunity.won' : 'crm.opportunity.lost',
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

      await this.timeline.publish(
        {
          companyId: actor.activeCompanyId,
          customerId: found.customerId,
          refType: 'opportunity',
          refId: found.id,
          eventType: to === 'won' ? 'opportunity.won' : 'opportunity.lost',
          summary:
            to === 'won'
              ? `ปิดโอกาสการขาย ${found.opportunityCode} สำเร็จ (ชนะ)`
              : `ปิดโอกาสการขาย ${found.opportunityCode} — แพ้ (${extra.reasonName})`,
          actorId: auditActor(actor).actorId,
          actorName: actor.displayName,
        },
        { prisma },
      );
    });

    return this.findOne(found.id, actor);
  }

  /** Visible AND still open. SCOPE-03: unseen = 404. */
  private async requireOpen(id: string, actor: Principal): Promise<OpenOpportunity> {
    const found = (await this.opportunities.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      } as Prisma.OpportunityWhereInput,
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
  customerId: string;
}

function dedupe(codes: string[] | undefined): string[] {
  return [...new Set((codes ?? []).map((code) => code.trim()).filter(Boolean))];
}
