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
import { ProductCatalogService } from '../crm/product-catalog.service';
import { ProductRepository } from '../crm/product.repositories';
import { VendorCostService } from '../crm/vendor-cost.service';
import { thaiToday } from '../crm/vendor-costs';
import { LaborCostService } from '../hr/labor-cost.service';
import { TimesheetsService } from '../hr/timesheets.service';
import { PricesService } from '../pricing/prices.service';
import { RequestRepository } from '../requests/request.repository';
import {
  AddMaterialUseDto,
  SaveLabourRateDto,
  UpdateMaterialUseDto,
} from './support.dto';
import {
  ServiceBillingRepository,
  ServiceLabourRateRepository,
  ServiceMaterialUseRepository,
  ServiceWorkOrderRepository,
  ServiceWorkTypeRepository,
} from './support.repositories';
import {
  jobMargin,
  labourLines,
  materialCost,
  materialLines,
  timeTotals,
  type ChargeLine,
  type LabourRate,
  type MaterialUse,
} from './time-material-rules';

interface OrderRow {
  id: string;
  companyId: string;
  requestId: string;
  billing: string | null;
}

interface MaterialRow {
  id: string;
  productCode: string;
  description: string;
  quantity: Prisma.Decimal;
  unit: string | null;
  serialNo: string | null;
  billable: boolean;
  unitPrice: Prisma.Decimal | null;
  priceSource: string | null;
  unitCost: Prisma.Decimal | null;
  usedOn: Date;
  note: string | null;
  createdBy: string;
  createdAt: Date;
}

interface RateRow {
  id: string;
  workTypeId: string;
  hourlyRate: Prisma.Decimal;
  productCode: string | null;
  note: string | null;
}

const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);
const day = (value: Date) => value.toISOString().slice(0, 10);
const isDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
/** Labour cost is pay-derived (CD-207/234): only `hr.rate.read` sees it. */
const COST_PERMISSION = 'hr.rate.read';

/**
 * CD-243 บันทึกเวลาและวัสดุงานบริการ — a service job's actual time and
 * materials. Time is the timesheet's (CD-231, logged against the case): one
 * place, never typed twice; only approved, billable hours are charged.
 * Materials are SAP items (CD-27) recorded on the job — selling price from
 * the standard price list (CD-194), cost from suppliers' SAP costs (CD-206).
 * Both become charge lines for the job's billing (CD-242) at the service
 * team's selling rate per work type, and its cost and margin are shown to
 * those who may see labour cost.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` — or whoever works
 * the case — records materials; `service.asset.manage` sets the rates.
 */
