import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  AuditWriter,
  auditActor,
  paginated,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { IntegrationCallRepository } from '../principal/integration-call.repository';
import { backgroundTick } from '../common/background-tick';
import { DEFAULT_RETENTION_DAYS, retentionCutoff } from './ai-audit-rules';
import { AiAuditSearchDto, SaveAiAuditPolicyDto } from './ai-audit.dto';
import { LLM_TASKS } from './llm-tasks';
import {
  AiAuditPolicyRepository,
  LlmCallRepository,
  McpCallRepository,
} from './llm.repositories';

interface McpRow {
  id: string;
  userId: string | null;
  viaServiceAccount: boolean;
  tool: string;
  isWrite: boolean;
  args: unknown;
  resultIds: string[];
  resultCount: number;
  status: string;
  errorCode: string | null;
  durationMs: number;
  createdAt: Date;
}

interface LlmRow {
  id: string;
  userId: string | null;
  task: string;
  kind: string;
  model: string;
  totalTokens: number;
  costEstimate: unknown;
  status: string;
  error: string | null;
  durationMs: number;
  createdAt: Date;
}

const DAY_MS = 86_400_000;

/**
 * CD-279 — the AI audit screen (`admin.ai.audit`): every MCP tool call and
 * every model call of the company, searched by person, time and tool/task,
 * and the retention policy that a daily sweep enforces.
 *
 * The sweep deletes log rows — a declared exception to "no hard deletes"
 * (AGENTS.md): the rows are an access log, and keeping them only as long as
 * the company's policy says is what the policy is for.
 */
