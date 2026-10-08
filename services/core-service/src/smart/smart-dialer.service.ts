import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError, PrismaTransactionService } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import {
  CALL_OUTCOMES,
  type CallResult,
  DCALLCENTER_CLIENT,
  type DCallcenterClient,
} from '../integrations/dcallcenter/dcallcenter-client';
import { LlmService } from '../llm/llm.service';
import { STALE_CALL_MINUTES, targetAfterCall } from './call-rules';
import { SmartCallsService } from './smart-calls.service';
import { SmartHandoffService } from './smart-handoff.service';
import {
  SmartCallListRepository,
  SmartCallRepository,
  SmartCallTargetRepository,
  SmartProspectRepository,
} from './smart.repositories';

interface CallRow {
  id: string;
  companyId: string;
  listId: string;
  targetId: string;
  prospectId: string;
  phone: string;
  externalCallId: string | null;
  status: string;
  outcome: string | null;
  durationSec: number | null;
  transcript: string | null;
  recordingRef: string | null;
  summary: string | null;
  error: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

/**
 * CD-292 (CD-16 AI SMART) — dials the active call lists through D-Callcenter
 * and records how each call went.
 *
 * Every minute it takes, per company, what `SmartCallsService.callable` says
 * may be called now — the certified policy, the register, the hours, the
 * attempts — up to `smart.maxConcurrentCalls` at a time. An attempt counts
 * when it is dialled. The result (from the callback, or at once from the
 * mock) decides the target: an answer finishes it, a refusal blocks the
 * number everywhere, no answer leaves it for later. Interest marks the
 * prospect for CD-293. D-Callcenter's outcome is the outcome; the model only
 * summarises the transcript for sales.
 */
@Injectable()
export class SmartDialerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmartDialerService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly lists: SmartCallListRepository,
    private readonly targets: SmartCallTargetRepository,
    private readonly calls: SmartCallRepository,
    private readonly prospects: SmartProspectRepository,
    private readonly callLists: SmartCallsService,
    private readonly handoff: SmartHandoffService,
    private readonly llm: LlmService,
    private readonly transactions: PrismaTransactionService,
    private readonly config: ConfigService,
    @Inject(DCALLCENTER_CLIENT) private readonly callcenter: DCallcenterClient,
  ) {}

  onModuleInit(): void {
    const interval = this.config.get<number>('smart.dialIntervalMs') ?? 60_000;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-292 AI SMART dialler', () =>
        this.dialDue(),
      ),
      interval,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One round: give up stale calls, then dial what may be dialled. */
  async dialDue(now = new Date()) {
    if (this.running) return { dialled: 0 };
    this.running = true;
    try {
      await this.giveUpStale(now);
      const active = (await this.lists.findMany({
        where: { status: 'active' },
        select: { id: true, companyId: true },
        orderBy: { createdAt: 'asc' },
      })) as { id: string; companyId: string }[];
      const cap = this.config.get<number>('smart.maxConcurrentCalls') ?? 5;
      const inFlight = new Map<string, number>();
      let dialled = 0;
      for (const list of active) {
        if (!inFlight.has(list.companyId)) {
          inFlight.set(
            list.companyId,
            await this.calls.count({
              where: { companyId: list.companyId, status: 'dialling' },
            }),
          );
        }
        const room = cap - (inFlight.get(list.companyId) ?? 0);
        if (room <= 0) continue;
        const callable = await this.callLists.callable(
          list.companyId,
          list.id,
          now,
        );
        for (const target of callable.slice(0, room)) {
          await this.dial(list.companyId, list.id, target, now);
          inFlight.set(list.companyId, (inFlight.get(list.companyId) ?? 0) + 1);
          dialled += 1;
        }
      }
      return { dialled };
    } finally {
      this.running = false;
    }
  }

  /**
   * A result from D-Callcenter (the callback, or the mock). Idempotent: a
   * call already completed answers with what it already holds.
   */
  async recordResult(companyId: string, result: CallResult) {
    if (!(CALL_OUTCOMES as readonly string[]).includes(result.outcome)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ผลการโทรไม่รู้จัก: ${result.outcome}`,
      );
    }
    const call = await this.calls.findFirst({
      where: { externalCallId: result.callId, companyId },
    });
    if (!call) throw new AppError('NOT_FOUND', 'ไม่พบสายที่อ้างถึง');
    if (call.status !== 'dialling') return this.view(call);

    const plan = await this.callLists.dialPlan(companyId, call.listId);
    const target = (await this.targets.findFirst({
      where: { id: call.targetId, companyId },
      select: { attempts: true },
    })) as { attempts: number } | null;
    const next = targetAfterCall(
      result.outcome,
      target?.attempts ?? 1,
      plan?.maxAttempts ?? 3,
    );
    const now = new Date();

    const updated = await this.transactions.execute(async (prisma) => {
      const row = await this.calls.update(
        {
          where: { id: call.id },
          data: {
            status: result.outcome === 'failed' ? 'failed' : 'completed',
            outcome: result.outcome,
            durationSec: result.durationSec ?? null,
            transcript: result.transcript ?? null,
            recordingRef: result.recordingRef ?? null,
            endedAt: now,
          },
        },
        { prisma },
      );
      await this.targets.update(
        {
          where: { id: call.targetId },
          data: {
            status: next.status,
            lastOutcome: result.outcome,
            ...(next.blockReason ? { blockReason: next.blockReason } : {}),
          },
        },
        { prisma },
      );
      await this.prospects.update(
        {
          where: { id: call.prospectId },
          data: {
            lastCallId: call.id,
            ...(result.outcome === 'interested' ? { interestedAt: now } : {}),
          },
        },
        { prisma },
      );
      return row;
    });

    // The register is written outside the call's transaction: it is its own
    // audited record, and the number must stop on every list, not this one.
    if (result.outcome === 'refused') {
      await this.callLists.refuse(companyId, call.targetId, null);
    }
    if (
      result.transcript &&
      this.config.get<string>('llm.mode') === 'gateway'
    ) {
      await this.summarise(companyId, updated, result.transcript);
    }
    // CD-293 — real interest goes to its sales axis at once (after the
    // summary, so the handoff carries it)
    if (result.outcome === 'interested') {
      await this.handoff.afterInterest(companyId, call.prospectId, call.listId);
    }
    return this.view(updated);
  }

  /** The calls made on one list, newest first. */
  async history(actor: Principal, listId: string) {
    const rows = (await this.calls.findMany({
      where: { companyId: actor.activeCompanyId, listId },
      orderBy: { startedAt: 'desc' },
      take: 200,
    })) as CallRow[];
    return rows.map((row) => this.view(row));
  }

  async call(actor: Principal, id: string) {
    const row = await this.calls.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    });
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบสายที่ระบุ');
    return this.view(row);
  }

  // --- helpers ----------------------------------------------------------------

  private async dial(
    companyId: string,
    listId: string,
    target: { id: string; prospectId: string; phone: string; attempts: number },
    now: Date,
  ) {
    const plan = await this.callLists.dialPlan(companyId, listId);
    if (!plan) return;
    const call = await this.transactions.execute(async (prisma) => {
      await this.targets.update(
        {
          where: { id: target.id },
          data: { attempts: target.attempts + 1, lastAttemptAt: now },
        },
        { prisma },
      );
      return this.calls.create(
        {
          data: {
            companyId,
            listId,
            targetId: target.id,
            prospectId: target.prospectId,
            phone: target.phone,
          },
        },
        { prisma },
      );
    });
    try {
      const placed = await this.callcenter.placeCall({
        ref: call.id,
        to: target.phone,
        opening: plan.opening,
        script: plan.script,
      });
      await this.calls.update({
        where: { id: call.id },
        data: { externalCallId: placed.callId },
      });
      if (placed.result) await this.recordResult(companyId, placed.result);
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn(`dial ${call.id} failed: ${message}`);
      await this.calls.update({
        where: { id: call.id },
        data: {
          status: 'failed',
          outcome: 'failed',
          error: message.slice(0, 1000),
          endedAt: new Date(),
        },
      });
      const next = targetAfterCall(
        'failed',
        target.attempts + 1,
        plan.maxAttempts,
      );
      await this.targets.update({
        where: { id: target.id },
        data: { status: next.status, lastOutcome: 'failed' },
      });
    }
  }

  /** A call D-Callcenter never reported on is failed, so its target moves on. */
  private async giveUpStale(now: Date) {
    const before = new Date(now.getTime() - STALE_CALL_MINUTES * 60_000);
    const stale = (await this.calls.findMany({
      where: { status: 'dialling', startedAt: { lt: before } },
      select: {
        id: true,
        companyId: true,
        externalCallId: true,
        targetId: true,
      },
      take: 200,
    })) as {
      id: string;
      companyId: string;
      externalCallId: string | null;
      targetId: string;
    }[];
    for (const row of stale) {
      if (row.externalCallId) {
        await this.recordResult(row.companyId, {
          callId: row.externalCallId,
          outcome: 'failed',
        }).catch(() => undefined);
      } else {
        await this.calls.update({
          where: { id: row.id },
          data: {
            status: 'failed',
            outcome: 'failed',
            error: 'ไม่ได้รับผลจาก D-Callcenter',
            endedAt: now,
          },
        });
      }
    }
  }

  private async summarise(
    companyId: string,
    call: CallRow,
    transcript: string,
  ) {
    try {
      const reply = await this.llm.chat(
        { companyId, task: 'smart.call' },
        [
          {
            role: 'system',
            content:
              'สรุปบทสนทนาการโทรขายให้ทีมขาย B2B เป็นภาษาไทย 2–3 บรรทัด: ลูกค้าสนใจอะไร ' +
              'ติดขัดอะไร และควรติดตามอย่างไร ห้ามเติมข้อมูลที่ไม่มีในบทสนทนา',
          },
          { role: 'user', content: transcript.slice(0, 8000) },
        ],
        { maxTokens: 300 },
      );
      await this.calls.update({
        where: { id: call.id },
        data: { summary: reply.text.trim().slice(0, 2000) || null },
      });
    } catch (error) {
      this.logger.warn(
        `smart.call summary skipped: ${(error as Error).message}`,
      );
    }
  }

  private view(row: CallRow) {
    return {
      id: row.id,
      list_id: row.listId,
      target_id: row.targetId,
      prospect_id: row.prospectId,
      phone: row.phone,
      status: row.status,
      outcome: row.outcome,
      duration_sec: row.durationSec,
      transcript: row.transcript,
      recording_ref: row.recordingRef,
      summary: row.summary,
      error: row.error,
      started_at: row.startedAt,
      ended_at: row.endedAt,
    };
  }
}
