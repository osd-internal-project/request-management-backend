import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { thaiToday } from '../crm/vendor-costs';
import {
  CampaignBudgetLineRepository,
  CampaignRepository,
  CampaignSpendRepository,
} from '../crm/sales.repositories';
import {
  lineProblems,
  overBudget,
  plannedTotal,
  spendProblems,
  spentByLine,
  spentTotal,
} from './campaign-plan-rules';
import {
  AddCampaignSpendDto,
  SaveBudgetLinesDto,
  VoidCampaignSpendDto,
} from './macom.dto';

interface LineRow {
  id: string;
  channel: string;
  planned: Prisma.Decimal;
  note: string | null;
  sortOrder: number;
}

export interface SpendRow {
  id: string;
  companyId: string;
  campaignId: string;
  budgetLineId: string | null;
  spentOn: Date;
  amount: Prisma.Decimal;
  vendor: string | null;
  note: string | null;
  receiptKey: string | null;
  receiptName: string | null;
  receiptType: string | null;
  voidedAt: Date | null;
  voidedBy: string | null;
  voidReason: string | null;
  createdAt: Date;
  createdBy: string | null;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`);

/**
 * CD-268 — แผนงบของแคมเปญ: งบรายช่องทาง และค่าใช้จ่ายจริงพร้อมใบเสร็จ.
 *
 * งบรวมของแคมเปญ (`campaigns.budget`, ตัวที่ CD-71 ใช้คิดต้นทุนต่อ Lead) เขียนจาก
 * ผลรวมบรรทัดทุกครั้งที่บันทึกแผน — หน้าแก้แคมเปญจึงแก้งบตรง ๆ ไม่ได้อีกเมื่อมีบรรทัด.
 * ค่าใช้จ่ายไม่ลบ: ยกเลิกพร้อมเหตุผล เพื่อให้ตัวเลขย้อนหลังตรวจได้.
 */
@Injectable()
export class CampaignPlanService {
  constructor(
    private readonly campaigns: CampaignRepository,
    private readonly lines: CampaignBudgetLineRepository,
    private readonly spends: CampaignSpendRepository,
    private readonly people: CompanyMemberRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async plan(actor: Principal, campaignId: string) {
    const campaign = await this.requireCampaign(actor, campaignId);
    const [lines, spends] = await Promise.all([
      this.lines.findMany({
        where: { campaignId },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }) as Promise<LineRow[]>,
      this.spends.findMany({
        where: { campaignId },
        orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
      }) as Promise<SpendRow[]>,
    ]);
    const facts = spends.map((spend) => ({
      budgetLineId: spend.budgetLineId,
      amount: Number(spend.amount),
      voided: spend.voidedAt !== null,
    }));
    const byLine = spentByLine(facts);
    const planned = lines.length
      ? plannedTotal(
          lines.map((line) => ({ id: line.id, planned: Number(line.planned) })),
        )
      : campaign.budget === null
        ? null
        : Number(campaign.budget);
    const spent = spentTotal(facts);
    const names = await this.names(
      spends.flatMap((spend) => [spend.createdBy, spend.voidedBy]),
    );
    const channelOf = new Map(lines.map((line) => [line.id, line.channel]));

    return {
      campaign: {
        id: campaign.id,
        code: campaign.code,
        name: campaign.name,
        active: campaign.active,
      },
      planned_total: planned,
      spent_total: spent,
      remaining:
        planned === null ? null : Math.round((planned - spent) * 100) / 100,
      over_budget: overBudget(planned, spent),
      unassigned_spent: byLine.get('') ?? 0,
      lines: lines.map((line) => {
        const used = byLine.get(line.id) ?? 0;
        const linePlanned = Number(line.planned);
        return {
          id: line.id,
          channel: line.channel,
          planned: linePlanned,
          note: line.note,
          spent: used,
          over_budget: overBudget(linePlanned, used),
        };
      }),
      spends: spends.map((spend) => ({
        id: spend.id,
        spent_on: day(spend.spentOn),
        amount: Number(spend.amount),
        budget_line: spend.budgetLineId
          ? {
              id: spend.budgetLineId,
              channel: channelOf.get(spend.budgetLineId) ?? '—',
            }
          : null,
        vendor: spend.vendor,
        note: spend.note,
        receipt_name: spend.receiptName,
        created_by: spend.createdBy
          ? (names.get(spend.createdBy) ?? spend.createdBy)
          : null,
        created_at: spend.createdAt.toISOString(),
        voided: spend.voidedAt !== null,
        void_reason: spend.voidReason,
        voided_by: spend.voidedBy
          ? (names.get(spend.voidedBy) ?? spend.voidedBy)
          : null,
      })),
    };
  }

  /**
   * Replace the campaign's budget lines with the set given. A line that has
   * spend against it cannot be dropped — move or void the spend first.
   */
  async saveLines(
    actor: Principal,
    campaignId: string,
    dto: SaveBudgetLinesDto,
  ) {
    const campaign = await this.requireCampaign(actor, campaignId);
    const wanted = dto.lines.map((line) => ({
      id: line.id,
      channel: line.channel.trim(),
      planned: line.planned,
      note: line.note?.trim() || null,
    }));
    const problems = lineProblems(wanted);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'lines', reason })),
      );
    }
    const current = (await this.lines.findMany({
      where: { campaignId },
      select: { id: true, channel: true, planned: true },
    })) as { id: string; channel: string; planned: Prisma.Decimal }[];
    const known = new Set(current.map((line) => line.id));
    const unknown = wanted.find((line) => line.id && !known.has(line.id));
    if (unknown) {
      throw new AppError('NOT_FOUND', 'ไม่พบบรรทัดงบนี้ในแคมเปญ', [
        { field: 'lines', reason: unknown.id as string },
      ]);
    }
    const kept = new Set(wanted.flatMap((line) => (line.id ? [line.id] : [])));
    const dropped = current.filter((line) => !kept.has(line.id));
    if (dropped.length) {
      const used = (await this.spends.findFirst({
        where: {
          budgetLineId: { in: dropped.map((line) => line.id) },
          voidedAt: null,
        },
        select: { budgetLineId: true },
      })) as { budgetLineId: string } | null;
      if (used) {
        const channel = dropped.find(
          (line) => line.id === used.budgetLineId,
        )?.channel;
        throw new AppError(
          'CONFLICT',
          `บรรทัด ${channel ?? ''} มีค่าใช้จ่ายแล้ว — ลบไม่ได้ (ยกเลิกค่าใช้จ่ายก่อน)`,
        );
      }
    }
    const total = wanted.length
      ? plannedTotal(
          wanted.map((line, index) => ({
            id: line.id ?? String(index),
            planned: line.planned,
          })),
        )
      : null;

    await this.transactions.execute(async (prisma) => {
      if (dropped.length) {
        // voided spend on a dropped line keeps its history, line-less
        await prisma.campaignSpend.updateMany({
          where: { budgetLineId: { in: dropped.map((line) => line.id) } },
          data: { budgetLineId: null },
        });
        await prisma.campaignBudgetLine.deleteMany({
          where: { id: { in: dropped.map((line) => line.id) } },
        });
      }
      for (const [index, line] of wanted.entries()) {
        if (line.id) {
          await prisma.campaignBudgetLine.update({
            where: { id: line.id },
            data: {
              channel: line.channel,
              planned: line.planned,
              note: line.note,
              sortOrder: index,
              updatedBy: actor.userId,
            },
          });
        } else {
          await prisma.campaignBudgetLine.create({
            data: {
              companyId: campaign.companyId,
              campaignId,
              channel: line.channel,
              planned: line.planned,
              note: line.note,
              sortOrder: index,
              createdBy: actor.userId,
              updatedBy: actor.userId,
            },
          });
        }
      }
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { budget: total, updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'macom.campaign.budget_saved',
          companyId: campaign.companyId,
          ...auditActor(actor),
          resourceType: 'campaign',
          resourceId: campaignId,
          before: {
            budget: campaign.budget?.toFixed(2) ?? null,
            lines: current.map((line) => ({
              channel: line.channel,
              planned: line.planned.toFixed(2),
            })),
          },
          after: {
            budget: total,
            lines: wanted.map((line) => ({
              channel: line.channel,
              planned: line.planned,
            })),
          },
        },
        { prisma },
      );
    });
    return this.plan(actor, campaignId);
  }

  async addSpend(
    actor: Principal,
    campaignId: string,
    dto: AddCampaignSpendDto,
  ) {
    const campaign = await this.requireCampaign(actor, campaignId);
    const problems = spendProblems({
      amount: dto.amount,
      spentOn: dto.spent_on.slice(0, 10),
      today: thaiToday(),
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'spend', reason })),
      );
    }
    if (dto.budget_line_id) {
      const line = await this.lines.findFirst({
        where: { id: dto.budget_line_id, campaignId },
        select: { id: true },
      });
      if (!line) {
        throw new AppError('NOT_FOUND', 'ไม่พบบรรทัดงบนี้ในแคมเปญ', [
          { field: 'budget_line_id', reason: dto.budget_line_id },
        ]);
      }
    }
    const row = (await this.transactions.execute(async (prisma) => {
      const created = await prisma.campaignSpend.create({
        data: {
          companyId: campaign.companyId,
          campaignId,
          budgetLineId: dto.budget_line_id || null,
          spentOn: asDate(dto.spent_on),
          amount: dto.amount,
          vendor: dto.vendor?.trim() || null,
          note: dto.note?.trim() || null,
          createdBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'macom.campaign.spend_added',
          companyId: campaign.companyId,
          ...auditActor(actor),
          resourceType: 'campaign',
          resourceId: campaignId,
          after: {
            spendId: created.id,
            amount: dto.amount,
            spentOn: dto.spent_on.slice(0, 10),
            budgetLineId: dto.budget_line_id || null,
          },
        },
        { prisma },
      );
      return created;
    })) as { id: string };
    return { id: row.id, plan: await this.plan(actor, campaignId) };
  }

  async voidSpend(
    actor: Principal,
    spendId: string,
    dto: VoidCampaignSpendDto,
  ) {
    const spend = await this.requireSpend(actor, spendId);
    if (spend.voidedAt) {
      throw new AppError('CONFLICT', 'รายการนี้ถูกยกเลิกแล้ว');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.campaignSpend.update({
        where: { id: spendId },
        data: {
          voidedAt: new Date(),
          voidedBy: actor.userId,
          voidReason: dto.reason.trim(),
        },
      });
      await this.audit.record(
        {
          eventType: 'macom.campaign.spend_voided',
          companyId: spend.companyId,
          ...auditActor(actor),
          resourceType: 'campaign',
          resourceId: spend.campaignId,
          before: { spendId, amount: spend.amount.toFixed(2) },
          after: { reason: dto.reason.trim() },
        },
        { prisma },
      );
    });
    return this.plan(actor, spend.campaignId);
  }

  /** One spend of the caller's company (404 for another company's). */
  async requireSpend(actor: Principal, spendId: string): Promise<SpendRow> {
    const spend = (await this.spends.findFirst({
      where: { id: spendId, companyId: actor.activeCompanyId },
    })) as SpendRow | null;
    if (!spend) throw new AppError('NOT_FOUND', 'ไม่พบรายการค่าใช้จ่ายนี้');
    return spend;
  }

  private async requireCampaign(actor: Principal, campaignId: string) {
    const campaign = (await this.campaigns.findFirst({
      where: { id: campaignId, companyId: actor.activeCompanyId },
      select: {
        id: true,
        companyId: true,
        code: true,
        name: true,
        active: true,
        budget: true,
      },
    })) as {
      id: string;
      companyId: string;
      code: string;
      name: string;
      active: boolean;
      budget: Prisma.Decimal | null;
    } | null;
    // SCOPE-03: another company's campaign answers 404.
    if (!campaign) throw new AppError('NOT_FOUND', 'ไม่พบแคมเปญนี้');
    return campaign;
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
