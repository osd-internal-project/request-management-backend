import { Injectable, Logger } from '@nestjs/common';
import { auditArgs, auditResult, isWriteTool } from './ai-audit-rules';
import { McpCallRepository } from './llm.repositories';

/** One MCP tool call, as the MCP door saw it. */
export interface McpCallEntry {
  companyId: string;
  /** The person it was done as; null when identity could not be resolved. */
  userId: string | null;
  viaServiceAccount: boolean;
  tool: string;
  args: Record<string, unknown>;
  /** The answer as sent (masked and linked) — read for ids and a count only. */
  result?: unknown;
  /** The `AppError` code when the call failed. */
  errorCode?: string;
  durationMs: number;
}

/**
 * CD-279 — writes the AI audit log's MCP half. external-service's MCP door
 * calls this once per tool call; model calls are logged by `LlmService`.
 *
 * Never fails the call it describes: a log that cannot be written is a
 * warning here, not an error in somebody's chat.
 */
@Injectable()
export class McpCallLogService {
  private readonly logger = new Logger(McpCallLogService.name);

  constructor(private readonly calls: McpCallRepository) {}

  async record(entry: McpCallEntry): Promise<void> {
    const failed = entry.errorCode !== undefined;
    const answered = failed ? { ids: [], count: 0 } : auditResult(entry.result);
    try {
      await this.calls.create({
        data: {
          companyId: entry.companyId,
          userId: entry.userId,
          viaServiceAccount: entry.viaServiceAccount,
          tool: entry.tool,
          isWrite: isWriteTool(entry.tool),
          args: auditArgs(entry.tool, entry.args) as never,
          resultIds: answered.ids,
          resultCount: answered.count,
          status: failed ? 'error' : 'ok',
          errorCode: entry.errorCode ?? null,
          durationMs: Math.max(0, Math.round(entry.durationMs)),
        },
      });
    } catch (error) {
      this.logger.warn(
        `MCP call not logged (${entry.tool}): ${(error as Error).message}`,
      );
    }
  }
}