@Injectable()
export class AiAuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiAuditService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly mcpCalls: McpCallRepository,
    private readonly llmCalls: LlmCallRepository,
    private readonly integrationCalls: IntegrationCallRepository,
    private readonly policies: AiAuditPolicyRepository,
    private readonly people: CompanyMemberRepository,
    private readonly config: ConfigService,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('llm.auditSweepIntervalMs') ?? DAY_MS;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-279 AI audit retention', () =>
        this.sweep(),
      ),
      interval,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async mcp(actor: Principal, query: AiAuditSearchDto) {
    const where: Prisma.McpCallWhereInput = {
      ...this.common(actor, query),
      ...(query.name ? { tool: query.name } : {}),
    };
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      this.mcpCalls.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }) as Promise<McpRow[]>,
      this.mcpCalls.count({ where }),
    ]);
    const names = await this.names(rows.map((row) => row.userId));
    return paginated(
      rows.map((row) => ({
        id: row.id,
        at: row.createdAt,
        user: this.person(row.userId, names),
        via_service_account: row.viaServiceAccount,
        tool: row.tool,
        is_write: row.isWrite,
        args: row.args,
        result_ids: row.resultIds,
        result_count: row.resultCount,
        status: row.status,
        error_code: row.errorCode,
        duration_ms: row.durationMs,
      })),
      query,
      total,
    );
  }

  async llm(actor: Principal, query: AiAuditSearchDto) {
    const where: Prisma.LlmCallWhereInput = {
      ...this.common(actor, query),
      ...(query.name ? { task: query.name } : {}),
    };
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      this.llmCalls.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }) as Promise<LlmRow[]>,
      this.llmCalls.count({ where }),
    ]);
    const names = await this.names(rows.map((row) => row.userId));
    return paginated(
      rows.map((row) => ({
        id: row.id,
        at: row.createdAt,
        user: this.person(row.userId, names),
        task: row.task,
        kind: row.kind,
        model: row.model,
        total_tokens: row.totalTokens,
        cost_estimate:
          row.costEstimate === null ? null : Number(row.costEstimate),
        status: row.status,
        error: row.error,
        duration_ms: row.durationMs,
      })),
      query,
      total,
    );
  }

  /** What the search boxes offer: the tools and tasks seen, and the people. */
  async filters(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [tools, mcpPeople, llmPeople] = await Promise.all([
      this.mcpCalls.findMany({
        where: { companyId },
        distinct: ['tool'],
        select: { tool: true },
        orderBy: { tool: 'asc' },
      }) as Promise<{ tool: string }[]>,
      this.mcpCalls.findMany({
        where: { companyId, userId: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
      }) as Promise<{ userId: string }[]>,
      this.llmCalls.findMany({
        where: { companyId, userId: { not: null } },
        distinct: ['userId'],
        select: { userId: true },
      }) as Promise<{ userId: string }[]>,
    ]);
    const ids = [...mcpPeople, ...llmPeople].map((row) => row.userId);
    const names = await this.names(ids);
    return {
      tools: tools.map((row) => row.tool),
      tasks: LLM_TASKS.map((task) => ({ key: task.key, label: task.label })),
      people: [...names.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'th')),
    };
  }

  async policy(actor: Principal) {
    const row = (await this.policies.findFirst({
      where: { companyId: actor.activeCompanyId },
    })) as { retentionDays: number; updatedAt: Date } | null;
    return {
      retention_days: row?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      updated_at: row?.updatedAt ?? null,
    };
  }

  async savePolicy(actor: Principal, dto: SaveAiAuditPolicyDto) {
    const companyId = actor.activeCompanyId;
    const before = await this.policy(actor);
    await this.transactions.execute(async (prisma) => {
      await this.policies.upsert(
        {
          where: { companyId },
          create: {
            companyId,
            retentionDays: dto.retention_days,
            updatedBy: actor.userId,
          },
          update: {
            retentionDays: dto.retention_days,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'ai.audit.policy.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'ai_audit_policy',
          resourceId: companyId,
          before: { retentionDays: before.retention_days },
          after: { retentionDays: dto.retention_days },
        },
        { prisma },
      );
    });
    return this.policy(actor);
  }

  /** Removes each company's logs older than its retention. */
  async sweep(now = new Date()) {
    const companies = await this.mcpCalls.companiesWithLogs();
    let removed = 0;
    for (const companyId of companies) {
      const row = (await this.policies.findFirst({
        where: { companyId },
      })) as { retentionDays: number } | null;
      const cutoff = retentionCutoff(
        row?.retentionDays ?? DEFAULT_RETENTION_DAYS,
        now,
      );
      const [mcp, llm, api] = await Promise.all([
        this.mcpCalls.purgeBefore(companyId, cutoff),
        this.llmCalls.purgeBefore(companyId, cutoff),
        this.integrationCalls.purgeBefore(companyId, cutoff),
      ]);
      if (mcp + llm + api > 0) {
        this.logger.log(
          `AI audit retention: ${companyId} removed ${mcp} MCP + ${llm} model + ${api} integration calls before ${cutoff.toISOString()}`,
        );
      }
      removed += mcp + llm + api;
    }
    // คำขอที่ไม่รู้บริษัท (key ข้ามบริษัทที่ถูกปัดก่อนเลือกบริษัท) ไม่มี policy ให้อ่าน
    removed += await this.integrationCalls.purgeBefore(
      null,
      retentionCutoff(DEFAULT_RETENTION_DAYS, now),
    );
    return { removed };
  }

  // --- helpers ----------------------------------------------------------------

  /** Company, person, status and the day range (`to` inclusive). */
  private common(actor: Principal, query: AiAuditSearchDto) {
    const createdAt: { gte?: Date; lt?: Date } = {};
    if (query.from)
      createdAt.gte = new Date(`${query.from.slice(0, 10)}T00:00:00+07:00`);
    if (query.to) {
      createdAt.lt = new Date(
        new Date(`${query.to.slice(0, 10)}T00:00:00+07:00`).getTime() + DAY_MS,
      );
    }
    return {
      companyId: actor.activeCompanyId,
      ...(query.user_id ? { userId: query.user_id } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(createdAt.gte || createdAt.lt ? { createdAt } : {}),
    };
  }

  private person(userId: string | null, names: Map<string, string>) {
    return userId ? { id: userId, name: names.get(userId) ?? null } : null;
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
