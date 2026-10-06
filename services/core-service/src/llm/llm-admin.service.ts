import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { modelFor, monthBounds, quotaShare } from './llm-rules';
import { LLM_TASKS, taskSpec } from './llm-tasks';
import {
  LlmCallRepository,
  LlmModelPriceRepository,
  LlmTaskSettingRepository,
} from './llm.repositories';
import { LlmService } from './llm.service';
import { SaveLlmPricesDto, UpdateLlmTaskDto } from './llm.dto';

interface CallRow {
  userId: string | null;
  task: string;
  model: string;
  totalTokens: number;
  costEstimate: unknown;
  status: string;
  durationMs: number;
  error: string | null;
  createdAt: Date;
}

const round4 = (value: number) => Math.round(value * 10000) / 10000;

/**
 * CD-275 — the LLM settings screen (`admin.llm.manage`): each AI task's model
 * and quota, model prices for the cost estimate, the month's usage, and a
 * test call through the gateway.
 */
@Injectable()
export class LlmAdminService {
  constructor(
    private readonly llm: LlmService,
    private readonly settings: LlmTaskSettingRepository,
    private readonly prices: LlmModelPriceRepository,
    private readonly calls: LlmCallRepository,
    private readonly people: CompanyMemberRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async view(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [rows, priceRows] = await Promise.all([
      this.settings.findMany({ where: { companyId } }) as Promise<
        {
          task: string;
          model: string | null;
          monthlyTokenQuota: number | null;
          enabled: boolean;
        }[]
      >,
      this.prices.findMany({
        where: { companyId },
        orderBy: { model: 'asc' },
      }) as Promise<
        { model: string; inputPer1k: unknown; outputPer1k: unknown }[]
      >,
    ]);
    const defaults = this.llm.defaults();
    const tasks = await Promise.all(
      LLM_TASKS.map(async (spec) => {
        const setting = rows.find((row) => row.task === spec.key) ?? null;
        const used = await this.llm.usedThisMonth(companyId, spec.key);
        const quota = setting?.monthlyTokenQuota ?? null;
        return {
          key: spec.key,
          kind: spec.kind,
          label: spec.label,
          model: modelFor(spec.kind, setting, defaults),
          model_setting: setting?.model ?? null,
          monthly_token_quota: quota,
          enabled: setting?.enabled ?? true,
          used_this_month: used,
          quota_share: quotaShare(used, quota),
        };
      }),
    );
    return {
      mode: this.llm.mode,
      defaults: {
        chat_model: defaults.chatModel,
        embed_model: defaults.embedModel,
      },
      tasks,
      prices: priceRows.map((row) => ({
        model: row.model,
        input_per_1k: Number(row.inputPer1k),
        output_per_1k: Number(row.outputPer1k),
      })),
    };
  }

  async updateTask(actor: Principal, task: string, dto: UpdateLlmTaskDto) {
    if (!taskSpec(task)) throw new AppError('NOT_FOUND', 'ไม่พบงาน AI นี้');
    const companyId = actor.activeCompanyId;
    const before = await this.settings.findFirst({
      where: { companyId, task },
    });
    const data = {
      ...(dto.model !== undefined ? { model: dto.model.trim() || null } : {}),
      ...(dto.monthly_token_quota !== undefined
        ? { monthlyTokenQuota: dto.monthly_token_quota }
        : {}),
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      updatedBy: actor.userId,
    };
    await this.settings.upsert({
      where: { companyId_task: { companyId, task } },
      create: { companyId, task, ...data },
      update: data,
    });
    await this.audit.record({
      eventType: 'admin.llm.task_updated',
      companyId,
      ...auditActor(actor),
      resourceType: 'llm_task',
      resourceId: task,
      before: before as never,
      after: dto as never,
    });
    return this.view(actor);
  }

  /** The whole price list — models left out are removed. */
  async savePrices(actor: Principal, dto: SaveLlmPricesDto) {
    const companyId = actor.activeCompanyId;
    const models = dto.prices.map((row) => row.model.trim());
    if (new Set(models).size !== models.length) {
      throw new AppError('VALIDATION_FAILED', 'มีชื่อโมเดลซ้ำ');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.llmModelPrice.deleteMany({
        where: { companyId, model: { notIn: models } },
      });
      for (const row of dto.prices) {
        const data = {
          inputPer1k: row.input_per_1k,
          outputPer1k: row.output_per_1k,
          updatedBy: actor.userId,
        };
        await prisma.llmModelPrice.upsert({
          where: { companyId_model: { companyId, model: row.model.trim() } },
          create: { companyId, model: row.model.trim(), ...data },
          update: data,
        });
      }
      await this.audit.record(
        {
          eventType: 'admin.llm.prices_saved',
          companyId,
          ...auditActor(actor),
          resourceType: 'llm_prices',
          resourceId: companyId,
          after: { prices: dto.prices } as never,
        },
        { prisma },
      );
    });
    return this.view(actor);
  }