@Injectable()
export class TimeMaterialsService {
  constructor(
    private readonly orders: ServiceWorkOrderRepository,
    private readonly materials: ServiceMaterialUseRepository,
    private readonly rates: ServiceLabourRateRepository,
    private readonly workTypes: ServiceWorkTypeRepository,
    private readonly billings: ServiceBillingRepository,
    private readonly requestRows: RequestRepository,
    private readonly products: ProductRepository,
    private readonly catalog: ProductCatalogService,
    private readonly prices: PricesService,
    private readonly vendorCosts: VendorCostService,
    private readonly timesheets: TimesheetsService,
    private readonly laborCost: LaborCostService,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The job's time, materials, what they would charge, and (if allowed) its margin. */
  async ofWorkOrder(actor: Principal, workOrderId: string) {
    const order = await this.requireOrder(actor.activeCompanyId, workOrderId);
    const companyId = order.companyId;
    const [time, materialRows, rateRows, typeNames, request, billing] =
      await Promise.all([
        this.timesheets.serviceTime(companyId, [order.requestId]),
        this.materialRows(workOrderId),
        this.rateRows(companyId),
        this.typeNames(companyId),
        this.requestRows.findFirst({
          where: { id: order.requestId },
          select: { assigneeUserId: true },
        }) as Promise<{ assigneeUserId: string | null } | null>,
        this.billings.findFirst({
          where: { workOrderId, status: { not: 'cancelled' } },
          select: { status: true, netTotal: true },
        }) as Promise<{ status: string; netTotal: Prisma.Decimal } | null>,
      ]);
    const names = await this.names([
      ...time.map((row) => row.userId),
      ...materialRows.map((row) => row.createdBy),
    ]);
    const typeName = (id: string) => typeNames.get(id) ?? id;
    const uses = materialRows.map(materialUse);
    const labour = labourLines(time, rateRows.map(rate), typeName);
    const material = materialLines(uses);
    const seesCost = actor.permissions.includes(COST_PERMISSION);

    // per person and work type, approved and pending apart
    const byPerson = new Map<
      string,
      {
        name: string;
        workType: string;
        approved: number;
        pending: number;
        billable: boolean;
      }
    >();
    for (const row of time) {
      const key = `${row.userId}|${row.workTypeId}|${row.billable}`;
      const entry = byPerson.get(key) ?? {
        name: names.get(row.userId) ?? row.userId,
        workType: typeName(row.workTypeId),
        approved: 0,
        pending: 0,
        billable: row.billable,
      };
      if (row.approved) entry.approved += row.hours;
      else entry.pending += row.hours;
      byPerson.set(key, entry);
    }

    let costs: Record<string, unknown> | null = null;
    if (seesCost) {
      const labourCost = (
        await this.laborCost.forRequests(companyId, [order.requestId])
      ).get(order.requestId);
      const materialsCost = materialCost(uses);
      const revenue = billing ? Number(billing.netTotal) : 0;
      costs = {
        revenue,
        labour: {
          cost: labourCost?.cost ?? 0,
          unpricedHours: labourCost?.unpricedHours ?? 0,
        },
        materials: materialsCost,
        ...jobMargin({
          revenue,
          labourCost: labourCost?.cost ?? 0,
          materialCost: materialsCost.cost,
        }),
      };
    }

    return {
      workOrderId,
      billing: order.billing,
      locked: billing?.status === 'confirmed',
      canEdit:
        actor.permissions.includes('service.asset.manage') ||
        request?.assigneeUserId === actor.userId,
      time: {
        ...timeTotals(time),
        people: [...byPerson.values()],
      },
      materials: materialRows.map((row) => ({
        id: row.id,
        productCode: row.productCode,
        description: row.description,
        quantity: Number(row.quantity),
        unit: row.unit,
        serialNo: row.serialNo,
        billable: row.billable,
        unitPrice: num(row.unitPrice),
        priceSource: row.priceSource,
        unitCost: seesCost ? num(row.unitCost) : null,
        usedOn: day(row.usedOn),
        note: row.note,
        createdByName: names.get(row.createdBy) ?? row.createdBy,
      })),
      charge: {
        lines: [...labour.lines, ...material.lines],
        unratedWorkTypes: labour.unrated,
        unpricedMaterials: material.unpriced,
      },
      costs,
    };
  }

  /** Charge lines from the job's time and materials, for its billing (CD-242). */
  async chargeLines(
    companyId: string,
    workOrderId: string,
  ): Promise<ChargeLine[]> {
    const order = await this.requireOrder(companyId, workOrderId);
    const [time, materialRows, rateRows, typeNames] = await Promise.all([
      this.timesheets.serviceTime(companyId, [order.requestId]),
      this.materialRows(workOrderId),
      this.rateRows(companyId),
      this.typeNames(companyId),
    ]);
    const typeName = (id: string) => typeNames.get(id) ?? id;
    return [
      ...labourLines(time, rateRows.map(rate), typeName).lines,
      ...materialLines(materialRows.map(materialUse)).lines,
    ];
  }

  // --- materials -------------------------------------------------------------

  async addMaterial(
    actor: Principal,
    workOrderId: string,
    dto: AddMaterialUseDto,
  ) {
    const order = await this.requireOrder(actor.activeCompanyId, workOrderId);
    await this.assertMayRecord(actor, order);
    const code = dto.product_code.trim();
    await this.catalog.assertCodes(order.companyId, [
      { code, field: 'product_code' },
    ]);
    const product = (await this.products.findFirst({
      where: { companyId: order.companyId, code },
      select: { name: true, unit: true },
    })) as { name: string; unit: string | null } | null;
    const usedOn = dto.used_on ?? thaiToday();
    if (!isDay(usedOn)) {
      throw new AppError('VALIDATION_FAILED', 'วันที่ใช้ไม่ถูกต้อง');
    }
    // the standard price on that day, unless typed; the supplier cost now
    const standard =
      dto.unit_price === undefined || dto.unit_price === null
        ? (await this.prices.lookup(actor, [code], 'THB', usedOn))[code]
        : undefined;
    const unitPrice = dto.unit_price ?? standard?.unit_price ?? null;
    const cost = (await this.vendorCosts.lookup(actor, [code])).items[0];
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceMaterialUse.create({
        data: {
          companyId: order.companyId,
          workOrderId,
          requestId: order.requestId,
          productCode: code,
          description: dto.description?.trim() || product?.name || code,
          quantity: dto.quantity,
          unit: product?.unit ?? null,
          serialNo: dto.serial_no?.trim() || null,
          billable: dto.billable ?? order.billing === 'billable',
          unitPrice,
          priceSource:
            dto.unit_price !== undefined && dto.unit_price !== null
              ? 'manual'
              : standard
                ? 'standard'
                : null,
          unitCost: cost?.unitCost ?? null,
          usedOn: new Date(`${usedOn}T00:00:00Z`),
          note: dto.note?.trim() || null,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'service.material.recorded',
          companyId: order.companyId,
          ...auditActor(actor),
          resourceType: 'service_work_order',
          resourceId: workOrderId,
          after: {
            materialId: created.id,
            productCode: code,
            quantity: dto.quantity,
          },
        },
        { prisma },
      );
      return created;
    });
    return { id: row.id };
  }

