import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
  TxOption,
} from '@request-management/share';

/** CRM sales objects — thin repositories, rules live in the services. */

/** CD-83 — one row of a grouped total: how many, and their summed `amount`. */
export interface AmountGroup {
  key: string | null;
  count: number;
  amount: number;
}

@Injectable()
export class LeadRepository extends BaseRepository<PrismaService['lead']> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.lead;
  }

  /** CD-73 — จำนวน Lead ต่อรหัสสถานะ ตาม where. */
  async countByStatus(
    where: Prisma.LeadWhereInput,
  ): Promise<{ status: string; count: number }[]> {
    const rows = await this.prisma.lead.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    return rows.map((row) => ({ status: row.status, count: row._count._all }));
  }
}

/** รายการสถานะ Lead ต่อบริษัท — ตั้งค่าได้จากหน้า admin, ไม่ใช่ enum ในโค้ด. */
@Injectable()
export class LeadStatusRepository extends BaseRepository<
  PrismaService['leadStatusSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.leadStatusSetting;
  }
}

/** กิจกรรมบน Lead — append-mostly: complete/reopen แต่ไม่ลบ. */
@Injectable()
export class LeadActivityRepository extends BaseRepository<
  PrismaService['leadActivity']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.leadActivity;
  }
}

/** CD-65 กิจกรรมบนโอกาสการขาย — append-mostly เหมือนของ Lead. */
@Injectable()
export class OpportunityActivityRepository extends BaseRepository<
  PrismaService['opportunityActivity']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityActivity;
  }
}

/** CD-75 รูปที่แนบกับกิจกรรมบนโอกาสการขาย. */
@Injectable()
export class OpportunityActivityPhotoRepository extends BaseRepository<
  PrismaService['opportunityActivityPhoto']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityActivityPhoto;
  }
}

/** CD-78 การจองเลขหมายของดีล (Reserve-phone). */
@Injectable()
export class OpportunityPhoneReservationRepository extends BaseRepository<
  PrismaService['opportunityPhoneReservation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityPhoneReservation;
  }
}

/** CD-79 เงื่อนไขการค้ามาตรฐานของบริษัท. */
@Injectable()
export class TradeTermStandardRepository extends BaseRepository<
  PrismaService['tradeTermStandard']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.tradeTermStandard;
  }
}

/** CD-79 รอบการต่อรอง — บันทึกแล้วไม่แก้ นอกจากผลการส่งฝ่ายกฎหมาย. */
@Injectable()
export class NegotiationRoundRepository extends BaseRepository<
  PrismaService['negotiationRound']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.negotiationRound;
  }
}

/** What the opportunity list and the 360° tab both select. */
export const OPPORTUNITY_LIST_SELECT = {
  id: true,
  opportunityCode: true,
  title: true,
  stage: true,
  amount: true,
  currency: true,
  probability: true,
  expectedCloseAt: true,
  customerId: true,
  customer: { select: { id: true, customerCode: true, nameTh: true } },
  /// ผู้มุ่งหวัง — shown in place of the customer while `customerId` is null. */
  prospectName: true,
  prospectTaxId: true,
  ownerUserId: true,
  /// CD-65 — วันติดตามถัดไป / ดีลเงียบ บนรายการและกระดาน.
  lastActivityAt: true,
  nextFollowUpAt: true,
  staleAlertedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OpportunitySelect;

@Injectable()
export class OpportunityRepository extends BaseRepository<
  PrismaService['opportunity']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunity;
  }

  /**
   * รหัสนี้ถูกใช้ไปแล้วหรือยัง — ไม่ปักบริษัท ต่างจากการค้นหาเอกสาร.
   * ตอบว่าดัชนี unique จะยอมรับรหัสนี้ไหม ไม่ใช่ว่าผู้เรียกเห็นแถวไหม.
   */
  async codeTaken(
    opportunityCode: string,
    option?: TxOption,
  ): Promise<boolean> {
    const row = (await this.findUnique(
      { where: { opportunityCode }, select: { id: true } },
      option,
    )) as { id: string } | null;

    return row !== null;
  }

  /** มูลค่ารวมของโอกาสการขายตาม where — used by the 360° summary card. */
  async sumAmount(where: Prisma.OpportunityWhereInput): Promise<number> {
    const result = await this.prisma.opportunity.aggregate({
      where,
      _sum: { amount: true },
    });
    return Number(result._sum.amount ?? 0);
  }

  /** CD-83 — จำนวนและมูลค่ารวมต่อเจ้าของ ตาม where. */
  async totalsByOwner(
    where: Prisma.OpportunityWhereInput,
  ): Promise<AmountGroup[]> {
    const rows = await this.prisma.opportunity.groupBy({
      by: ['ownerUserId'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      key: row.ownerUserId,
      count: row._count._all,
      amount: Number(row._sum.amount ?? 0),
    }));
  }

  /** CD-83 — จำนวนและมูลค่ารวมต่อเหตุผลปิดแพ้ ตาม where (`null` = ไม่ระบุ). */
  async totalsByLostReason(
    where: Prisma.OpportunityWhereInput,
  ): Promise<AmountGroup[]> {
    const rows = await this.prisma.opportunity.groupBy({
      by: ['lostReasonCode'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      key: row.lostReasonCode,
      count: row._count._all,
      amount: Number(row._sum.amount ?? 0),
    }));
  }
}

@Injectable()
export class OpportunityProductRepository extends BaseRepository<
  PrismaService['opportunityProduct']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityProduct;
  }
}

@Injectable()
export class OpportunityLostReasonRepository extends BaseRepository<
  PrismaService['opportunityLostReason']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.opportunityLostReason;
  }
}

