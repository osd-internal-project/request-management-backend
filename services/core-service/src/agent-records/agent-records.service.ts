import { Injectable, Logger, type MessageEvent } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  PrismaTransactionService,
  toSkipTake,
  type Principal,
} from '@request-management/share';
import {
  exhaustMap,
  from,
  interval,
  map,
  mergeMap,
  startWith,
  takeUntil,
  takeWhile,
  timer,
  type Observable,
} from 'rxjs';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  readableActions,
  type AgentAction,
  type AgentRecordStatus,
} from './agent-actions';
import { AgentRecordRepository } from './agent-record.repository';
import type {
  CompleteAgentRecordDto,
  FindLeadsDto,
  ListAgentRecordsDto,
} from './dto/agent-record.dto';
import { VuvagentClient, VuvagentDispatchError } from './vuvagent.client';

const POLL_MS = 1_000;
/** Ticks between keep-alive events, so proxies do not cut an idle stream. */
const HEARTBEAT_TICKS = 15;
/** The page shows a warning after 10 minutes; nobody needs the stream past 15. */
const MAX_STREAM_MS = 15 * 60_000;

export interface AgentRecordStamp {
  id: string;
  status: string;
  updatedAt: Date;
}

const FINISHED: readonly string[] = [
  'done',
  'failed',
] satisfies AgentRecordStatus[];

/**
 * งานที่ส่งให้ AI agent ภายนอกทำในเบื้องหลัง (27 ต.ค. 2569). สร้างที่นี่,
 * ปิดงานโดย agent เองผ่าน external API. ทุกการอ่านผูกบริษัทที่ใช้งานอยู่และ
 * กรองเหลือเฉพาะ action ที่ผู้เรียกมีสิทธิ์ `read` (`AGENT_ACTIONS`) — แถวที่
 * มองไม่เห็นตอบ 404 (SCOPE-03).
 */
@Injectable()
export class AgentRecordsService {
  private readonly logger = new Logger(AgentRecordsService.name);

  constructor(
    private readonly records: AgentRecordRepository,
    private readonly members: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly vuvagent: VuvagentClient,
  ) {}

  findLeads(dto: FindLeadsDto, actor: Principal) {
    return this.start('lead.find', { topic: dto.topic.trim() }, actor);
  }

  async list(actor: Principal, query: ListAgentRecordsDto) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.AgentRecordWhereInput = {};
    if (query.status) filters.status = query.status;
    if (query.action) filters.action = query.action;
    // filters narrow inside the readable set, never widen it
    const where: Prisma.AgentRecordWhereInput = {
      AND: [this.visibleWhere(actor), filters],
    };

