import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { ApprovalCaseRepository } from '../approvals/approval-case.repository';
import { ApprovalsService } from '../approvals/approvals.service';
import { QuotationRepository } from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';
import { CustomerTimelineService } from './customer-timeline.service';
import {
  capDiscounts,
  cleanMinMargins,
  computeQuotationTotals,
  maxDiscountWithin,
  WORK_TYPE_LABELS,
  WORK_TYPES,
  workTypeKey,
  type MinMarginByWorkType,
  type WorkTypeKey,
} from './quotation-math';

const Decimal = Prisma.Decimal;
type Decimal = Prisma.Decimal;

/** The keys a cap can name: the work types and the untyped lines. */
const CAP_KEYS: readonly WorkTypeKey[] = [...WORK_TYPES, 'none'];

/** What cost/margin a viewer may see is the caller's business; this is the gate. */
const COST_PERMISSION = 'crm.sales.manage';

interface StoredLine {
  lineNo: number;
  productCode: string | null;
  description: string;
  quantity: Decimal;
  unit: string | null;
  unitPrice: Decimal;
  unitCost: Decimal;
  discountPct: Decimal;
  priceId: string | null;
  priceModel: string;
  termMonths: number | null;
  costSource: string | null;
  workType: string | null;
  markupPct: Decimal | null;
}

interface QuotationUnderApproval {
  id: string;
  quotationNo: string;
  version: number;
  companyId: string;
  opportunityId: string;
  customerId: string | null;
  partyName: string;
  partyTaxId: string | null;
  contactName: string | null;
  title: string;
  status: string;
  currency: string;
  validUntil: Date | null;
  paymentTerms: string | null;
  note: string | null;
  vatPct: Decimal;
  minMarginPct: Decimal | null;
  approvalRequestId: string | null;
  submittedAt: Date | null;
  solutionId: string | null;
  solutionVersionNo: number | null;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
  lines: StoredLine[];
}

export type DiscountCaps = Partial<Record<WorkTypeKey, number>>;

/**
 * CD-203 — บริหารส่วนลด: what a discount does to the margin, shown to whoever
 * approves the quotation's price request, and the approver's way to approve a
 * smaller discount instead of only yes or no.
 *
 * Choosing an option is a decision on the request: the version with that
 * discount is issued (pending, on the same request), the version asked for is
 * superseded, and the approver's step is approved with the choice as its
 * note. Later levels decide on the new version; when the last one approves,
 * `QuotationApprovalSyncService` releases it like any other.
 *
 * Approvers of the request see cost and margin even without CRM access — the
 * decision is theirs to make; anyone else needs `crm.sales.manage`.
 */
@Injectable()
export class QuotationDiscountService {
  constructor(
    private readonly quotations: QuotationRepository,
    private readonly configs: CrmConfigRepository,
    private readonly cases: ApprovalCaseRepository,
    private readonly approvals: ApprovalsService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async impact(requestId: string, actor: Principal) {
    const quotation = await this.quotationOf(requestId, actor.activeCompanyId);
    const people = await this.approversOf(requestId, actor.activeCompanyId);
    const isApprover = people.all.has(actor.userId);
    const costVisible =
      isApprover || actor.permissions.includes(COST_PERMISSION);
    if (!costVisible && !actor.permissions.includes('crm.sales.read')) {
      // SCOPE-03 — unseen answers 404.
      throw new AppError('NOT_FOUND', 'ไม่พบใบเสนอราคาของคำขอนี้');
    }

    const config = await this.configOf(quotation.companyId);
    const current = figures(
      quotation,
      quotation.lines.map((line) => Number(line.discountPct)),
      config,
    );
    const suggestion = suggestCaps(current.groups);
    const suggested =
      Object.keys(suggestion).length > 0
        ? figures(quotation, capDiscounts(quotation.lines, suggestion), config)
        : null;

    const view = {
      requestId,
      quotation: {
        id: quotation.id,
        quotationNo: quotation.quotationNo,
        version: quotation.version,
        status: quotation.status,
        title: quotation.title,
        partyName: quotation.partyName,
        currency: quotation.currency,
      },
      costVisible,
      canChoose:
        quotation.status === 'pending_approval' &&
        people.current.has(actor.userId),
      companyMinMarginPct: config.minMarginPct,
      minMarginByWorkType: config.byType,
      totals: current.totals,
      groups: current.groups,
      lines: current.lines,
      suggestion: suggested
        ? {
            caps: suggestion,
            totals: suggested.totals,
            groups: suggested.groups,
          }
        : null,
    };
    return costVisible ? view : withoutCost(view);
  }

  /**
   * The approver approves a smaller discount: `caps` holds each work type's
   * largest discount (%); a line already below its cap keeps its own.
   */
  async choose(
    requestId: string,
    dto: { caps: Record<string, number>; note?: string },
    actor: Principal,
  ) {
    const caps = cleanCaps(dto.caps);
    const quotation = await this.quotationOf(requestId, actor.activeCompanyId);
    if (quotation.status !== 'pending_approval') {
      throw new AppError(
        'CRM_QUOTATION_STATE_INVALID',
        'ใบเสนอราคาของคำขอนี้ไม่ได้รออนุมัติแล้ว',
      );
    }
    const people = await this.approversOf(requestId, actor.activeCompanyId);
    if (!people.openCaseId) {
      throw new AppError(
        'CRM_QUOTATION_STATE_INVALID',
        'คำขอนี้ไม่มีขั้นอนุมัติที่รอตัดสินอยู่',
      );
    }

    const discounts = capDiscounts(quotation.lines, caps);
    const changed = quotation.lines.some(
      (line, index) => Number(line.discountPct) !== discounts[index],
    );
    if (!changed) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ทางเลือกนี้ไม่ได้ลดส่วนลดของบรรทัดใดเลย — อนุมัติตามที่ขอได้ตามปกติ',
        [{ field: 'caps', reason: 'no_change' }],
      );
    }