  async updateMaterial(
    actor: Principal,
    id: string,
    dto: UpdateMaterialUseDto,
  ) {
    const before = await this.requireMaterial(actor.activeCompanyId, id);
    const order = await this.requireOrder(
      actor.activeCompanyId,
      before.workOrderId,
    );
    await this.assertMayRecord(actor, order);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceMaterialUse.update({
        where: { id },
        data: {
          ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
          ...(dto.serial_no !== undefined
            ? { serialNo: dto.serial_no?.trim() || null }
            : {}),
          ...(dto.billable !== undefined ? { billable: dto.billable } : {}),
          ...(dto.unit_price !== undefined
            ? { unitPrice: dto.unit_price, priceSource: 'manual' }
            : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.material.updated',
          companyId: order.companyId,
          ...auditActor(actor),
          resourceType: 'service_work_order',
          resourceId: order.id,
          before: {
            materialId: id,
            quantity: Number(before.quantity),
            unitPrice: num(before.unitPrice),
            billable: before.billable,
          },
          after: { ...dto },
        },
        { prisma },
      );
    });
    return { id };
  }

  async removeMaterial(actor: Principal, id: string) {
    const before = await this.requireMaterial(actor.activeCompanyId, id);
    const order = await this.requireOrder(
      actor.activeCompanyId,
      before.workOrderId,
    );
    await this.assertMayRecord(actor, order);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceMaterialUse.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'service.material.removed',
          companyId: order.companyId,
          ...auditActor(actor),
          resourceType: 'service_work_order',
          resourceId: order.id,
          before: {
            materialId: id,
            productCode: before.productCode,
            quantity: Number(before.quantity),
          },
        },
        { prisma },
      );
    });
    return { id };
  }

  // --- selling rates -----------------------------------------------------------

  /** Every HR work type with its selling rate, if set. */
  async labourRates(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [types, rows] = await Promise.all([
      this.workTypes.findMany({
        where: { companyId, active: true },
        select: { id: true, code: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      }) as Promise<{ id: string; code: string; name: string }[]>,
      this.rateRows(companyId),
    ]);
    return types.map((type) => {
      const row = rows.find((rate) => rate.workTypeId === type.id);
      return {
        workTypeId: type.id,
        code: type.code,
        name: type.name,
        rateId: row?.id ?? null,
        hourlyRate: row ? Number(row.hourlyRate) : null,
        productCode: row?.productCode ?? null,
        note: row?.note ?? null,
      };
    });
  }

  async saveLabourRate(actor: Principal, dto: SaveLabourRateDto) {
    const companyId = actor.activeCompanyId;
    const type = await this.workTypes.findFirst({
      where: { id: dto.work_type_id, companyId },
      select: { id: true },
    });
    if (!type) throw new AppError('NOT_FOUND', 'ไม่พบประเภทงานที่ระบุ');
    const productCode = dto.product_code?.trim() || null;
    if (productCode) {
      await this.catalog.assertCodes(companyId, [
        { code: productCode, field: 'product_code' },
      ]);
    }
    const before = (await this.rates.findFirst({
      where: { companyId, workTypeId: dto.work_type_id },
    })) as RateRow | null;
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceLabourRate.upsert({
        where: {
          companyId_workTypeId: { companyId, workTypeId: dto.work_type_id },
        },
        create: {
          companyId,
          workTypeId: dto.work_type_id,
          hourlyRate: dto.hourly_rate,
          productCode,
          note: dto.note?.trim() || null,
          createdBy: actor.userId,
        },
        update: {
          hourlyRate: dto.hourly_rate,
          productCode,
          note: dto.note?.trim() || null,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.labour_rate.saved',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_labour_rate',
          resourceId: dto.work_type_id,
          before: before
            ? {
                hourlyRate: Number(before.hourlyRate),
                productCode: before.productCode,
              }
            : undefined,
          after: { hourlyRate: dto.hourly_rate, productCode },
        },
        { prisma },
      );
    });
    return this.labourRates(actor);
  }

  // --- helpers ---------------------------------------------------------------

  /** The service team, or whoever works the case — before the charge is sent. */
  private async assertMayRecord(actor: Principal, order: OrderRow) {
    if (!actor.permissions.includes('service.asset.manage')) {
      const request = (await this.requestRows.findFirst({
        where: { id: order.requestId },
        select: { assigneeUserId: true },
      })) as { assigneeUserId: string | null } | null;
      if (request?.assigneeUserId !== actor.userId) {
        throw new AppError(
          'FORBIDDEN',
          'บันทึกวัสดุได้เฉพาะทีมบริการหรือผู้รับผิดชอบเคส',
        );
      }
    }
    const sent = await this.billings.count({
      where: { workOrderId: order.id, status: 'confirmed' },
    });
    if (sent) {
      throw new AppError(
        'CONFLICT',
        'ส่งใบเรียกเก็บของงานนี้แล้ว — แก้วัสดุไม่ได้ (ยกเลิกใบเรียกเก็บก่อน)',
      );
    }
  }

  private async requireOrder(companyId: string, id: string) {
    const row = (await this.orders.findFirst({
      where: { id, companyId },
      select: { id: true, companyId: true, requestId: true, billing: true },
    })) as OrderRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    return row;
  }

  private async requireMaterial(companyId: string, id: string) {
    const row = (await this.materials.findFirst({
      where: { id, companyId, deletedAt: null },
    })) as (MaterialRow & { workOrderId: string }) | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายการวัสดุ');
    return row;
  }

  private async materialRows(workOrderId: string) {
    return (await this.materials.findMany({
      where: { workOrderId, deletedAt: null },
      orderBy: [{ usedOn: 'asc' }, { createdAt: 'asc' }],
    })) as MaterialRow[];
  }

  private async rateRows(companyId: string) {
    return (await this.rates.findMany({ where: { companyId } })) as RateRow[];
  }

  private async typeNames(companyId: string) {
    const rows = (await this.workTypes.findMany({
      where: { companyId },
      select: { id: true, name: true },
    })) as { id: string; name: string }[];
    return new Map(rows.map((row) => [row.id, row.name]));
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

function rate(row: RateRow): LabourRate {
  return {
    workTypeId: row.workTypeId,
    hourlyRate: Number(row.hourlyRate),
    productCode: row.productCode,
  };
}

function materialUse(row: MaterialRow): MaterialUse {
  return {
    productCode: row.productCode,
    description: row.description,
    quantity: Number(row.quantity),
    unit: row.unit,
    serialNo: row.serialNo,
    billable: row.billable,
    unitPrice: num(row.unitPrice),
    unitCost: num(row.unitCost),
  };
}
