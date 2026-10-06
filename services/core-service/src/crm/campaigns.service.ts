import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  salesAccessSubject,
  visibleLeadsWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import {
  CreateCampaignDto,
  ListCampaignsQueryDto,
  UpdateCampaignDto,
} from './dto/sales.dto';
import {
  CampaignBudgetLineRepository,
  CampaignRepository,
  CampaignSpendRepository,
  LeadRepository,
  SaleOrderRepository,
} from './sales.repositories';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { overBudget, progress, spentTotal } from '../macom/campaign-plan-rules';

interface CampaignRow {
  id: string;
  code: string;
  name: string;
  channel: string | null;
  startDate: Date | null;
  endDate: Date | null;
  budget: Prisma.Decimal | null;
  note: string | null;
  active: boolean;
  salesAxis: string | null;
  receivingOrgUnitId: string | null;
  targetLeads: number | null;
  targetDeals: number | null;
  targetSales: Prisma.Decimal | null;
  createdAt: Date;
}

export interface CampaignView {
  id: string;
  code: string;
  name: string;
  channel: string | null;
  start_date: string | null;
  end_date: string | null;
  budget: number | null;
  note: string | null;
  active: boolean;
  /** CD-268 — แกนขายที่ป้อน และทีมที่รับ Lead. */
  sales_axis: string | null;
  receiving_org_unit: { id: string; name: string } | null;
  /** CD-268 — งบมาจากบรรทัดงบรายช่องทาง (แก้งบรวมตรง ๆ ไม่ได้). */
  has_budget_lines: boolean;
  /** CD-268 — ค่าใช้จ่ายจริง (ไม่นับที่ยกเลิก) และเกินงบหรือไม่. */
  spent: number;
  over_budget: boolean;
  targets: {
    leads: number | null;
    deals: number | null;
    sales: number | null;
  };
  /** สัดส่วนที่ถึงเป้า (1 = ถึงเป้า) — null เมื่อไม่ตั้งเป้า. */
  progress: {
    leads: number | null;
    deals: number | null;
    sales: number | null;
  };
  /**
   * ผลของแคมเปญ — ผู้ดูแลแคมเปญ (`crm.campaign.manage`) เห็นตัวเลขรวมทั้งบริษัท
   * (นับอย่างเดียว ไม่เปิดตัว Lead); คนอื่นนับเฉพาะ Lead ที่ตัวเองมองเห็น (SCOPE-02).
   */
  stats: {
    leads: number;
    converted: number;
    won: number;
    /** มูลค่าใบสั่งขายที่ไม่ยกเลิก จากโอกาสที่มาจาก Lead ของแคมเปญ. */
    sales_amount: number;
    /** งบ ÷ จำนวน Lead; null เมื่อไม่มีงบหรือไม่มี Lead. */
    cost_per_lead: number | null;
    /** ยอดขาย ÷ งบ (เท่า); null เมื่อไม่มีงบ. */
    sales_per_budget: number | null;
  };
}

const date = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const toDate = (value?: string) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : undefined;
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * CD-71 — แคมเปญ: ผูก Lead กับกิจกรรมการตลาด แล้ววัดผลถึงยอดขาย.
 *
 * Lead ผูกด้วย **รหัส** (`campaign_code`) ไม่ใช่ id — เว็บฟอร์มลงทะเบียนงานอีเวนต์
 * และไฟล์ Excel ถือรหัสที่การตลาดตั้งเองได้ ส่วน uuid ไม่มีใครพิมพ์ถูก. ทุกทางเข้า
 * (หน้าจอ, นำเข้า, external intake) ผ่าน `resolveCode` จุดเดียว: รหัสที่ไม่มีหรือ
 * แคมเปญที่ปิดแล้ว = ปฏิเสธ ไม่ใช่ปล่อยว่าง — ใบที่ผูกแคมเปญผิดคือตัวเลขการตลาด
 * ที่เพี้ยนโดยไม่มีใครรู้.
 */