    const config = await this.configOf(quotation.companyId);
    const chosen = figures(quotation, discounts, config);
    const capsText = CAP_KEYS.filter((key) => caps[key] !== undefined)
      .map((key) => `${labelOf(key)} ไม่เกิน ${caps[key]}%`)
      .join(', ');
    const label = `${quotation.quotationNo} v${quotation.version}`;
    const version = quotation.version + 1;

    // The decision first: the approval engine is what says whether this
    // person may decide this step (approver, candidate or delegate). Once it
    // stands, the version it chose is issued.
    const note = [
      `อนุมัติด้วยส่วนลดที่ยังอยู่ในเกณฑ์: ${capsText} — ${label} → v${version}`,
      dto.note?.trim(),
    ]
      .filter(Boolean)
      .join(' · ');
    const decided = await this.approvals.decide(
      people.openCaseId,
      { decision: 'approve', note },
      actor,
    );
    // The last level just approved: the chosen version is the approved one.
    // Otherwise it waits on the remaining levels, and the outcome event finds
    // it (the sync looks up the request's version that is still pending).
    const final = decided.status === 'approved';

    await this.transactions.execute(async (prisma) => {
      // The sync may already have approved the version asked for after a
      // final decision — it is replaced all the same.
      const superseded = await prisma.quotation.updateMany({
        where: {
          id: quotation.id,
          status: { in: ['pending_approval', 'approved'] },
        },
        data: { status: 'superseded', updatedBy: actor.userId },
      });
      if (superseded.count !== 1) {
        throw new AppError(
          'CRM_QUOTATION_STATE_INVALID',
          'สถานะใบเสนอราคาเปลี่ยนไปแล้ว — โหลดใหม่แล้วลองอีกครั้ง',
        );
      }
      const row = (await this.quotations.create(
        {
          data: {
            quotationNo: quotation.quotationNo,
            version,
            companyId: quotation.companyId,
            opportunityId: quotation.opportunityId,
            customerId: quotation.customerId,
            partyName: quotation.partyName,
            partyTaxId: quotation.partyTaxId,
            contactName: quotation.contactName,
            title: quotation.title,
            currency: quotation.currency,
            validUntil: quotation.validUntil,
            paymentTerms: quotation.paymentTerms,
            note: quotation.note,
            subtotal: chosen.raw.subtotal,
            discountTotal: chosen.raw.discountTotal,
            netTotal: chosen.raw.netTotal,
            vatPct: chosen.raw.vatPct,
            vatAmount: chosen.raw.vatAmount,
            grandTotal: chosen.raw.grandTotal,
            costTotal: chosen.raw.costTotal,
            marginAmount: chosen.raw.marginAmount,
            marginPct: chosen.raw.marginPct,
            // Still waiting on the same request: its remaining levels decide
            // on exactly this version.
            status: final ? 'approved' : 'pending_approval',
            approvedAt: final ? new Date() : null,
            minMarginPct: quotation.minMarginPct,
            approvalRequired: true,
            approvalRequestId: requestId,
            submittedAt: quotation.submittedAt ?? new Date(),
            ownerUserId: quotation.ownerUserId,
            ownerOrgUnitId: quotation.ownerOrgUnitId,
            solutionId: quotation.solutionId,
            solutionVersionNo: quotation.solutionVersionNo,
            createdBy: actor.userId,
            lines: {
              create: quotation.lines.map((line, index) => ({
                lineNo: line.lineNo,
                productCode: line.productCode,
                description: line.description,
                quantity: line.quantity,
                unit: line.unit,
                unitPrice: line.unitPrice,
                unitCost: line.unitCost,
                discountPct: discounts[index],
                lineTotal: chosen.amounts[index].lineTotal,
                lineCost: chosen.amounts[index].lineCost,
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
      )) as { id: string };

      await this.audit.record(
        {
          eventType: 'crm.quotation.discount_counter_approved',
          companyId: quotation.companyId,
          ...auditActor(actor),
          resourceType: 'quotation',
          resourceId: row.id,
          before: { id: quotation.id, version: quotation.version },
          after: { id: row.id, version, requestId, caps },
        },
        { prisma },
      );
      if (quotation.customerId) {
        await this.timeline.publish(
          {
            companyId: quotation.companyId,
            customerId: quotation.customerId,
            refType: 'quotation',
            refId: row.id,
            eventType: 'quotation.revised',
            summary: `ผู้อนุมัติเลือกส่วนลดที่ยังอยู่ในเกณฑ์ (${capsText}) — ออก ${quotation.quotationNo} เวอร์ชัน ${version} แทนเวอร์ชัน ${quotation.version}`,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma },
        );
      }
    });

    return this.impact(requestId, actor);
  }

  // --- helpers ---------------------------------------------------------------

  /** The newest version on this request — a chosen option is a newer one. */
  private async quotationOf(requestId: string, companyId: string) {
    const found = (await this.quotations.findFirst({
      where: { approvalRequestId: requestId, companyId },
      orderBy: { version: 'desc' },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    })) as QuotationUnderApproval | null;
    if (!found) {
      throw new AppError('NOT_FOUND', 'ไม่พบใบเสนอราคาของคำขอนี้');
    }
    return found;
  }

  /**
   * Everyone who approves on this request (any case, any step), and who may
   * decide right now — the open case's current step.
   */
  private async approversOf(requestId: string, companyId: string) {
    const cases = await this.cases.search(
      { requestId, companyId },
      { skip: 0, take: 20 },
    );
    const all = new Set<string>();
    const current = new Set<string>();
    let openCaseId: string | null = null;
    for (const found of cases) {
      for (const step of found.steps) {
        for (const id of [
          step.approverUserId,
          step.decidedByUserId,
          ...step.candidateUserIds,
        ]) {
          if (id) all.add(id);
        }
        if (
          found.status === 'pending' &&
          step.stepNo === found.currentStep &&
          step.status === 'pending'
        ) {
          openCaseId = found.id;
          for (const id of [step.approverUserId, ...step.candidateUserIds]) {
            if (id) current.add(id);
          }
        }
      }
    }
    return { all, current, openCaseId };
  }

  private async configOf(companyId: string) {
    const found = (await this.configs.findFirst({
      where: { companyId },
      select: { minMarginPct: true, minMarginByWorkType: true },
    })) as { minMarginPct: number; minMarginByWorkType: unknown } | null;
    return {
      minMarginPct: found?.minMarginPct ?? 15,
      byType: cleanMinMargins(found?.minMarginByWorkType),
    };
  }
}

type Config = { minMarginPct: number; byType: MinMarginByWorkType };

function labelOf(key: WorkTypeKey): string {
  return key === 'none' ? 'ไม่ระบุประเภทงาน' : WORK_TYPE_LABELS[key];
}

function minFor(key: WorkTypeKey, config: Config): number {
  return key !== 'none' && config.byType[key] !== undefined
    ? config.byType[key]
    : config.minMarginPct;
}

function pct(part: Decimal, whole: Decimal): string | null {
  return whole.gt(0)
    ? part.div(whole).mul(100).toDecimalPlaces(2).toFixed(2)
    : null;
}

/** A quotation's figures with these discounts: totals, per work type, per line. */
function figures(
  quotation: QuotationUnderApproval,
  discounts: readonly number[],
  config: Config,
) {
  const inputs = quotation.lines.map((line, index) => ({
    quantity: line.quantity.toString(),
    unit_price: line.unitPrice.toString(),
    unit_cost: line.unitCost.toString(),
    discount_pct: discounts[index],
    price_model: line.priceModel as 'unit' | 'lump_sum' | 'monthly',
    term_months: line.termMonths,
  }));
  const totals = computeQuotationTotals(inputs, quotation.vatPct.toString());
  const gross = computeQuotationTotals(
    inputs.map((input) => ({ ...input, discount_pct: 0 })),
    quotation.vatPct.toString(),
  ).lines.map((line) => line.lineTotal);

  const groups = new Map<
    WorkTypeKey,
    { gross: Decimal; net: Decimal; cost: Decimal }
  >();
  quotation.lines.forEach((line, index) => {
    const key = workTypeKey(line.workType);
    const group = groups.get(key) ?? {
      gross: new Decimal(0),
      net: new Decimal(0),
      cost: new Decimal(0),
    };
    group.gross = group.gross.plus(gross[index]);
    group.net = group.net.plus(totals.lines[index].lineTotal);
    group.cost = group.cost.plus(totals.lines[index].lineCost);
    groups.set(key, group);
  });

  return {
    amounts: totals.lines,
    totals: {
      gross: totals.subtotal.toFixed(2),
      discount: totals.discountTotal.toFixed(2),
      discountPct: pct(totals.discountTotal, totals.subtotal),
      net: totals.netTotal.toFixed(2),
      cost: totals.costTotal.toFixed(2),
      marginBeforePct: pct(
        totals.subtotal.minus(totals.costTotal),
        totals.subtotal,
      ),
      marginPct: pct(totals.marginAmount, totals.netTotal),
    },
    raw: totals,
    groups: CAP_KEYS.filter((key) => groups.has(key)).map((key) => {
      const group = groups.get(key)!;
      const minMarginPct = minFor(key, config);
      const marginPct = pct(group.net.minus(group.cost), group.net);
      return {
        workType: key,
        gross: group.gross.toFixed(2),
        discount: group.gross.minus(group.net).toFixed(2),
        discountPct: pct(group.gross.minus(group.net), group.gross),
        net: group.net.toFixed(2),
        cost: group.cost.toFixed(2),
        marginBeforePct: pct(group.gross.minus(group.cost), group.gross),
        marginPct,
        minMarginPct,
        below: marginPct === null || Number(marginPct) < minMarginPct,
        maxDiscountPct: maxDiscountWithin(
          group.gross,
          group.cost,
          minMarginPct,
        ),
      };
    }),
    lines: quotation.lines.map((line, index) => ({
      lineNo: line.lineNo,
      description: line.description,
      workType: workTypeKey(line.workType),
      gross: gross[index].toFixed(2),
      discountPct: discounts[index],
      net: totals.lines[index].lineTotal.toFixed(2),
      cost: totals.lines[index].lineCost.toFixed(2),
    })),
  };
}

/** Each work type below its minimum, capped at the most it can give. */
function suggestCaps(
  groups: ReturnType<typeof figures>['groups'],
): DiscountCaps {
  const caps: DiscountCaps = {};
  for (const group of groups) {
    if (group.below && Number(group.discountPct ?? 0) > group.maxDiscountPct) {
      caps[group.workType] = group.maxDiscountPct;
    }
  }
  return caps;
}

function cleanCaps(value: Record<string, number> | undefined): DiscountCaps {
  const caps: DiscountCaps = {};
  const details: { field: string; reason: string }[] = [];
  for (const [key, raw] of Object.entries(value ?? {})) {
    const cap = Number(raw);
    if (
      !(CAP_KEYS as readonly string[]).includes(key) ||
      !Number.isFinite(cap) ||
      cap < 0 ||
      cap > 100
    ) {
      details.push({ field: `caps.${key}`, reason: 'invalid' });
      continue;
    }
    caps[key as WorkTypeKey] = Math.round(cap * 100) / 100;
  }
  if (details.length || !Object.keys(caps).length) {
    throw new AppError(
      'VALIDATION_FAILED',
      'ต้องระบุเพดานส่วนลด (0–100%) ของประเภทงานที่รู้จักอย่างน้อยหนึ่งประเภท',
      details.length ? details : [{ field: 'caps', reason: 'required' }],
    );
  }
  return caps;
}

/** The view for someone who may not see cost: amounts and discounts only. */
function withoutCost<
  T extends {
    totals: object;
    groups: object[];
    lines: object[];
    suggestion: unknown;
  },
>(view: T) {
  const strip = (row: object) => {
    const rest: Record<string, unknown> = { ...row };
    for (const key of [
      'cost',
      'marginBeforePct',
      'marginPct',
      'below',
      'maxDiscountPct',
    ]) {
      delete rest[key];
    }
    return rest;
  };
  return {
    ...view,
    totals: strip(view.totals),
    groups: view.groups.map(strip),
    lines: view.lines.map(strip),
    suggestion: null,
  };
}
