import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { thaiToday } from '../crm/vendor-costs';
import {
  HrLaborRateRepository,
  HrLevelRepository,
  HrWorkTypeRepository,
} from './hr.repositories';
import { AddLaborRateDto, SaveHrItemDto } from './hr.dto';
import { dayBefore, laborLabel, rateOn } from './hr-rates';

export interface HrItem {
  id: string;
  code: string;
  name: string;
  sortOrder: number;
  active: boolean;
}

interface StoredRate {
  id: string;
  levelId: string;
  workTypeId: string;
  costPerManday: Prisma.Decimal;
  sellPerManday: Prisma.Decimal | null;
  validFrom: Date;
  validTo: Date | null;
  note: string;
  createdBy: string;
  createdAt: Date;
}

/** One labour rate as a Solution's estimate takes it. */
export interface EffectiveRate {
  levelCode: string;
  workTypeCode: string;
  label: string;
  rate: number;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);

/**
 * CD-207 — ต้นทุนบุคลากร (the cost-rate part of CD-17 HR): levels, work types
 * and the cost per manday of each pair, with the date it takes effect. The
 * one source of labour cost — a Solution's estimate (CD-136) copies the rate
 * in effect when a line is entered, and nothing else keeps its own table.
 *
 * A new rate for a pair closes the open one the day before it starts, so the
 * history stays and a past estimate can be explained. Only a rate not yet in
 * effect may be withdrawn (the one before it reopens).
 *
 * Rates are read with `hr.rate.read`, kept with `hr.rate.manage`; the level
 * and work-type names alone (the pickers) are open to Pre-Sales.
 */
