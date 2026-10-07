import { Injectable } from '@nestjs/common';
import {
  BaseRepository,
  PrismaService,
  TQueryClient,
} from '@request-management/share';

/** CD-275 — a company's model and quota for one AI task. */
@Injectable()
export class LlmTaskSettingRepository extends BaseRepository<
  PrismaService['llmTaskSetting']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.llmTaskSetting;
  }
}

/** CD-275 — a model's price per 1,000 tokens. */
@Injectable()
export class LlmModelPriceRepository extends BaseRepository<
  PrismaService['llmModelPrice']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.llmModelPrice;
  }
}

/** CD-275 — one call through the gateway. */
@Injectable()
export class LlmCallRepository extends BaseRepository<
  PrismaService['llmCall']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.llmCall;
  }

  /** CD-279 — a company's calls older than its retention; returns how many. */
  async purgeBefore(companyId: string, cutoff: Date): Promise<number> {
    const { count } = await this.prisma.llmCall.deleteMany({
      where: { companyId, createdAt: { lt: cutoff } },
    });
    return count;
  }
}

/** CD-279 — one MCP tool call (who, which tool, which rows answered). */
@Injectable()
export class McpCallRepository extends BaseRepository<
  PrismaService['mcpCall']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.mcpCall;
  }

  /** A company's calls older than its retention; returns how many. */
  async purgeBefore(companyId: string, cutoff: Date): Promise<number> {
    const { count } = await this.prisma.mcpCall.deleteMany({
      where: { companyId, createdAt: { lt: cutoff } },
    });
    return count;
  }

  /** Every company that has logged an MCP or model call. */
  async companiesWithLogs(): Promise<string[]> {
    const [mcp, llm] = await Promise.all([
      this.prisma.mcpCall.findMany({
        distinct: ['companyId'],
        select: { companyId: true },
      }),
      this.prisma.llmCall.findMany({
        distinct: ['companyId'],
        select: { companyId: true },
      }),
    ]);
    return [...new Set([...mcp, ...llm].map((row) => row.companyId))];
  }
}

/** CD-279 — how long a company keeps its AI logs. */
@Injectable()
export class AiAuditPolicyRepository extends BaseRepository<
  PrismaService['aiAuditPolicy']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.aiAuditPolicy;
  }
}
