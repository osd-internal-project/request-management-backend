import type { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
  TQueryClient,
} from '@request-management/share';
import {
  CrmConfigRepository,
  CustomerSegmentAssignmentRepository,
  CustomerSegmentDimensionRepository,
  CustomerSegmentValueRepository,
} from './segment.repositories';
import {
  CreateKycProductDto,
  CreateSegmentDimensionDto,
  CreateSegmentValueDto,
  UpdateCrmConfigDto,
  UpdateKycProductDto,
  UpdateSegmentDimensionDto,
  UpdateSegmentValueDto,
} from './dto/customer.dto';
import { KycProductRuleRepository } from './kyc-product.repository';
import { ProductCatalogService } from './product-catalog.service';
import { CustomerApprovalService } from './customer-approval.service';
import { cleanMinMargins, WORK_TYPES } from './quotation-math';
import {
  cleanDocumentsSetting,
  documentsByType,
} from '../delivery/delivery-docs-rules';

/**
 * CM-07 + CM-02/03 configuration — the admin surface behind
 * `admin.crm.manage`. Everything here is configuration over code (D-09):
 * dimensions, values, the customer-code shape, and the dedup threshold are
 * all editable without a deploy.
 */
@Injectable()
export class CrmAdminService {
  constructor(
    private readonly dimensions: CustomerSegmentDimensionRepository,
    private readonly values: CustomerSegmentValueRepository,
    private readonly assignments: CustomerSegmentAssignmentRepository,
    private readonly configs: CrmConfigRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly kycProducts: KycProductRuleRepository,
    private readonly catalog: ProductCatalogService,
    private readonly approval: CustomerApprovalService,
  ) {}

  // --- segmentation (CM-07) ------------------------------------------------

