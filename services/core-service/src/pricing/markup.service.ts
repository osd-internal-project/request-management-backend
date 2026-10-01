import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import { ProductRepository } from '../crm/product.repositories';
import { OpportunityRepository } from '../crm/sales.repositories';
import {
  CustomerSegmentAssignmentRepository,
  CustomerSegmentValueRepository,
} from '../crm/segment.repositories';
import { MarkupRuleRepository } from './pricing.repositories';
import {
  cleanMarkup,
  pickMarkup,
  type CleanMarkup,
  type MarkupInput,
  type MarkupRuleState,
} from './markup-rules';

interface RuleRow {
  id: string;
  priority: number;
  workType: string | null;
  productGroupCode: string | null;
  segmentValueId: string | null;
  markupPct: unknown;
  note: string;
  active: boolean;
  updatedAt: Date;
}

const RULE_SELECT = {
  id: true,
  priority: true,
  workType: true,
  productGroupCode: true,
  segmentValueId: true,
  markupPct: true,
  note: true,
  active: true,
  updatedAt: true,
} as const;

/**
 * CD-200 — กำหนด Markup (user decisions 1 ต.ค. 2569): rules by work type,
 * SAP item group and customer group, each condition optional; the lowest
 * priority number wins and a tie goes to the most specific. A line with a
 * cost but no standard or special price in effect is offered
 * cost × (1 + markup) — on product pick and when a quotation starts from a
 * Solution — and remembers the markup that priced it.
 */