    const [rows, total] = await Promise.all([
      this.records.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }) as Promise<{ createdBy: string }[]>,
      this.records.count({ where }),
    ]);
    const names = await this.members.displayNamesOf(
      rows.map((row) => row.createdBy),
      actor.activeCompanyId,
    );

    return paginated(
      rows.map((row) => ({
        ...row,
        createdByName: names.get(row.createdBy) ?? null,
      })),
      query,
      total,
    );
  }

  async findOne(id: string, actor: Principal) {
    const found = (await this.records.findFirst({
      where: { id, ...this.visibleWhere(actor) },
    })) as
      ({ action: string; createdBy: string } & Record<string, unknown>) | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบงานของ agent ที่ระบุ');

    const names = await this.members.displayNamesOf(
      [found.createdBy],
      actor.activeCompanyId,
    );

    return { ...found, createdByName: names.get(found.createdBy) ?? null };
  }

  /** Pushes a row whenever its `updatedAt` moves; completes once all are finished. */
  watch(ids: string[], actor: Principal): Observable<MessageEvent> {
    const seen = new Map<string, number>();

    return interval(POLL_MS).pipe(
      startWith(-1),
      takeUntil(timer(MAX_STREAM_MS)),
      exhaustMap((tick) =>
        from(this.stamps(ids, actor)).pipe(map((rows) => ({ tick, rows }))),
      ),
      takeWhile(
        ({ rows }) => !rows.every((row) => FINISHED.includes(row.status)),
        true,
      ),
      mergeMap(({ tick, rows }): MessageEvent[] => {
        const changed = rows.filter(
          (row) => seen.get(row.id) !== row.updatedAt.getTime(),
        );
        changed.forEach((row) => seen.set(row.id, row.updatedAt.getTime()));
        if (changed.length) {
          return changed.map((row) => ({ type: 'record', data: row }));
        }
        return (tick + 1) % HEARTBEAT_TICKS === 0
          ? [{ type: 'ping', data: {} }]
          : [];
      }),
    );
  }

  /**
   * Record and audit commit first; the agent is called after, so its callback
   * can never arrive for a row that does not exist yet.
   */
  private async start(
    action: AgentAction,
    input: Prisma.InputJsonObject,
    actor: Principal,
  ) {
    const created = await this.transactions.execute(async (tx) => {
      const record = (await tx.agentRecord.create({
        data: {
          companyId: actor.activeCompanyId,
          action,
          input,
          createdBy: actor.userId,
        },
      })) as { id: string };
      await this.audit.record(
        {
          eventType: 'agent.record.started',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'agent_record',
          resourceId: record.id,
          after: { action, input },
        },
        { prisma: tx },
      );
      return record;
    });

    try {
      await this.vuvagent.dispatch(actor.activeCompanyId, action, {
        agent_record_id: created.id,
        ...input,
      });
    } catch (error) {
      if (!(error instanceof VuvagentDispatchError)) throw error;
      this.logger.warn(
        `dispatch ${action} ${created.id} failed: ${error.message}`,
      );
      return this.records.update({
        where: { id: created.id },
        data: {
          status: 'failed',
          error: `ส่งงานให้ agent ไม่สำเร็จ: ${error.message}`,
        },
      });
    }

    return this.records.findFirst({ where: { id: created.id } });
  }

  /**
   * The agent closes its job (external-service, key of the record's company).
   * One conditional update, so two callbacks cannot both finish the same row.
   * A row the timeout sweep closed (`timedOutAt`) still takes the agent's answer.
   */
  async complete(
    id: string,
    dto: CompleteAgentRecordDto,
    principal: Principal,
    companyId: string,
  ) {
    return this.transactions.execute(async (tx) => {
      const before = await tx.agentRecord.findFirst({
        where: { id, companyId },
        select: { status: true, timedOutAt: true },
      });
      if (!before) {
        throw new AppError('NOT_FOUND', 'ไม่พบงานของ agent ที่ระบุ');
      }
      const { count } = await tx.agentRecord.updateMany({
        where: {
          id,
          companyId,
          OR: [
            { status: 'processing' },
            { status: 'failed', timedOutAt: { not: null } },
          ],
        },
        data: {
          status: dto.status,
          result: dto.result as Prisma.InputJsonObject | undefined,
          error: dto.error?.trim() || null,
        },
      });
      if (count === 0) {
        throw new AppError('CONFLICT', 'งานนี้ปิดไปแล้ว', [
          { field: 'status', reason: before.status },
        ]);
      }
      await this.audit.record(
        {
          eventType: `agent.record.${dto.status}`,
          companyId,
          ...auditActor(principal),
          resourceType: 'agent_record',
          resourceId: id,
          before: {
            status: before.status,
            timedOutAt: before.timedOutAt?.toISOString() ?? null,
          },
          after: { status: dto.status, error: dto.error ?? null },
        },
        { prisma: tx },
      );
      return tx.agentRecord.findFirst({ where: { id } });
    });
  }

  private visibleWhere(actor: Principal): Prisma.AgentRecordWhereInput {
    return {
      companyId: actor.activeCompanyId,
      action: { in: readableActions(actor) },
    };
  }

  private stamps(ids: string[], actor: Principal) {
    return this.records.findMany({
      where: { id: { in: ids }, ...this.visibleWhere(actor) },
      select: { id: true, status: true, updatedAt: true },
    }) as Promise<AgentRecordStamp[]>;
  }
}