@Injectable()
export class HrRatesService {
  constructor(
    private readonly levels: HrLevelRepository,
    private readonly workTypes: HrWorkTypeRepository,
    private readonly rates: HrLaborRateRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The pickers: active levels and work types, no money. */
  async options(companyId: string) {
    const [levels, workTypes] = await Promise.all([
      this.itemsOf(this.levels, companyId, true),
      this.itemsOf(this.workTypes, companyId, true),
    ]);
    return {
      levels: levels.map(({ code, name }) => ({ code, name })),
      work_types: workTypes.map(({ code, name }) => ({ code, name })),
    };
  }

  /** The register: every level, work type and rate, current marked. */
  async list(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [levels, workTypes, rates] = await Promise.all([
      this.itemsOf(this.levels, companyId, false),
      this.itemsOf(this.workTypes, companyId, false),
      this.rates.findMany({
        where: { companyId, deletedAt: null },
        orderBy: [{ validFrom: 'desc' }],
      }) as Promise<StoredRate[]>,
    ]);
    const today = thaiToday();
    const plain = rates.map((rate) => ({
      ...rate,
      validFrom: day(rate.validFrom),
      validTo: rate.validTo ? day(rate.validTo) : null,
    }));
    return {
      today,
      levels,
      work_types: workTypes,
      rates: plain.map((rate) => ({
        id: rate.id,
        levelId: rate.levelId,
        workTypeId: rate.workTypeId,
        costPerManday: Number(rate.costPerManday),
        sellPerManday:
          rate.sellPerManday === null ? null : Number(rate.sellPerManday),
        validFrom: rate.validFrom,
        validTo: rate.validTo,
        note: rate.note,
        current:
          rateOn(plain, rate.levelId, rate.workTypeId, today)?.id === rate.id,
        upcoming: rate.validFrom > today,
      })),
    };
  }

  /** Every pair's rate in effect on `on` (default today), by code. */
  async effectiveRates(
    companyId: string,
    on: string = thaiToday(),
  ): Promise<EffectiveRate[]> {
    const [levels, workTypes, rates] = await Promise.all([
      this.itemsOf(this.levels, companyId, true),
      this.itemsOf(this.workTypes, companyId, true),
      this.rates.findMany({
        where: { companyId, deletedAt: null },
      }) as Promise<StoredRate[]>,
    ]);
    const plain = rates.map((rate) => ({
      ...rate,
      validFrom: day(rate.validFrom),
      validTo: rate.validTo ? day(rate.validTo) : null,
    }));
    return levels.flatMap((level) =>
      workTypes.flatMap((workType) => {
        const rate = rateOn(plain, level.id, workType.id, on);
        return rate
          ? [
              {
                levelCode: level.code,
                workTypeCode: workType.code,
                label: laborLabel(level, workType),
                rate: Number(rate.costPerManday),
              },
            ]
          : [];
      }),
    );
  }

  saveLevel(actor: Principal, id: string | null, dto: SaveHrItemDto) {
    return this.saveItem(this.levels, 'level', actor, id, dto);
  }

  saveWorkType(actor: Principal, id: string | null, dto: SaveHrItemDto) {
    return this.saveItem(this.workTypes, 'work_type', actor, id, dto);
  }

  async addRate(actor: Principal, dto: AddLaborRateDto) {
    const companyId = actor.activeCompanyId;
    const [level, workType] = await Promise.all([
      this.levels.findFirst({ where: { id: dto.level_id, companyId } }),
      this.workTypes.findFirst({ where: { id: dto.work_type_id, companyId } }),
    ]);
    if (!level || !workType) {
      throw new AppError('NOT_FOUND', 'ไม่พบระดับหรือประเภทงานที่ระบุ');
    }
    await this.transactions.execute(async (prisma) => {
      const latest = (await prisma.hrLaborRate.findFirst({
        where: {
          companyId,
          levelId: dto.level_id,
          workTypeId: dto.work_type_id,
          deletedAt: null,
        },
        orderBy: { validFrom: 'desc' },
      })) as StoredRate | null;
      if (latest && day(latest.validFrom) >= dto.valid_from) {
        throw new AppError(
          'VALIDATION_FAILED',
          `อัตราใหม่ต้องเริ่มหลังอัตราล่าสุด (${day(latest.validFrom)}) — อัตราที่มีผลแล้วแก้ย้อนหลังไม่ได้`,
          [{ field: 'valid_from', reason: 'not_after_latest' }],
        );
      }
      if (
        latest &&
        (!latest.validTo || day(latest.validTo) >= dto.valid_from)
      ) {
        await prisma.hrLaborRate.update({
          where: { id: latest.id },
          data: { validTo: date(dayBefore(dto.valid_from)) },
        });
      }
      const created = await prisma.hrLaborRate.create({
        data: {
          companyId,
          levelId: dto.level_id,
          workTypeId: dto.work_type_id,
          costPerManday: dto.cost_per_manday,
          sellPerManday: dto.sell_per_manday ?? null,
          validFrom: date(dto.valid_from),
          note: dto.note?.trim() ?? '',
          createdBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'hr.labor_rate.added',
          companyId,
          ...auditActor(actor),
          resourceType: 'hr_labor_rate',
          resourceId: created.id,
          after: {
            level: (level as HrItem).code,
            workType: (workType as HrItem).code,
            validFrom: dto.valid_from,
            closedPrevious: latest?.id ?? null,
          },
        },
        { prisma },
      );
    });
    return this.list(actor);
  }

  /** Only a rate not yet in effect; the one before it runs on again. */
  async withdrawRate(actor: Principal, id: string) {
    const companyId = actor.activeCompanyId;
    const rate = (await this.rates.findFirst({
      where: { id, companyId, deletedAt: null },
    })) as StoredRate | null;
    if (!rate) throw new AppError('NOT_FOUND', 'ไม่พบอัตราที่ระบุ');
    if (day(rate.validFrom) <= thaiToday()) {
      throw new AppError(
        'CONFLICT',
        'อัตราที่มีผลแล้วถอนไม่ได้ — เพิ่มอัตราใหม่ที่เริ่มวันถัดไปแทน',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.hrLaborRate.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      const before = (await prisma.hrLaborRate.findFirst({
        where: {
          companyId,
          levelId: rate.levelId,
          workTypeId: rate.workTypeId,
          deletedAt: null,
          validFrom: { lt: rate.validFrom },
        },
        orderBy: { validFrom: 'desc' },
      })) as StoredRate | null;
      if (
        before &&
        before.validTo &&
        day(before.validTo) === dayBefore(day(rate.validFrom))
      ) {
        await prisma.hrLaborRate.update({
          where: { id: before.id },
          data: { validTo: null },
        });
      }
      await this.audit.record(
        {
          eventType: 'hr.labor_rate.withdrawn',
          companyId,
          ...auditActor(actor),
          resourceType: 'hr_labor_rate',
          resourceId: id,
          before: { validFrom: day(rate.validFrom) },
        },
        { prisma },
      );
    });
    return this.list(actor);
  }

  // --- helpers ---------------------------------------------------------------

  private async itemsOf(
    repo: HrLevelRepository | HrWorkTypeRepository,
    companyId: string,
    activeOnly: boolean,
  ): Promise<HrItem[]> {
    return await (repo as HrLevelRepository).findMany({
      where: { companyId, ...(activeOnly ? { active: true } : {}) },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  private async saveItem(
    repo: HrLevelRepository | HrWorkTypeRepository,
    kind: 'level' | 'work_type',
    actor: Principal,
    id: string | null,
    dto: SaveHrItemDto,
  ) {
    const companyId = actor.activeCompanyId;
    const delegate = repo as HrLevelRepository;
    if (id) {
      const found = (await delegate.findFirst({
        where: { id, companyId },
      })) as HrItem | null;
      if (!found) throw new AppError('NOT_FOUND', 'ไม่พบรายการที่ระบุ');
      await delegate.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.sort_order !== undefined
            ? { sortOrder: dto.sort_order }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
    } else {
      const code = dto.code?.trim();
      const name = dto.name?.trim();
      if (!code || !name) {
        throw new AppError('VALIDATION_FAILED', 'ต้องระบุรหัสและชื่อ', [
          { field: code ? 'name' : 'code', reason: 'required' },
        ]);
      }
      const taken = await delegate.findFirst({ where: { companyId, code } });
      if (taken) {
        throw new AppError('CONFLICT', `รหัส ${code} มีอยู่แล้ว`, [
          { field: 'code', reason: 'taken' },
        ]);
      }
      await delegate.create({
        data: {
          companyId,
          code,
          name,
          sortOrder: dto.sort_order ?? 0,
          active: dto.active ?? true,
        },
      });
    }
    await this.audit.record({
      eventType: `hr.${kind}.saved`,
      companyId,
      ...auditActor(actor),
      resourceType: `hr_${kind}`,
      resourceId: id ?? dto.code ?? '',
      after: { ...dto },
    });
    return this.list(actor);
  }
}