@Injectable()
export class MarkupService {
  constructor(
    private readonly rules: MarkupRuleRepository,
    private readonly products: ProductRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly segmentValues: CustomerSegmentValueRepository,
    private readonly segmentAssignments: CustomerSegmentAssignmentRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(actor: Principal) {
    const rows = await this.active(actor.activeCompanyId, true);
    const [groups, segments] = await Promise.all([
      this.groupNames(actor.activeCompanyId),
      this.segmentLabels(actor.activeCompanyId),
    ]);
    return rows
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((row) => ({
        ...row,
        markupPct: Number(row.markupPct),
        productGroupName: row.productGroupCode
          ? (groups.get(row.productGroupCode) ?? row.productGroupCode)
          : null,
        segmentLabel: row.segmentValueId
          ? (segments.get(row.segmentValueId) ?? row.segmentValueId)
          : null,
      }));
  }

  /** What the rule form offers: the SAP item groups and the segment values. */
  async options(actor: Principal) {
    const [groups, segments] = await Promise.all([
      this.groupNames(actor.activeCompanyId),
      this.segmentLabels(actor.activeCompanyId),
    ]);
    return {
      groups: [...groups].map(([code, name]) => ({ code, name })),
      segments: [...segments].map(([id, label]) => ({ id, label })),
    };
  }

  async create(input: MarkupInput, actor: Principal) {
    const value = await this.clean(actor.activeCompanyId, input);
    const created = await this.transactions.execute(async (prisma) => {
      const row = (await this.rules.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            ...value,
            createdBy: actor.userId,
          },
          select: RULE_SELECT,
        },
        { prisma },
      )) as RuleRow;
      await this.audit.record(
        {
          eventType: 'pricing.markup.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'markup_rule',
          resourceId: row.id,
          after: { ...value },
        },
        { prisma },
      );
      return row;
    });
    return { ...created, markupPct: Number(created.markupPct) };
  }

  async update(id: string, input: MarkupInput, actor: Principal) {
    const existing = await this.require(actor.activeCompanyId, id);
    const value = await this.clean(actor.activeCompanyId, {
      priority: existing.priority,
      workType: existing.workType,
      productGroupCode: existing.productGroupCode,
      segmentValueId: existing.segmentValueId,
      markupPct: Number(existing.markupPct),
      note: existing.note,
      active: existing.active,
      ...input,
    });
    await this.transactions.execute(async (prisma) => {
      await this.rules.update(
        { where: { id }, data: { ...value, updatedBy: actor.userId } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pricing.markup.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'markup_rule',
          resourceId: id,
          before: {
            priority: existing.priority,
            workType: existing.workType,
            productGroupCode: existing.productGroupCode,
            segmentValueId: existing.segmentValueId,
            markupPct: Number(existing.markupPct),
            active: existing.active,
          },
          after: { ...value },
        },
        { prisma },
      );
    });
    return { id, ...value };
  }

  /** Soft delete — a line priced by it keeps its percent. */
  async remove(id: string, actor: Principal) {
    await this.require(actor.activeCompanyId, id);
    await this.transactions.execute(async (prisma) => {
      await this.rules.update(
        {
          where: { id },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pricing.markup.removed',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'markup_rule',
          resourceId: id,
        },
        { prisma },
      );
    });
    return { id, removed: true };
  }

  /**
   * The markup for lines of a deal: each `{ productCode, workType }` gets the
   * rule that applies (or none). A deal out of reach gives no customer group.
   */
  async suggest(
    actor: Principal,
    lines: readonly { productCode?: string | null; workType?: string | null }[],
    opportunityId?: string,
  ) {
    const companyId = actor.activeCompanyId;
    const rules = (await this.active(companyId, false)).map(
      (row): MarkupRuleState => ({ ...row, markupPct: Number(row.markupPct) }),
    );
    if (!rules.length) return lines.map(() => null);
    const codes = [
      ...new Set(lines.map((line) => line.productCode).filter(Boolean)),
    ] as string[];
    const products = codes.length
      ? ((await this.products.findMany({
          where: { companyId, code: { in: codes } },
          select: { code: true, groupCode: true },
        })) as { code: string; groupCode: string | null }[])
      : [];
    const groupOf = new Map(products.map((row) => [row.code, row.groupCode]));
    const segmentValueIds = opportunityId
      ? await this.segmentsOfDeal(actor, opportunityId)
      : [];
    return lines.map((line) => {
      const rule = pickMarkup(rules, {
        workType: line.workType ?? null,
        groupCode: line.productCode
          ? (groupOf.get(line.productCode) ?? null)
          : null,
        segmentValueIds,
      });
      return rule ? { rule_id: rule.id, markup_pct: rule.markupPct } : null;
    });
  }

  // --- helpers --------------------------------------------------------------------

  private async active(companyId: string, includeInactive: boolean) {
    return (await this.rules.findMany({
      where: {
        companyId,
        deletedAt: null,
        ...(includeInactive ? {} : { active: true }),
      },
      select: RULE_SELECT,
    })) as RuleRow[];
  }

  private async segmentsOfDeal(actor: Principal, opportunityId: string) {
    const deal = (await this.opportunities.findFirst({
      where: {
        id: opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: { customerId: true },
    })) as { customerId: string | null } | null;
    if (!deal?.customerId) return [];
    return (
      (await this.segmentAssignments.findMany({
        where: { customerId: deal.customerId },
        select: { valueId: true },
      })) as { valueId: string }[]
    ).map((row) => row.valueId);
  }

  private async clean(
    companyId: string,
    input: MarkupInput,
  ): Promise<CleanMarkup> {
    const cleaned = cleanMarkup(input);
    if (!cleaned.ok) {
      throw new AppError(
        'VALIDATION_FAILED',
        'กฎ markup ไม่ถูกต้อง',
        cleaned.problems,
      );
    }
    const value = cleaned.value;
    if (value.segmentValueId) {
      const segment = await this.segmentValues.findFirst({
        where: { id: value.segmentValueId, dimension: { companyId } },
        select: { id: true },
      });
      if (!segment) throw new AppError('NOT_FOUND', 'ไม่พบกลุ่มลูกค้าที่ระบุ');
    }
    return value;
  }

  private async require(companyId: string, id: string) {
    const row = (await this.rules.findFirst({
      where: { id, companyId, deletedAt: null },
      select: RULE_SELECT,
    })) as RuleRow | null;
    // SCOPE-03: another company's rule answers 404.
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบกฎ markup ที่ระบุ');
    return row;
  }

  private async groupNames(companyId: string) {
    const rows = (await this.products.findMany({
      where: { companyId, groupCode: { not: null } },
      select: { groupCode: true, groupName: true },
      distinct: ['groupCode'],
      orderBy: { groupCode: 'asc' },
    })) as { groupCode: string; groupName: string | null }[];
    return new Map(
      rows.map((row) => [row.groupCode, row.groupName ?? row.groupCode]),
    );
  }

  private async segmentLabels(companyId: string) {
    const rows = (await this.segmentValues.findMany({
      where: { active: true, dimension: { companyId } },
      select: {
        id: true,
        nameTh: true,
        dimension: { select: { nameTh: true } },
      },
      orderBy: [{ dimension: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
    })) as unknown as {
      id: string;
      nameTh: string;
      dimension: { nameTh: string };
    }[];
    return new Map(
      rows.map((row) => [row.id, `${row.dimension.nameTh}: ${row.nameTh}`]),
    );
  }
}
