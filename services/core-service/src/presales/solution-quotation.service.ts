import { Injectable } from '@nestjs/common';
import type { QuotationStatus } from '@prisma/client';
import { AppError, Principal } from '@request-management/share';
import { QuotationsService } from '../crm/quotations.service';
import {
  OpportunityRepository,
  QuotationRepository,
} from '../crm/sales.repositories';
import type { QuotationLineDto } from '../crm/dto/quotation.dto';
import { PricesService } from '../pricing/prices.service';
import { SolutionVersionRepository } from './solution.repositories';
import { SolutionsService } from './solutions.service';
import { readBoq } from './solution-rules';

/** A monthly standard price starts a quotation line at a year. */
const DEFAULT_TERM_MONTHS = 12;
/** Quotations that still stand for their Solution version. */
const LIVE: QuotationStatus[] = [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'accepted',
];

/**
 * CD-198 — คิดต้นทุนจาก BOQ: handoff 3, Pre-Sales → Pricing (user decisions
 * 1 ต.ค. 2569).
 *
 * - From a version that is "พร้อมส่ง Pricing" — approved, every BOQ line
 *   coded (CD-135) and the estimate complete (CD-136) — one action opens a
 *   draft quotation on the deal;
 * - each BOQ line becomes a quotation line with its cost and where the cost
 *   came from (the newest partner quote, or the reference cost); each labour
 *   line a service line at its rate; the unit price is the most specific
 *   price in effect for the deal (CD-194/197), or 0 to be priced;
 * - the quotation remembers the Solution version; asking again while one
 *   still stands returns that one instead of a second;
 * - Pricing (`pricing.price.manage`) or the salesperson
 *   (`crm.sales.manage`) may do it — the quotation itself still goes
 *   through every rule of CD-76 (visibility of the deal, margin check).
 */
@Injectable()
export class SolutionQuotationService {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly versions: SolutionVersionRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly quotationRows: QuotationRepository,
    private readonly quotations: QuotationsService,
    private readonly prices: PricesService,
  ) {}

  /** The quotations started from this Solution, newest first. */
  async forSolution(id: string, actor: Principal) {
    await this.solutions.requireReadable(id, actor);
    return this.quotationRows.findMany({
      where: { solutionId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        quotationNo: true,
        version: true,
        status: true,
        solutionVersionNo: true,
        netTotal: true,
        currency: true,
      },
    });
  }

  async create(id: string, versionNo: number, actor: Principal) {
    if (
      !actor.permissions.includes('pricing.price.manage') &&
      !actor.permissions.includes('crm.sales.manage')
    ) {
      throw new AppError(
        'FORBIDDEN',
        'ต้องเป็นทีม Pricing หรือพนักงานขายของดีล',
      );
    }
    const solution = await this.solutions.requireReadable(id, actor);
    const version = (await this.versions.findFirst({
      where: { solutionId: id, versionNo },
      select: { approvalStatus: true, boq: true },
    })) as { approvalStatus: string; boq: unknown } | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    if (version.approvalStatus !== 'approved') {
      throw new AppError(
        'CONFLICT',
        `เวอร์ชัน ${versionNo} ยังไม่อนุมัติ — เริ่มคิดราคาได้เมื่อ Solution อนุมัติแล้ว`,
      );
    }
    const estimate = await this.solutions.estimateOf(id, versionNo);
    if (!estimate?.complete) {
      throw new AppError(
        'CONFLICT',
        `ยังไม่พร้อมส่ง Pricing — ต้นทุนยังไม่ครบ ${estimate?.missing_cost ?? 0} บรรทัด`,
      );
    }

    const existing = (await this.quotationRows.findFirst({
      where: {
        solutionId: id,
        solutionVersionNo: versionNo,
        status: { in: LIVE },
      },
      select: { id: true },
    })) as { id: string } | null;
    if (existing) {
      return {
        ...(await this.quotations.findOne(existing.id, actor)),
        existing: true,
      };
    }

    const deal = (await this.opportunities.findFirst({
      where: { id: solution.opportunityId },
      select: { currency: true },
    })) as { currency: string } | null;
    const currency = deal?.currency ?? 'THB';
    const items = readBoq(version.boq);
    const prices = await this.prices.lookup(
      actor,
      items.map((item) => item.productCode),
      currency,
      undefined,
      solution.opportunityId,
    );

    const lines: QuotationLineDto[] = [];
    const costSources: (string | null)[] = [];
    estimate.lines.forEach((line) => {
      const item = items[line.index];
      const price = prices[line.productCode];
      lines.push({
        product_code: line.productCode || undefined,
        description: [item.name, item.model, item.description]
          .filter(Boolean)
          .join(' · '),
        quantity: line.quantity,
        unit: item.unit || undefined,
        unit_cost: line.unitCost ?? 0,
        unit_price: price?.unit_price ?? 0,
        price_id: price?.price_id,
        price_model: price?.price_model as QuotationLineDto['price_model'],
        term_months:
          price?.price_model === 'monthly' ? DEFAULT_TERM_MONTHS : undefined,
      });
      costSources.push(
        line.source === 'quote'
          ? `ใบเสนอราคาคู่ค้า: ${line.vendorName ?? ''}${line.expired ? ' (หมดอายุ)' : ''}`
          : 'ต้นทุนอ้างอิง (BOQ)',
      );
    });
    for (const labor of estimate.labor) {
      if (labor.mandays <= 0) continue;
      lines.push({
        description: `ค่าแรง: ${labor.role}${labor.note ? ` — ${labor.note}` : ''}`,
        quantity: labor.mandays,
        unit: 'man-day',
        unit_cost: labor.rate,
        unit_price: 0,
      });
      costSources.push('อัตราแรงงาน');
    }

    const created = await this.quotations.createForOpportunity(
      solution.opportunityId,
      { title: solution.title, lines },
      actor,
      { solutionId: id, solutionVersionNo: versionNo, costSources },
    );
    return { ...created, existing: false };
  }
}
