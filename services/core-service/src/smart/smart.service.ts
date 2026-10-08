import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestRepository } from '../requests/request.repository';
import { SmartIngestService, type SourceRow } from './smart-ingest.service';
import type { FoundProspect } from './smart-rules';
import { isConnectorKind } from './smart-rules';
import { SmartSweepService } from './smart-sweep.service';
import {
  DiscardProspectDto,
  FoundProspectDto,
  ListProspectsQueryDto,
  SaveSmartSourceDto,
} from './smart.dto';
import {
  SmartProspectRepository,
  SmartSourceRepository,
  SmartSweepRunRepository,
} from './smart.repositories';

/** A vendor's or a file's row, in the shape the rules read. */
export function toFound(row: FoundProspectDto): FoundProspect {
  return {
    externalRef: row.external_ref,
    name: row.name,
    taxId: row.tax_id,
    phone: row.phone,
    email: row.email,
    website: row.website,
    industry: row.industry,
    province: row.province,
    registeredCapital: row.registered_capital,
    salesAxis: row.sales_axis,
    evidence: row.evidence,
  };
}

interface ProspectRow {
  id: string;
  sourceId: string;
  runId: string | null;
  externalRef: string;
  name: string;
  taxId: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  industry: string | null;
  province: string | null;
  registeredCapital: unknown;
  salesAxis: string | null;
  evidence: unknown;
  status: string;
  discardReason: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  score: number | null;
  scoreReasons: unknown;
  aiSummary: string | null;
  matchKind: string | null;
  matchCustomerId: string | null;
  matchLeadId: string | null;
  screenedAt: Date | null;
  leadId: string | null;
  sentOutcome: string | null;
  sentAt: Date | null;
  interestedAt: Date | null;
  lastCallId: string | null;
  handoffAxis: string | null;
  handoffRequestId: string | null;
  handedOffAt: Date | null;
  handoffError: string | null;
  keeperOpportunityId: string | null;
}

/**
 * CD-289 (CD-16 AI SMART) — the screens behind "แหล่งกวาด Lead": sources
 * and their sweeps, file imports, and the staging list of what was found.
 * Every read is pinned to the active company; another company's row is 404.
 */
@Injectable()
export class SmartService {
  constructor(
    private readonly sources: SmartSourceRepository,
    private readonly runs: SmartSweepRunRepository,
    private readonly prospects: SmartProspectRepository,
    private readonly ingest: SmartIngestService,
    private readonly sweep: SmartSweepService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly requestRows: RequestRepository,
  ) {}

  // --- sources -----------------------------------------------------------------

  async listSources(actor: Principal) {
    const companyId = actor.activeCompanyId;
    const [rows, counts] = await Promise.all([
      this.sources.findMany({
        where: { companyId },
        orderBy: { createdAt: 'asc' },
      }) as Promise<(SourceRow & { createdAt: Date })[]>,
      this.prospects.countsBySource(companyId),
    ]);
    return rows.map((row) => {
      const mine = counts.filter((count) => count.sourceId === row.id);
      const byStatus = Object.fromEntries(
        mine.map((count) => [count.status, count.count]),
      );
      return {
        ...this.sourceView(row),
        prospects: {
          total: mine.reduce((sum, count) => sum + count.count, 0),
          new: byStatus.new ?? 0,
        },
      };
    });
  }