  /** One Bangkok month of calls: totals, by task, by model, by person, latest calls. */
  async usage(actor: Principal, month?: string) {
    const companyId = actor.activeCompanyId;
    const at = month ? new Date(`${month}-15T00:00:00+07:00`) : new Date();
    const { start, end } = monthBounds(at);
    const rows = (await this.calls.findMany({
      where: { companyId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      take: 20000,
    })) as CallRow[];
    const group = (key: (row: CallRow) => string | null) => {
      const out = new Map<
        string,
        { calls: number; tokens: number; cost: number; errors: number }
      >();
      for (const row of rows) {
        const k = key(row) ?? '';
        const g = out.get(k) ?? { calls: 0, tokens: 0, cost: 0, errors: 0 };
        g.calls += 1;
        g.tokens += row.totalTokens;
        g.cost += Number(row.costEstimate ?? 0);
        if (row.status !== 'ok') g.errors += 1;
        out.set(k, g);
      }
      return [...out.entries()]
        .map(([k, g]) => ({ key: k || null, ...g, cost: round4(g.cost) }))
        .sort((a, b) => b.tokens - a.tokens);
    };
    const byUser = group((row) => row.userId);
    const names = await this.namesOf(byUser.map((row) => row.key));
    const latest = rows.slice(0, 50);
    return {
      month:
        month ??
        new Date(start.getTime() + 7 * 3_600_000).toISOString().slice(0, 7),
      totals: {
        calls: rows.length,
        tokens: rows.reduce((sum, row) => sum + row.totalTokens, 0),
        cost: round4(
          rows.reduce((sum, row) => sum + Number(row.costEstimate ?? 0), 0),
        ),
        errors: rows.filter((row) => row.status !== 'ok').length,
      },
      by_task: group((row) => row.task),
      by_model: group((row) => row.model),
      by_user: byUser.map((row) => ({
        ...row,
        name: row.key ? (names.get(row.key) ?? row.key) : null,
      })),
      latest: latest.map((row) => ({
        at: row.createdAt.toISOString(),
        task: row.task,
        model: row.model,
        user: row.userId ? (names.get(row.userId) ?? row.userId) : null,
        tokens: row.totalTokens,
        cost: row.costEstimate === null ? null : Number(row.costEstimate),
        duration_ms: row.durationMs,
        status: row.status,
        error: row.error,
      })),
    };
  }

  /** A real call through the gateway (task `admin.test`), to check the wiring. */
  async test(actor: Principal, prompt: string) {
    const result = await this.llm.chat(
      {
        companyId: actor.activeCompanyId,
        userId: actor.userId,
        task: 'admin.test',
      },
      [{ role: 'user', content: prompt }],
      { maxTokens: 300 },
    );
    return { mode: this.llm.mode, ...result };
  }

  private async namesOf(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