@Injectable()
export class CampaignsService {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly leads: LeadRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly audit: AuditWriter,
    private readonly orgUnits: OrgUnitRepository,
    private readonly budgetLines: CampaignBudgetLineRepository,
    private readonly spends: CampaignSpendRepository,
  ) {}

  async list(
    query: ListCampaignsQueryDto,
    actor: Principal,
  ): Promise<CampaignView[]> {
    const rows = (await this.campaigns.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.active === 'true' ? { active: true } : {}),
      },
      orderBy: [{ active: 'desc' }, { startDate: 'desc' }, { code: 'asc' }],
    })) as CampaignRow[];
    if (!rows.length) return [];

    const ids = rows.map((row) => row.id);
    const leads = (await this.leads.findMany({
      where: {
        AND: [
          hasPermission(actor, 'crm.campaign.manage')
            ? { companyId: actor.activeCompanyId }
            : visibleLeadsWhere(salesAccessSubject(actor)),
          { campaignId: { in: ids } },
        ],
      },
      select: {
        campaignId: true,
        convertedOpportunityId: true,
        convertedOpportunity: { select: { stage: true } },
      },
    })) as unknown as {
      campaignId: string;
      convertedOpportunityId: string | null;
      convertedOpportunity: { stage: string } | null;
    }[];

    const opportunityIds = leads
      .map((lead) => lead.convertedOpportunityId)
      .filter((id): id is string => Boolean(id));
    const campaignOf = new Map(
      leads
        .filter((lead) => lead.convertedOpportunityId)
        .map((lead) => [
          lead.convertedOpportunityId as string,
          lead.campaignId,
        ]),
    );
    const sold = opportunityIds.length
      ? ((await this.saleOrders.findMany({
          where: { opportunityId: { in: opportunityIds }, status: 'open' },
          select: { opportunityId: true, amount: true },
        })) as { opportunityId: string; amount: Prisma.Decimal | null }[])
      : [];
    const [lines, spends, units] = await Promise.all([
      this.budgetLines.findMany({
        where: { campaignId: { in: ids } },
        select: { campaignId: true },
      }) as Promise<{ campaignId: string }[]>,
      this.spends.findMany({
        where: { campaignId: { in: ids } },
        select: {
          campaignId: true,
          budgetLineId: true,
          amount: true,
          voidedAt: true,
        },
      }) as Promise<
        {
          campaignId: string;
          budgetLineId: string | null;
          amount: Prisma.Decimal;
          voidedAt: Date | null;
        }[]
      >,
      this.orgUnits.findMany({
        where: {
          id: {
            in: rows.flatMap((row) =>
              row.receivingOrgUnitId ? [row.receivingOrgUnitId] : [],
            ),
          },
        },
        select: { id: true, name: true },
      }) as Promise<{ id: string; name: string }[]>,
    ]);
    const unitName = new Map(units.map((unit) => [unit.id, unit.name]));

    return rows.map((row) => {
      const mine = leads.filter((lead) => lead.campaignId === row.id);
      const salesAmount = sold
        .filter((order) => campaignOf.get(order.opportunityId) === row.id)
        .reduce((sum, order) => sum + Number(order.amount ?? 0), 0);
      const budget = row.budget === null ? null : Number(row.budget);
      const spent = spentTotal(
        spends
          .filter((spend) => spend.campaignId === row.id)
          .map((spend) => ({
            budgetLineId: spend.budgetLineId,
            amount: Number(spend.amount),
            voided: spend.voidedAt !== null,
          })),
      );
      const won = mine.filter(
        (lead) => lead.convertedOpportunity?.stage === 'won',
      ).length;
      const targetSales =
        row.targetSales === null ? null : Number(row.targetSales);

      return {
        id: row.id,
        code: row.code,
        name: row.name,
        channel: row.channel,
        start_date: date(row.startDate),
        end_date: date(row.endDate),
        budget,
        note: row.note,
        active: row.active,
        sales_axis: row.salesAxis,
        receiving_org_unit: row.receivingOrgUnitId
          ? {
              id: row.receivingOrgUnitId,
              name: unitName.get(row.receivingOrgUnitId) ?? '—',
            }
          : null,
        has_budget_lines: lines.some((line) => line.campaignId === row.id),
        spent,
        over_budget: overBudget(budget, spent),
        targets: {
          leads: row.targetLeads,
          deals: row.targetDeals,
          sales: targetSales,
        },
        progress: {
          leads: progress(row.targetLeads, mine.length),
          deals: progress(row.targetDeals, won),
          sales: progress(targetSales, round2(salesAmount)),
        },
        stats: {
          leads: mine.length,
          converted: mine.filter((lead) => lead.convertedOpportunityId).length,
          won,
          sales_amount: round2(salesAmount),
          cost_per_lead:
            budget !== null && mine.length
              ? round2(budget / mine.length)
              : null,
          sales_per_budget: budget ? round2(salesAmount / budget) : null,
        },
      };
    });
  }

  async create(dto: CreateCampaignDto, actor: Principal) {
    assertDates(dto.start_date, dto.end_date);
    const code = dto.code.trim().toUpperCase();
    const plan = await this.planFields(dto, actor.activeCompanyId);

    try {
      const row = (await this.campaigns.create({
        data: {
          companyId: actor.activeCompanyId,
          code,
          name: dto.name.trim(),
          channel: dto.channel?.trim() || null,
          startDate: toDate(dto.start_date) ?? null,
          endDate: toDate(dto.end_date) ?? null,
          budget: dto.budget ?? null,
          note: dto.note?.trim() || null,
          ...plan,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
      })) as { id: string };

      await this.audit.record({
        eventType: 'crm.campaign.created',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'campaign',
        resourceId: row.id,
        after: { code, name: dto.name, budget: dto.budget ?? null },
      });
      return row;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `รหัสแคมเปญ ${code} มีอยู่แล้ว`,
          [{ field: 'code', reason: 'duplicate' }],
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateCampaignDto, actor: Principal) {
    const found = (await this.campaigns.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as CampaignRow | null;
    // SCOPE-03: another company's campaign answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบแคมเปญนี้');

    assertDates(
      dto.start_date ?? date(found.startDate) ?? undefined,
      dto.end_date ?? date(found.endDate) ?? undefined,
    );
    if (
      dto.budget !== undefined &&
      (await this.budgetLines.findFirst({
        where: { campaignId: id },
        select: { id: true },
      }))
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'งบของแคมเปญนี้มาจากบรรทัดงบรายช่องทาง — แก้ที่แผนงบ',
        [{ field: 'budget', reason: 'from_budget_lines' }],
      );
    }
    const plan = await this.planFields(dto, actor.activeCompanyId);

    const updated = await this.campaigns.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.channel !== undefined
          ? { channel: dto.channel.trim() || null }
          : {}),
        ...(dto.start_date !== undefined
          ? { startDate: toDate(dto.start_date) ?? null }
          : {}),
        ...(dto.end_date !== undefined
          ? { endDate: toDate(dto.end_date) ?? null }
          : {}),
        ...(dto.budget !== undefined ? { budget: dto.budget } : {}),
        ...(dto.note !== undefined ? { note: dto.note.trim() || null } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...plan,
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.campaign.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'campaign',
      resourceId: id,
      before: {
        name: found.name,
        active: found.active,
        budget: found.budget?.toFixed(2) ?? null,
      },
      after: dto as unknown as Prisma.InputJsonValue,
    });
    return updated;
  }

  /**
   * CD-268 — the axis, receiving team and targets as columns; only the fields
   * the caller sent. The team must be an active unit of this company.
   */
  private async planFields(
    dto: CreateCampaignDto | UpdateCampaignDto,
    companyId: string,
  ) {
    const unitId =
      dto.receiving_org_unit_id === undefined
        ? undefined
        : dto.receiving_org_unit_id.trim() || null;
    if (unitId) {
      const unit = await this.orgUnits.findFirst({
        where: { id: unitId, companyId, active: true },
        select: { id: true },
      });
      if (!unit) {
        throw new AppError(
          'VALIDATION_FAILED',
          'ไม่พบทีมที่รับ Lead ในบริษัทนี้',
          [{ field: 'receiving_org_unit_id', reason: 'not_found' }],
        );
      }
    }
    return {
      ...(dto.sales_axis !== undefined
        ? { salesAxis: dto.sales_axis || null }
        : {}),
      ...(unitId !== undefined ? { receivingOrgUnitId: unitId } : {}),
      ...(dto.target_leads !== undefined
        ? { targetLeads: dto.target_leads }
        : {}),
      ...(dto.target_deals !== undefined
        ? { targetDeals: dto.target_deals }
        : {}),
      ...(dto.target_sales !== undefined
        ? { targetSales: dto.target_sales }
        : {}),
    };
  }

  /**
   * รหัส → id ของแคมเปญที่เปิดอยู่ในบริษัทนี้. `undefined` = ไม่ได้ส่งมา (ไม่แตะ),
   * `''` หรือ null = ล้าง (null). ไม่มี/ปิดแล้ว = VALIDATION_FAILED.
   */
  async resolveCode(
    code: string | null | undefined,
    companyId: string,
  ): Promise<string | null | undefined> {
    if (code === undefined) return undefined;
    // The lead form sends a cleared field as null — same meaning as ''.
    const wanted = (code ?? '').trim().toUpperCase();
    if (!wanted) return null;

    const found = (await this.campaigns.findFirst({
      where: { companyId, code: wanted },
      select: { id: true, active: true },
    })) as { id: string; active: boolean } | null;

    if (!found) {
      throw new AppError('VALIDATION_FAILED', `ไม่พบแคมเปญรหัส ${wanted}`, [
        { field: 'campaign_code', reason: 'not_found' },
      ]);
    }
    if (!found.active) {
      throw new AppError(
        'VALIDATION_FAILED',
        `แคมเปญ ${wanted} ปิดแล้ว — ผูก Lead ใหม่ไม่ได้`,
        [{ field: 'campaign_code', reason: 'inactive' }],
      );
    }
    return found.id;
  }
}

function assertDates(start?: string, end?: string) {
  if (start && end && start.slice(0, 10) > end.slice(0, 10)) {
    throw new AppError('VALIDATION_FAILED', 'วันเริ่มต้องไม่เกินวันจบ', [
      { field: 'start_date', reason: 'after_end' },
    ]);
  }
}