  async createSource(actor: Principal, dto: SaveSmartSourceDto) {
    const companyId = actor.activeCompanyId;
    const clash = await this.sources.findFirst({
      where: { companyId, code: dto.code },
      select: { id: true },
    });
    if (clash)
      throw new AppError('CONFLICT', `รหัสแหล่ง ${dto.code} มีอยู่แล้ว`);
    const created = await this.transactions.execute(async (prisma) => {
      const row = (await this.sources.create(
        {
          data: {
            companyId,
            code: dto.code,
            name: dto.name,
            kind: dto.kind,
            salesAxis: dto.sales_axis ?? null,
            criteria: (dto.criteria ?? {}) as never,
            intervalHours: isConnectorKind(dto.kind)
              ? (dto.interval_hours ?? null)
              : null,
            active: dto.active ?? true,
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as SourceRow;
      await this.audit.record(
        {
          eventType: 'smart.source.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'smart_source',
          resourceId: row.id,
          after: { code: dto.code, kind: dto.kind, salesAxis: dto.sales_axis },
        },
        { prisma },
      );
      return row;
    });
    return this.sourceView(created);
  }

  async updateSource(actor: Principal, id: string, dto: SaveSmartSourceDto) {
    const before = await this.source(actor, id);
    if (dto.code !== before.code) {
      const clash = await this.sources.findFirst({
        where: { companyId: actor.activeCompanyId, code: dto.code },
        select: { id: true },
      });
      if (clash)
        throw new AppError('CONFLICT', `รหัสแหล่ง ${dto.code} มีอยู่แล้ว`);
    }
    const updated = await this.transactions.execute(async (prisma) => {
      const row = (await this.sources.update(
        {
          where: { id },
          data: {
            code: dto.code,
            name: dto.name,
            kind: dto.kind,
            salesAxis: dto.sales_axis ?? null,
            criteria: (dto.criteria ?? {}) as never,
            intervalHours: isConnectorKind(dto.kind)
              ? (dto.interval_hours ?? null)
              : null,
            active: dto.active ?? before.active,
          },
        },
        { prisma },
      )) as SourceRow;
      await this.audit.record(
        {
          eventType: 'smart.source.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'smart_source',
          resourceId: id,
          before: {
            code: before.code,
            kind: before.kind,
            active: before.active,
            criteria: before.criteria as Prisma.InputJsonValue,
          },
          after: {
            code: dto.code,
            kind: dto.kind,
            active: row.active,
            criteria: { ...(dto.criteria ?? {}) } as Prisma.InputJsonValue,
          },
        },
        { prisma },
      );
      return row;
    });
    return this.sourceView(updated);
  }

  /** "Sweep now" on a connector source. */
  async runNow(actor: Principal, id: string) {
    const source = await this.source(actor, id);
    if (!source.active) throw new AppError('CONFLICT', 'แหล่งนี้ปิดใช้งานอยู่');
    return this.sweep.run(source, 'manual', actor.userId);
  }

  /** A file the team downloaded (DBD export, a list) into a `file` source. */
  async importRows(actor: Principal, id: string, rows: FoundProspectDto[]) {
    const source = await this.source(actor, id);
    if (source.kind !== 'file') {
      throw new AppError(
        'CONFLICT',
        'นำเข้าไฟล์ได้เฉพาะแหล่งชนิด "นำเข้าไฟล์"',
      );
    }
    if (!source.active) throw new AppError('CONFLICT', 'แหล่งนี้ปิดใช้งานอยู่');
    return this.ingest.ingest(source, rows.map(toFound), 'file', actor.userId);
  }

  async listRuns(actor: Principal, sourceId?: string) {
    const rows = (await this.runs.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(sourceId ? { sourceId } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: 100,
    })) as {
      id: string;
      sourceId: string;
      trigger: string;
      status: string;
      found: number;
      added: number;
      duplicates: number;
      rejected: number;
      error: string | null;
      startedAt: Date;
      finishedAt: Date | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      source_id: row.sourceId,
      trigger: row.trigger,
      status: row.status,
      found: row.found,
      added: row.added,
      duplicates: row.duplicates,
      rejected: row.rejected,
      error: row.error,
      started_at: row.startedAt,
      finished_at: row.finishedAt,
    }));
  }

  // --- prospects ---------------------------------------------------------------

  async listProspects(actor: Principal, query: ListProspectsQueryDto) {
    const where: Prisma.SmartProspectWhereInput = {
      companyId: actor.activeCompanyId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.source_id ? { sourceId: query.source_id } : {}),
      ...(query.sales_axis ? { salesAxis: query.sales_axis } : {}),
      ...(query.min_score !== undefined
        ? { score: { gte: query.min_score } }
        : {}),
      ...(query.match_kind ? { matchKind: query.match_kind } : {}),
    };
    const q = query.q?.trim();
    if (q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { taxId: { contains: q } },
        { phone: { contains: q } },
        { province: { contains: q, mode: 'insensitive' } },
      ];
    }
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      this.prospects.findMany({
        where,
        // CD-290 — the review queue reads best-first
        orderBy:
          query.status === 'screened'
            ? [
                { score: { sort: 'desc', nulls: 'last' } },
                { createdAt: 'desc' },
              ]
            : { createdAt: 'desc' },
        skip,
        take,
      }) as Promise<ProspectRow[]>,
      this.prospects.count({ where }),
    ]);
    const handoffs = await this.handoffRequests(rows);
    return paginated(
      rows.map((row) => this.prospectView(row, handoffs)),
      query,
      total,
    );
  }

  async prospect(actor: Principal, id: string) {
    const row = await this.prospectRow(actor, id);
    return this.prospectView(row, await this.handoffRequests([row]));
  }

  /**
   * CD-293 — the handoff requests' live state: whether the axis team took
   * the prospect up is the request's own status, read, never copied.
   */
  private async handoffRequests(rows: ProspectRow[]) {
    const ids = rows.flatMap((row) => row.handoffRequestId ?? []);
    const found = ids.length
      ? ((await this.requestRows.findMany({
          where: { id: { in: ids } },
          select: { id: true, requestNo: true, status: true },
        })) as { id: string; requestNo: string | null; status: string }[])
      : [];
    return new Map(found.map((row) => [row.id, row]));
  }

  async discard(actor: Principal, id: string, dto: DiscardProspectDto) {
    const row = await this.prospectRow(actor, id);
    if (row.status === 'sent') {
      throw new AppError('CONFLICT', 'รายการนี้ส่งเข้า CRM แล้ว — ทิ้งไม่ได้');
    }
    return this.decide(actor, row, 'discarded', dto.reason);
  }

  async reopen(actor: Principal, id: string) {
    const row = await this.prospectRow(actor, id);
    if (row.status !== 'discarded') {
      throw new AppError('CONFLICT', 'เปิดคืนได้เฉพาะรายการที่ทิ้งไปแล้ว');
    }
    return this.decide(actor, row, 'new', null);
  }

  // --- helpers -----------------------------------------------------------------

  private async decide(
    actor: Principal,
    row: ProspectRow,
    status: 'new' | 'discarded',
    reason: string | null,
  ) {
    const updated = await this.transactions.execute(async (prisma) => {
      const next = (await this.prospects.update(
        {
          where: { id: row.id },
          data: {
            status,
            discardReason: reason,
            decidedBy: actor.userId,
            decidedAt: new Date(),
          },
        },
        { prisma },
      )) as ProspectRow;
      await this.audit.record(
        {
          eventType:
            status === 'discarded'
              ? 'smart.prospect.discarded'
              : 'smart.prospect.reopened',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'smart_prospect',
          resourceId: row.id,
          before: { status: row.status },
          after: { status, reason },
        },
        { prisma },
      );
      return next;
    });
    return this.prospectView(updated);
  }

  private async source(actor: Principal, id: string): Promise<SourceRow> {
    const row = (await this.sources.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as SourceRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบแหล่งข้อมูล');
    return row;
  }

  private async prospectRow(actor: Principal, id: string) {
    const row = (await this.prospects.findFirst({
      where: { id, companyId: actor.activeCompanyId },
    })) as ProspectRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายชื่อที่กวาดได้');
    return row;
  }

  private sourceView(row: SourceRow) {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      kind: row.kind,
      sales_axis: row.salesAxis,
      criteria: row.criteria,
      interval_hours: row.intervalHours,
      active: row.active,
      last_run_at: row.lastRunAt,
    };
  }

  private prospectView(
    row: ProspectRow,
    handoffs = new Map<string, { requestNo: string | null; status: string }>(),
  ) {
    const request = row.handoffRequestId
      ? (handoffs.get(row.handoffRequestId) ?? null)
      : null;
    return {
      id: row.id,
      source_id: row.sourceId,
      run_id: row.runId,
      external_ref: row.externalRef,
      name: row.name,
      tax_id: row.taxId,
      phone: row.phone,
      email: row.email,
      website: row.website,
      industry: row.industry,
      province: row.province,
      registered_capital:
        row.registeredCapital === null ? null : Number(row.registeredCapital),
      sales_axis: row.salesAxis,
      evidence: row.evidence,
      status: row.status,
      discard_reason: row.discardReason,
      decided_at: row.decidedAt,
      created_at: row.createdAt,
      // CD-290
      score: row.score,
      score_reasons: row.scoreReasons,
      ai_summary: row.aiSummary,
      match_kind: row.matchKind,
      match_customer_id: row.matchCustomerId,
      match_lead_id: row.matchLeadId,
      screened_at: row.screenedAt,
      lead_id: row.leadId,
      sent_outcome: row.sentOutcome,
      sent_at: row.sentAt,
      // CD-292
      interested_at: row.interestedAt,
      last_call_id: row.lastCallId,
      // CD-293
      handoff_axis: row.handoffAxis,
      handed_off_at: row.handedOffAt,
      handoff_error: row.handoffError,
      // CD-294
      keeper_opportunity_id: row.keeperOpportunityId,
      handoff_request: request
        ? {
            id: row.handoffRequestId,
            request_no: request.requestNo,
            status: request.status,
          }
        : null,
    };
  }
}