  listDimensions(actor: Principal) {
    return this.dimensions.findMany({
      where: { companyId: actor.activeCompanyId },
      include: { values: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async createDimension(dto: CreateSegmentDimensionDto, actor: Principal) {
    const existing = await this.dimensions.findFirst({
      where: { companyId: actor.activeCompanyId, code: dto.code },
      select: { id: true },
    });

    if (existing) {
      throw new AppError('CONFLICT', 'รหัสมิติการแบ่งกลุ่มนี้มีอยู่แล้ว', [
        { field: 'code', reason: dto.code },
      ]);
    }

    return this.audited(actor, 'crm.segment.dimension_created', (prisma) =>
      this.dimensions.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            code: dto.code,
            nameTh: dto.name_th,
            sortOrder: dto.sort_order ?? 0,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      ),
    );
  }

  async updateDimension(
    id: string,
    dto: UpdateSegmentDimensionDto,
    actor: Principal,
  ) {
    await this.requireDimension(id, actor);

    return this.audited(actor, 'crm.segment.dimension_updated', (prisma) =>
      this.dimensions.update(
        {
          where: { id },
          data: {
            nameTh: dto.name_th,
            active: dto.active,
            sortOrder: dto.sort_order,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      ),
    );
  }

  async createValue(
    dimensionId: string,
    dto: CreateSegmentValueDto,
    actor: Principal,
  ) {
    await this.requireDimension(dimensionId, actor);

    const existing = await this.values.findFirst({
      where: { dimensionId, code: dto.code },
      select: { id: true },
    });

    if (existing) {
      throw new AppError('CONFLICT', 'รหัสกลุ่มนี้มีอยู่แล้วในมิติเดียวกัน', [
        { field: 'code', reason: dto.code },
      ]);
    }

    return this.audited(actor, 'crm.segment.value_created', (prisma) =>
      this.values.create(
        {
          data: {
            dimensionId,
            code: dto.code,
            nameTh: dto.name_th,
            sortOrder: dto.sort_order ?? 0,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      ),
    );
  }

  async updateValue(id: string, dto: UpdateSegmentValueDto, actor: Principal) {
    await this.requireValue(id, actor);

    return this.audited(actor, 'crm.segment.value_updated', (prisma) =>
      this.values.update(
        {
          where: { id },
          data: {
            nameTh: dto.name_th,
            active: dto.active,
            sortOrder: dto.sort_order,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      ),
    );
  }

  /**
   * A value with customers assigned may be deactivated, never deleted —
   * Pricing (ระยะ 2) reads assignments, and deleting from under it would
   * orphan them. A genuinely unused value is configuration and may go.
   */
  async deleteValue(id: string, actor: Principal): Promise<void> {
    await this.requireValue(id, actor);

    const inUse = await this.assignments.count({
      where: { valueId: id },
    });

    if (inUse > 0) {
      throw new AppError(
        'CRM_SEGMENT_IN_USE',
        'กลุ่มนี้มีลูกค้าถูกจัดอยู่ — ปิดใช้งานแทนการลบ',
        [{ field: 'value_id', reason: `${inUse} customers` }],
      );
    }

    await this.audited(actor, 'crm.segment.value_deleted', (prisma) =>
      this.values.delete({ where: { id } }, { prisma }),
    );
  }

  // --- CRM config (CM-03 threshold, quotation defaults) ---------------------

  async getConfig(actor: Principal) {
    const saved = await this.configs.findFirst({
      where: { companyId: actor.activeCompanyId },
    });
    // CD-251 — each work type's delivery documents as they apply (saved or standard)
    const found = saved && {
      ...saved,
      deliveryDocuments: documentsByType(saved.deliveryDocuments),
    };

    // Defaults are visible before the first save, so the admin screen never
    // renders blanks that mean "whatever the code does".
    return (
      found ?? {
        companyId: actor.activeCompanyId,
        dedupThreshold: 0.85,
        minMarginPct: 15,
        quotationValidityDays: 30,
        vatPct: 7,
        quotationApprovalTypeCode: 'PRA',
        minMarginByWorkType: {},
        deliveryDocuments: documentsByType({}),
        costMaxAgeDays: 90,
        targetApprovalTypeCode: null,
        contractRequestTypeCode: null,
        liabilityApprovalRequestTypeCode: null,
        legalRiskOpinionTypeCode: null,
        contractApprovalTypeCode: null,
        projectChangeTypeCode: null,
        projectCloseTypeCode: null,
        deliveryBillingExceptionTypeCode: null,
        projectDesignTypeCode: null,
        projectTechChangeTypeCode: null,
        projectResourceTypeCode: null,
        serviceWorkOrderTypeCode: null,
        servicePortalUserId: null,
        projectHealthAmber: 20,
        projectHealthRed: 40,
        projectCostWarnPct: 90,
        projectCostAlertPct: 100,
        serviceOnCallEscalateMinutes: 30,
        serviceRepeatDays: 90,
        serviceRepeatAsset: 3,
        serviceRepeatModel: 5,
        serviceRepeatCustomerModel: 3,
        projectAsBuiltDocuments: [
          'แบบติดตั้งจริง',
          'รายการอุปกรณ์และหมายเลขเครื่อง',
          'ผังการเชื่อมต่อระบบ',
        ],
        projectSoftwareDocuments: [
          'ข้อกำหนดซอฟต์แวร์',
          'คู่มือผู้ใช้',
          'คู่มือผู้ดูแลระบบ',
          'เอกสารจุดเชื่อมต่อ (API)',
        ],
        projectReadinessChecklist: [
          'หน้างานสะอาดเรียบร้อย',
          'ติดป้ายและฉลากอุปกรณ์ครบ',
          'อบรมผู้ใช้งานแล้ว',
          'สำรองค่าตั้งค่าระบบแล้ว',
        ],
        projectCloseDocuments: ['ใบตรวจรับงาน', 'เอกสารส่งมอบงาน'],
        solutionRequestTypeCode: null,
        solutionApprovalTypeCode: null,
        demoRequestTypeCode: null,
        vendorQuoteTypeCode: null,
        presalesLaborRates: [],
        handoverOrgUnitId: null,
        customerApprovalTypes: {},
        kycReviewMonthsHigh: 12,
        kycReviewMonthsMedium: 24,
        kycReviewMonthsLow: 36,
        staleOpportunityDays: 14,
        discoveryRequired: false,
        healthNoContactDays: 60,
        ...EMPTY_LETTERHEAD,
      }
    );
  }

  async updateConfig(dto: UpdateCrmConfigDto, actor: Principal) {
    // CD-190 — the alert is never below the warning
    if (
      dto.project_cost_warn_pct !== undefined &&
      dto.project_cost_alert_pct !== undefined &&
      dto.project_cost_alert_pct < dto.project_cost_warn_pct
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เกณฑ์เกินงบต้องไม่ต่ำกว่าเกณฑ์เตือน',
        [{ field: 'project_cost_alert_pct', reason: 'below warn' }],
      );
    }
    // CD-202 — known work types only, 0–100; a blank one falls back to the
    // company minimum, so it is dropped rather than stored.
    const minMargins =
      dto.min_margin_by_work_type === undefined
        ? undefined
        : assertMinMargins(dto.min_margin_by_work_type);
    // CD-251 — the delivery documents per work type; known types only.
    let deliveryDocuments: Prisma.InputJsonValue | undefined;
    if (dto.delivery_documents !== undefined) {
      const { value, problems } = cleanDocumentsSetting(dto.delivery_documents);
      if (problems.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          problems[0],
          problems.map((reason) => ({ field: 'delivery_documents', reason })),
        );
      }
      deliveryDocuments = value;
    }
    // CD-62 — checked before anything is written; `undefined` = untouched.
    // CD-136 — the labour rate table, blank roles dropped, one row a role.
    const laborRates =
      dto.presales_labor_rates === undefined
        ? undefined
        : [
            ...new Map(
              dto.presales_labor_rates
                .filter((rate) => rate.role.trim())
                .map((rate) => [
                  rate.role.trim(),
                  { role: rate.role.trim(), rate: rate.rate },
                ]),
            ).values(),
          ];
    // CD-226 — blank names dropped, each name once
    const asBuiltDocuments =
      dto.project_as_built_documents === undefined
        ? undefined
        : [
            ...new Set(
              dto.project_as_built_documents
                .map((title) => title.trim())
                .filter(Boolean),
            ),
          ];
    // CD-215 — blank names dropped, each name once
    const softwareDocuments =
      dto.project_software_documents === undefined
        ? undefined
        : [
            ...new Set(
              dto.project_software_documents
                .map((title) => title.trim())
                .filter(Boolean),
            ),
          ];
    // CD-225 — blank lines dropped, each line once
    const readinessChecklist =
      dto.project_readiness_checklist === undefined
        ? undefined
        : [
            ...new Set(
              dto.project_readiness_checklist
                .map((line) => line.trim())
                .filter(Boolean),
            ),
          ];
    // CD-191 — blank names dropped, each name once
    const closeDocuments =
      dto.project_close_documents === undefined
        ? undefined
        : [
            ...new Set(
              dto.project_close_documents
                .map((title) => title.trim())
                .filter(Boolean),
            ),
          ];
    const approvalTypes =
      dto.customer_approval_types === undefined
        ? undefined
        : await this.approval.assertUsableTypes(
            actor.activeCompanyId,
            dto.customer_approval_types,
          );
    return this.audited(
      actor,
      'crm.config.updated',
      (prisma) =>
        this.configs.upsert(
          {
            where: { companyId: actor.activeCompanyId },
            create: {
              companyId: actor.activeCompanyId,
              dedupThreshold: dto.dedup_threshold ?? 0.85,
              minMarginPct: dto.min_margin_pct ?? 15,
              quotationValidityDays: dto.quotation_validity_days ?? 30,
              vatPct: dto.vat_pct ?? 7,
              quotationApprovalTypeCode:
                dto.quotation_approval_type_code ?? 'PRA',
              minMarginByWorkType: minMargins ?? {},
              deliveryDocuments: deliveryDocuments ?? {},
              costMaxAgeDays: dto.cost_max_age_days ?? 90,
              targetApprovalTypeCode: dto.target_approval_type_code || null,
              contractRequestTypeCode: dto.contract_request_type_code || null,
              liabilityApprovalRequestTypeCode:
                dto.liability_approval_request_type_code || null,
              legalRiskOpinionTypeCode:
                dto.legal_risk_opinion_type_code || null,
              contractApprovalTypeCode: dto.contract_approval_type_code || null,
              projectChangeTypeCode: dto.project_change_type_code || null,
              projectCloseTypeCode: dto.project_close_type_code || null,
              deliveryBillingExceptionTypeCode:
                dto.delivery_billing_exception_type_code || null,
              projectDesignTypeCode: dto.project_design_type_code || null,
              projectTechChangeTypeCode:
                dto.project_tech_change_type_code || null,
              projectResourceTypeCode: dto.project_resource_type_code || null,
              serviceWorkOrderTypeCode:
                dto.service_work_order_type_code || null,
              servicePortalUserId: dto.service_portal_user_id || null,
              projectHealthAmber: dto.project_health_amber ?? 20,
              projectHealthRed: dto.project_health_red ?? 40,
              projectCostWarnPct: dto.project_cost_warn_pct ?? 90,
              projectCostAlertPct: dto.project_cost_alert_pct ?? 100,
              serviceOnCallEscalateMinutes:
                dto.service_on_call_escalate_minutes ?? 30,
              serviceRepeatDays: dto.service_repeat_days ?? 90,
              serviceRepeatAsset: dto.service_repeat_asset ?? 3,
              serviceRepeatModel: dto.service_repeat_model ?? 5,
              serviceRepeatCustomerModel:
                dto.service_repeat_customer_model ?? 3,
              ...(asBuiltDocuments
                ? { projectAsBuiltDocuments: asBuiltDocuments }
                : {}),
              ...(softwareDocuments
                ? { projectSoftwareDocuments: softwareDocuments }
                : {}),
              ...(readinessChecklist
                ? { projectReadinessChecklist: readinessChecklist }
                : {}),
              ...(closeDocuments
                ? { projectCloseDocuments: closeDocuments }
                : {}),
              solutionRequestTypeCode: dto.solution_request_type_code || null,
              solutionApprovalTypeCode: dto.solution_approval_type_code || null,
              demoRequestTypeCode: dto.demo_request_type_code || null,
              vendorQuoteTypeCode: dto.vendor_quote_type_code || null,
              presalesLaborRates: laborRates ?? [],
              handoverOrgUnitId: dto.handover_org_unit_id || null,
              customerApprovalTypes: approvalTypes ?? {},
              kycReviewMonthsHigh: dto.kyc_review_months_high ?? 12,
              kycReviewMonthsMedium: dto.kyc_review_months_medium ?? 24,
              kycReviewMonthsLow: dto.kyc_review_months_low ?? 36,
              discoveryRequired: dto.discovery_required ?? false,
              healthNoContactDays: dto.health_no_contact_days ?? 60,
              ...letterheadColumns(dto),
              updatedBy: actor.userId,
            },
            update: {
              dedupThreshold: dto.dedup_threshold,
              minMarginPct: dto.min_margin_pct,
              quotationValidityDays: dto.quotation_validity_days,
              vatPct: dto.vat_pct,
              quotationApprovalTypeCode: dto.quotation_approval_type_code,
              minMarginByWorkType: minMargins,
              deliveryDocuments,
              costMaxAgeDays: dto.cost_max_age_days,
              targetApprovalTypeCode:
                dto.target_approval_type_code === undefined
                  ? undefined
                  : dto.target_approval_type_code || null,
              contractRequestTypeCode:
                dto.contract_request_type_code === undefined
                  ? undefined
                  : dto.contract_request_type_code || null,
              liabilityApprovalRequestTypeCode:
                dto.liability_approval_request_type_code === undefined
                  ? undefined
                  : dto.liability_approval_request_type_code || null,
              legalRiskOpinionTypeCode:
                dto.legal_risk_opinion_type_code === undefined
                  ? undefined
                  : dto.legal_risk_opinion_type_code || null,
              contractApprovalTypeCode:
                dto.contract_approval_type_code === undefined
                  ? undefined
                  : dto.contract_approval_type_code || null,
              projectChangeTypeCode:
                dto.project_change_type_code === undefined
                  ? undefined
                  : dto.project_change_type_code || null,
              projectCloseTypeCode:
                dto.project_close_type_code === undefined
                  ? undefined
                  : dto.project_close_type_code || null,
              deliveryBillingExceptionTypeCode:
                dto.delivery_billing_exception_type_code === undefined
                  ? undefined
                  : dto.delivery_billing_exception_type_code || null,
              projectDesignTypeCode:
                dto.project_design_type_code === undefined
                  ? undefined
                  : dto.project_design_type_code || null,
              projectTechChangeTypeCode:
                dto.project_tech_change_type_code === undefined
                  ? undefined
                  : dto.project_tech_change_type_code || null,
              projectResourceTypeCode:
                dto.project_resource_type_code === undefined
                  ? undefined
                  : dto.project_resource_type_code || null,
              serviceWorkOrderTypeCode:
                dto.service_work_order_type_code === undefined
                  ? undefined
                  : dto.service_work_order_type_code || null,
              servicePortalUserId:
                dto.service_portal_user_id === undefined
                  ? undefined
                  : dto.service_portal_user_id || null,
              projectCloseDocuments: closeDocuments,
              projectHealthAmber: dto.project_health_amber,
              projectHealthRed: dto.project_health_red,
              projectCostWarnPct: dto.project_cost_warn_pct,
              projectCostAlertPct: dto.project_cost_alert_pct,
              serviceOnCallEscalateMinutes:
                dto.service_on_call_escalate_minutes,
              serviceRepeatDays: dto.service_repeat_days,
              serviceRepeatAsset: dto.service_repeat_asset,
              serviceRepeatModel: dto.service_repeat_model,
              serviceRepeatCustomerModel: dto.service_repeat_customer_model,
              projectReadinessChecklist: readinessChecklist,
              projectAsBuiltDocuments: asBuiltDocuments,
              projectSoftwareDocuments: softwareDocuments,
              solutionRequestTypeCode:
                dto.solution_request_type_code === undefined
                  ? undefined
                  : dto.solution_request_type_code || null,
              solutionApprovalTypeCode:
                dto.solution_approval_type_code === undefined
                  ? undefined
                  : dto.solution_approval_type_code || null,
              demoRequestTypeCode:
                dto.demo_request_type_code === undefined
                  ? undefined
                  : dto.demo_request_type_code || null,
              vendorQuoteTypeCode:
                dto.vendor_quote_type_code === undefined
                  ? undefined
                  : dto.vendor_quote_type_code || null,
              presalesLaborRates: laborRates,
              handoverOrgUnitId:
                dto.handover_org_unit_id === undefined
                  ? undefined
                  : dto.handover_org_unit_id || null,
              customerApprovalTypes: approvalTypes,
              kycReviewMonthsHigh: dto.kyc_review_months_high,
              kycReviewMonthsMedium: dto.kyc_review_months_medium,
              kycReviewMonthsLow: dto.kyc_review_months_low,
              discoveryRequired: dto.discovery_required,
              healthNoContactDays: dto.health_no_contact_days,
              ...letterheadColumns(dto),
              updatedBy: actor.userId,
            },
          },
          { prisma },
        ),
      // The logo is a data URL of up to ~375KB — the append-only audit log
      // records that it changed, not a copy of the image on every save.
      (config) => ({
        ...config,
        letterheadLogo: (config as { letterheadLogo?: string | null })
          .letterheadLogo
          ? '[logo]'
          : null,
      }),
    );
  }

  // --- helpers -------------------------------------------------------------

  /** SCOPE-03: a dimension of another company answers 404. */
  private async requireDimension(id: string, actor: Principal) {
    const found = await this.dimensions.findFirst({
      where: { id, companyId: actor.activeCompanyId },
      select: { id: true },
    });

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบมิติการแบ่งกลุ่มที่ระบุ');
  }

  private async requireValue(id: string, actor: Principal) {
    const found = await this.values.findFirst({
      where: { id, dimension: { companyId: actor.activeCompanyId } },
      select: { id: true },
    });

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบกลุ่มที่ระบุ');
  }

  /** Wraps a config write with its audit entry in one transaction. */
  private audited<T extends { id?: string }>(
    actor: Principal,
    eventType: string,
    work: (prisma: TQueryClient) => Promise<T>,
    /** What goes in `after` — defaults to the whole result. */
    describe: (result: T) => unknown = (result) => result,
  ): Promise<T> {
    return this.transactions.execute(async (prisma) => {
      const result = await work(prisma);

      await this.audit.record(
        {
          eventType,
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'crm_config',
          resourceId: typeof result?.id === 'string' ? result.id : undefined,
          after: describe(result) as Prisma.InputJsonValue,
        },
        { prisma },
      );

      return result;
    });
  }

  // --- CM-04 ชุดงาน B: product ที่ต้องยืนยันตัวตน (KYC) --------------------

  /** ทั้งชุดรวม inactive — หน้า admin สลับเปิด/ปิดได้โดยไม่ลบประวัติ. */
  async listKycProducts(actor: Principal) {
    return this.kycProducts.findMany({
      where: { companyId: actor.activeCompanyId },
      orderBy: { productCode: 'asc' },
    });
  }

  async createKycProduct(dto: CreateKycProductDto, actor: Principal) {
    // CD-27: เงื่อนไข KYC ผูกกับรหัสที่ SAP รู้จัก — รหัสสะกดผิดจะไม่มีวันตรงกับ
    // product บนโอกาสการขาย/ใบเสนอราคา และการเตือนจะเงียบไป
    await this.catalog.assertCodes(actor.activeCompanyId, [
      { code: dto.product_code, field: 'product_code' },
    ]);

    const clash = (await this.kycProducts.findFirst({
      where: {
        companyId: actor.activeCompanyId,
        productCode: dto.product_code.trim(),
      },
      select: { id: true },
    })) as { id: string } | null;

    if (clash) {
      throw new AppError(
        'CONFLICT',
        'รหัส product นี้อยู่ในเงื่อนไข KYC แล้ว',
        [{ field: 'product_code', reason: 'duplicate' }],
      );
    }

    const row = await this.kycProducts.create({
      data: {
        companyId: actor.activeCompanyId,
        productCode: dto.product_code.trim(),
        name: dto.name.trim(),
        createdBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.kyc_product.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'kyc_product_rule',
      resourceId: (row as { id: string }).id,
      after: { productCode: dto.product_code, name: dto.name },
    });

    return row;
  }

  async updateKycProduct(
    id: string,
    dto: UpdateKycProductDto,
    actor: Principal,
  ) {
    const found = (await this.kycProducts.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as { id: string; name: string; active: boolean } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบรายการที่ระบุ');

    const row = await this.kycProducts.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.kyc_product.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'kyc_product_rule',
      resourceId: id,
      before: { name: found.name, active: found.active },
      after: {
        name: dto.name ?? found.name,
        active: dto.active ?? found.active,
      },
    });

    return row;
  }
}

const EMPTY_LETTERHEAD = {
  letterheadNameTh: null,
  letterheadNameEn: null,
  letterheadTaxId: null,
  letterheadBranch: null,
  letterheadAddress: null,
  letterheadPhone: null,
  letterheadEmail: null,
  letterheadWebsite: null,
  letterheadLogo: null,
  quotationTerms: null,
};

/**
 * หัวกระดาษ — ไม่ส่ง = ไม่แตะ, "" = ล้างเป็น NULL (หน้าจอจึงลบค่าที่เคยตั้งได้),
 * อย่างอื่น trim แล้วเก็บ.
 */
function letterheadColumns(dto: UpdateCrmConfigDto) {
  const pick = (value: string | undefined) =>
    value === undefined ? undefined : value.trim() || null;

  return {
    letterheadNameTh: pick(dto.letterhead_name_th),
    letterheadNameEn: pick(dto.letterhead_name_en),
    letterheadTaxId: pick(dto.letterhead_tax_id),
    letterheadBranch: pick(dto.letterhead_branch),
    letterheadAddress: pick(dto.letterhead_address),
    letterheadPhone: pick(dto.letterhead_phone),
    letterheadEmail: pick(dto.letterhead_email),
    letterheadWebsite: pick(dto.letterhead_website),
    letterheadLogo: pick(dto.letterhead_logo),
    quotationTerms: pick(dto.quotation_terms),
  };
}

/** CD-202 — a work type the quotation does not know, or a % outside 0–100, is refused. */
function assertMinMargins(value: Record<string, unknown>) {
  const details = Object.entries(value)
    .filter(([key, raw]) => {
      if (!(WORK_TYPES as readonly string[]).includes(key)) return true;
      if (raw === null || raw === '') return false;
      const pct = Number(raw);
      return !Number.isFinite(pct) || pct < 0 || pct > 100;
    })
    .map(([key]) => ({
      field: `min_margin_by_work_type.${key}`,
      reason: 'invalid',
    }));
  if (details.length) {
    throw new AppError(
      'VALIDATION_FAILED',
      'margin ขั้นต่ำตามประเภทงานต้องเป็นประเภทที่รู้จัก และอยู่ระหว่าง 0–100',
      details,
    );
  }
  return cleanMinMargins(value);
}