/** What the sale-order list and the opportunity detail both select. */
export const SALE_ORDER_LIST_SELECT = {
  id: true,
  saleOrderCode: true,
  status: true,
  amount: true,
  currency: true,
  note: true,
  orderedAt: true,
  cancelledAt: true,
  cancelReason: true,
  opportunityId: true,
  opportunity: { select: { id: true, opportunityCode: true, title: true } },
  customerId: true,
  customer: { select: { id: true, customerCode: true, nameTh: true } },
  quotationId: true,
  quotation: { select: { id: true, quotationNo: true, version: true } },
  // CD-88 — รายการสินค้า + สถานะส่งเข้า SAP (ใบหนึ่งมีไม่กี่บรรทัด เลือกมาเลย).
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
  erpStatus: true,
  erpOrderNo: true,
  erpSyncedAt: true,
  erpLastError: true,
  ownerUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SaleOrderSelect;

/** ใบสั่งขาย — the point where a prospect becomes a customer (PO 10 ก.ย. 2569). */
@Injectable()
export class SaleOrderRepository extends BaseRepository<
  PrismaService['saleOrder']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.saleOrder;
  }

  /** CD-82 — จำนวนและมูลค่ารวมต่อกลุ่มเจ้าของ (snapshot) ตาม where. */
  async totalsByOrgUnit(
    where: Prisma.SaleOrderWhereInput,
  ): Promise<AmountGroup[]> {
    const rows = await this.prisma.saleOrder.groupBy({
      by: ['ownerOrgUnitId'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      key: row.ownerOrgUnitId,
      count: row._count._all,
      amount: Number(row._sum.amount ?? 0),
    }));
  }

  /** CD-83 — จำนวนและมูลค่ารวมต่อเจ้าของ ตาม where. */
  async totalsByOwner(
    where: Prisma.SaleOrderWhereInput,
  ): Promise<AmountGroup[]> {
    const rows = await this.prisma.saleOrder.groupBy({
      by: ['ownerUserId'],
      where,
      _count: { _all: true },
      _sum: { amount: true },
    });
    return rows.map((row) => ({
      key: row.ownerUserId,
      count: row._count._all,
      amount: Number(row._sum.amount ?? 0),
    }));
  }

  /**
   * รหัสนี้ถูกใช้ไปแล้วหรือยัง — ไม่ปักบริษัท ต่างจากการค้นหาเอกสาร.
   * ตอบว่าดัชนี unique จะยอมรับรหัสนี้ไหม ไม่ใช่ว่าผู้เรียกเห็นแถวไหม.
   */
  async codeTaken(saleOrderCode: string, option?: TxOption): Promise<boolean> {
    const row = (await this.findUnique(
      { where: { saleOrderCode }, select: { id: true } },
      option,
    )) as { id: string } | null;

    return row !== null;
  }
}

/**
 * What the quotation list and the opportunity detail both select — no lines.
 * `costTotal`/`marginAmount`/`marginPct` are here on purpose: the
 * `SensitiveFieldInterceptor` (resource `quotation`) removes them for callers
 * who may not see cost, so every endpoint returning this shape must declare
 * `@SensitiveResource('quotation')`.
 */
export const QUOTATION_LIST_SELECT = {
  id: true,
  quotationNo: true,
  version: true,
  title: true,
  status: true,
  currency: true,
  validUntil: true,
  netTotal: true,
  vatAmount: true,
  grandTotal: true,
  costTotal: true,
  marginAmount: true,
  marginPct: true,
  approvalRequired: true,
  approvalRequestId: true,
  opportunityId: true,
  opportunity: { select: { id: true, opportunityCode: true, title: true } },
  customerId: true,
  partyName: true,
  ownerUserId: true,
  submittedAt: true,
  sentAt: true,
  respondedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QuotationSelect;

/** ใบเสนอราคา (CD-76) — one row per version. */
@Injectable()
export class QuotationRepository extends BaseRepository<
  PrismaService['quotation']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.quotation;
  }

  /**
   * รหัสนี้ถูกใช้ไปแล้วหรือยัง — ไม่ปักบริษัท ต่างจากการค้นหาเอกสาร.
   * ตอบว่าดัชนี unique จะยอมรับรหัสนี้ไหม ไม่ใช่ว่าผู้เรียกเห็นแถวไหม.
   */
  async codeTaken(quotationNo: string, option?: TxOption): Promise<boolean> {
    const row = (await this.findFirst(
      { where: { quotationNo }, select: { id: true } },
      option,
    )) as { id: string } | null;

    return row !== null;
  }
}

@Injectable()
export class QuotationLineRepository extends BaseRepository<
  PrismaService['quotationLine']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.quotationLine;
  }
}

/** CD-82 เป้ายอดขายรายเดือน — ค่าที่มีผลอยู่ตอนนี้เท่านั้น. */
@Injectable()
export class SalesTargetRepository extends BaseRepository<
  PrismaService['salesTarget']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.salesTarget;
  }
}

/** CD-82 ประวัติการเปลี่ยนเป้า รวมค่าที่รออนุมัติ — append-only นอกจากสถานะ. */
@Injectable()
export class SalesTargetRevisionRepository extends BaseRepository<
  PrismaService['salesTargetRevision']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.salesTargetRevision;
  }
}

/** CD-71 แคมเปญการตลาดต่อบริษัท. */
@Injectable()
export class CampaignRepository extends BaseRepository<
  PrismaService['campaign']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.campaign;
  }
}

/** CD-205 — ทะเบียนข้อยกเว้นด้านราคา. */
@Injectable()
export class PricingExceptionRepository extends BaseRepository<
  PrismaService['pricingException']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.pricingException;
  }
}
