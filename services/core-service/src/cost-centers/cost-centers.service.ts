import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  PrismaTransactionService,
  auditActor,
} from '@request-management/share';
import type { Principal, TxOption } from '@request-management/share';
import type { CostCenter, Prisma } from '@prisma/client';
import { FormOptionSources } from '../requests/form-option-sources';
import { CostCenterRepository } from './cost-center.repository';
import type {
  CreateCostCenterDto,
  ListCostCentersQueryDto,
  UpdateCostCenterDto,
} from './cost-centers.dto';

/** The `x-options-source` name forms use to pick from this list. */
export const COST_CENTER_SOURCE = 'cost_centers';

/** Cost Center master: forms pick from it, nothing is deleted (old disbursements still name it). */
@Injectable()
export class CostCentersService implements OnModuleInit {
  constructor(
    private readonly costCenters: CostCenterRepository,
    private readonly optionSources: FormOptionSources,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    this.optionSources.register({
      name: COST_CENTER_SOURCE,
      label: 'รายการ Cost Center',
      unknownValues: (companyId, values) => this.unknownCodes(companyId, values),
    });
  }

  list(actor: Principal, query: ListCostCentersQueryDto) {
    const search = query.search?.trim();
    return this.costCenters.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.include_inactive ? {} : { active: true }),
        ...(search
          ? {
              OR: [
                { code: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { code: 'asc' },
      take: 500,
    });
  }

  async create(actor: Principal, dto: CreateCostCenterDto) {
    const companyId = actor.activeCompanyId;
    const code = dto.code.trim();
    const taken = await this.costCenters.findFirst({ where: { companyId, code } });
    if (taken) {
      throw new AppError('CONFLICT', `มี Cost Center รหัส ${code} อยู่แล้ว`, [
        { field: 'code', reason: code },
      ]);
    }
    return this.transactions.execute(async (prisma) => {
      const row = await this.costCenters.create(
        {
          data: {
            companyId,
            code,
            name: dto.name.trim(),
            orgUnitId: dto.org_unit_id ?? null,
            createdBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(actor, 'cost_center.created', row, null, { prisma });
      return row;
    });
  }

  async update(actor: Principal, id: string, dto: UpdateCostCenterDto) {
    const before = await this.costCenters.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    });
    if (!before) throw new AppError('NOT_FOUND', 'ไม่พบ Cost Center ที่ระบุ');
    return this.transactions.execute(async (prisma) => {
      const row = await this.costCenters.update(
        {
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.org_unit_id !== undefined ? { orgUnitId: dto.org_unit_id } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(actor, 'cost_center.updated', row, before, { prisma });
      return row;
    });
  }

  /** `"2002"` or `"2002 - การตลาด"` → whatever is not an active code of this company. */
  async unknownCodes(companyId: string, values: readonly string[]): Promise<string[]> {
    const codeOf = (value: string) => value.split(' - ')[0].trim();
    const found = await this.costCenters.findMany({
      where: { companyId, active: true, code: { in: values.map(codeOf) } },
      select: { code: true },
    });
    const known = new Set(found.map((row) => row.code));
    return values.filter((value) => !known.has(codeOf(value)));
  }

  private record(
    actor: Principal,
    eventType: string,
    row: CostCenter,
    before: CostCenter | null,
    option: TxOption,
  ) {
    const view = (r: CostCenter) => ({ code: r.code, name: r.name, orgUnitId: r.orgUnitId, active: r.active });
    return this.audit.record(
      {
        eventType,
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'cost_center',
        resourceId: row.id,
        ...(before ? { before: view(before) as Prisma.InputJsonValue } : {}),
        after: view(row) as Prisma.InputJsonValue,
      },
      option,
    );
  }
}
