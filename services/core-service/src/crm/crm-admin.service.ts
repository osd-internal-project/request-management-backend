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

  // --- CRM config (CM-02 code shape, CM-03 threshold) ----------------------

  async getConfig(actor: Principal) {
    const found = await this.configs.findFirst({
      where: { companyId: actor.activeCompanyId },
    });

    // Defaults are visible before the first save, so the admin screen never
    // renders blanks that mean "whatever the code does".
    return (
      found ?? {
        companyId: actor.activeCompanyId,
        codePrefix: 'CUS',
        codePadding: 6,
        dedupThreshold: 0.85,
      }
    );
  }

  async updateConfig(dto: UpdateCrmConfigDto, actor: Principal) {
    return this.audited(actor, 'crm.config.updated', (prisma) =>
      this.configs.upsert(
        {
          where: { companyId: actor.activeCompanyId },
          create: {
            companyId: actor.activeCompanyId,
            codePrefix: dto.code_prefix ?? 'CUS',
            codePadding: dto.code_padding ?? 6,
            dedupThreshold: dto.dedup_threshold ?? 0.85,
            updatedBy: actor.userId,
          },
          update: {
            codePrefix: dto.code_prefix,
            codePadding: dto.code_padding,
            dedupThreshold: dto.dedup_threshold,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      ),
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
          after: result,
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
    const clash = (await this.kycProducts.findFirst({
      where: {
        companyId: actor.activeCompanyId,
        productCode: dto.product_code.trim(),
      },
      select: { id: true },
    })) as { id: string } | null;

    if (clash) {
      throw new AppError('CONFLICT', 'รหัส product นี้อยู่ในเงื่อนไข KYC แล้ว', [
        { field: 'product_code', reason: 'duplicate' },
      ]);
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
      after: { name: dto.name ?? found.name, active: dto.active ?? found.active },
    });

    return row;
  }
}
