import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import {
  AuditWriter,
  PrismaTransactionService,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { AGENT_ACTIONS, type AgentAction } from './agent-actions';
import { AgentRecordRepository } from './agent-record.repository';
import { parseEndpoints } from './outbound-connection';
import { OutboundConnectionRepository } from './outbound-connection.repository';

/** Rows closed per action per tick, so one tick never holds a long transaction. */
const BATCH = 100;

/**
 * Closes a record the agent never answered: `failed` with `timedOutAt`, after
 * the timeout its company set on the connection (or the action's default).
 * A late callback may still finish it (`AgentRecordsService.complete`).
 * Lives in the http module so only core-service runs it, not external-service.
 */
@Injectable()
export class AgentRecordTimeoutService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AgentRecordTimeoutService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly records: AgentRecordRepository,
    private readonly connections: OutboundConnectionRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('agentRecord.timeoutIntervalMs') ?? 0;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'agent record timeout', () => this.sweep()),
      interval,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Returns how many records it closed. Running it twice closes nothing new. */
  async sweep(now = new Date()): Promise<number> {
    const rows = (await this.connections.findMany({
      select: { companyId: true, vendor: true, endpoints: true },
    })) as { companyId: string; vendor: string; endpoints: unknown }[];

    let closed = 0;
    for (const action of Object.keys(AGENT_ACTIONS) as AgentAction[]) {
      const set = rows
        .filter((row) => row.vendor === AGENT_ACTIONS[action].vendor)
        .flatMap((row) => {
          const minutes = parseEndpoints(row.endpoints)[action]?.timeoutMinutes;
          return minutes ? [{ companyId: row.companyId, minutes }] : [];
        });
      for (const { companyId, minutes } of set) {
        closed += await this.close(action, minutes, now, { companyId });
      }
      closed += await this.close(
        action,
        AGENT_ACTIONS[action].defaultTimeoutMinutes,
        now,
        { companyId: { notIn: set.map((entry) => entry.companyId) } },
      );
    }
    return closed;
  }

  private async close(
    action: AgentAction,
    minutes: number,
    now: Date,
    company: Prisma.AgentRecordWhereInput,
  ): Promise<number> {
    const due = (await this.records.findMany({
      where: {
        ...company,
        action,
        status: 'processing',
        createdAt: { lt: new Date(now.getTime() - minutes * 60_000) },
      },
      select: { id: true, companyId: true },
      take: BATCH,
    })) as { id: string; companyId: string }[];

    let closed = 0;
    for (const row of due) {
      const done = await this.transactions.execute(async (tx) => {
        // conditional: a callback that landed meanwhile wins
        const { count } = await tx.agentRecord.updateMany({
          where: { id: row.id, status: 'processing' },
          data: {
            status: 'failed',
            timedOutAt: now,
            error: `agent ไม่ตอบกลับภายใน ${minutes} นาที`,
          },
        });
        if (count === 0) return false;
        await this.audit.record(
          {
            eventType: 'agent.record.timed_out',
            companyId: row.companyId,
            actorUsername: 'system',
            resourceType: 'agent_record',
            resourceId: row.id,
            before: { status: 'processing' },
            after: { status: 'failed', timeoutMinutes: minutes },
          },
          { prisma: tx },
        );
        return true;
      });
      if (done) closed += 1;
    }
    return closed;
  }
}
