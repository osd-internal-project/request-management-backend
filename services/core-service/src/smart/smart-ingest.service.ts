import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import {
  cleanProspect,
  type CleanProspect,
  type FoundProspect,
  MAX_ROWS_PER_BATCH,
} from './smart-rules';
import {
  SmartProspectRepository,
  SmartSourceRepository,
  SmartSweepRunRepository,
} from './smart.repositories';

export interface SourceRow {
  id: string;
  companyId: string;
  code: string;
  name: string;
  kind: string;
  salesAxis: string | null;
  criteria: unknown;
  intervalHours: number | null;
  active: boolean;
  lastRunAt: Date | null;
}

export interface IngestOutcome {
  runId: string;
  found: number;
  added: number;
  duplicates: number;
  rejected: number;
  /** Why rows were turned away, by row number (1-based), at most 50. */
  problems: { row: number; reason: string }[];
}

/**
 * CD-289 — the one way swept rows enter the staging list, whoever found them:
 * a connector on a schedule, a vendor's push, or a file the team imported.
 *
 * Each batch is a sweep run with its counts. A row already held (same source
 * and ref, or the same tax id from anywhere not discarded) is a duplicate,
 * not a second row — so sweeping again shows what is new, not everything.
 * Nothing here touches CRM; screening (CD-290) decides what goes on.
 */
@Injectable()
export class SmartIngestService {
  constructor(
    private readonly sources: SmartSourceRepository,
    private readonly runs: SmartSweepRunRepository,
    private readonly prospects: SmartProspectRepository,
  ) {}

  /** Rows pushed by a vendor through the external API, to a `push` source. */
  async push(companyId: string, sourceCode: string, rows: FoundProspect[]) {
    const source = (await this.sources.findFirst({
      where: { companyId, code: sourceCode },
    })) as SourceRow | null;
    if (!source)
      throw new AppError('NOT_FOUND', 'ไม่พบแหล่งข้อมูลตามรหัสที่ระบุ');
    if (source.kind !== 'push') {
      throw new AppError(
        'CONFLICT',
        'แหล่งนี้ไม่ได้ตั้งให้รับข้อมูลแบบส่งเข้ามา (ชนิด push)',
      );
    }
    if (!source.active) throw new AppError('CONFLICT', 'แหล่งนี้ปิดใช้งานอยู่');
    return this.ingest(source, rows, 'push', null);
  }

  async ingest(
    source: SourceRow,
    rows: FoundProspect[],
    trigger: 'schedule' | 'manual' | 'push' | 'file',
    startedBy: string | null,
  ): Promise<IngestOutcome> {
    if (rows.length > MAX_ROWS_PER_BATCH) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ส่งได้ครั้งละไม่เกิน ${MAX_ROWS_PER_BATCH} รายการ`,
      );
    }
    const run = (await this.runs.create({
      data: {
        companyId: source.companyId,
        sourceId: source.id,
        trigger,
        startedBy,
      },
      select: { id: true },
    })) as { id: string };

    const problems: { row: number; reason: string }[] = [];
    const clean: CleanProspect[] = [];
    rows.forEach((row, index) => {
      const result = cleanProspect(row, source.salesAxis);
      if (result.ok) clean.push(result.row);
      else problems.push({ row: index + 1, reason: result.reason });
    });

    const held = await this.alreadyHeld(source, clean);
    const seenRefs = new Set<string>();
    const seenTax = new Set<string>();
    const fresh = clean.filter((row) => {
      if (held.refs.has(row.externalRef) || seenRefs.has(row.externalRef)) {
        return false;
      }
      if (row.taxId && (held.taxIds.has(row.taxId) || seenTax.has(row.taxId))) {
        return false;
      }
      seenRefs.add(row.externalRef);
      if (row.taxId) seenTax.add(row.taxId);
      return true;
    });

    const { count } = await this.prospects.createMany({
      data: fresh.map((row) => ({
        companyId: source.companyId,
        sourceId: source.id,
        runId: run.id,
        ...row,
        evidence: row.evidence as never,
      })),
      skipDuplicates: true,
    });

    const outcome = {
      runId: run.id,
      found: rows.length,
      added: count,
      duplicates: clean.length - count,
      rejected: problems.length,
      problems: problems.slice(0, 50),
    };
    await this.finish(source, run.id, outcome);
    return outcome;
  }

  /** Marks a run failed — the connector could not be reached, say. */
  async fail(
    source: SourceRow,
    trigger: string,
    error: string,
    startedBy: string | null,
  ) {
    await this.runs.create({
      data: {
        companyId: source.companyId,
        sourceId: source.id,
        trigger,
        status: 'error',
        error: error.slice(0, 1000),
        startedBy,
        finishedAt: new Date(),
      },
    });
    await this.sources.update({
      where: { id: source.id },
      data: { lastRunAt: new Date() },
    });
  }

  private async finish(
    source: SourceRow,
    runId: string,
    outcome: IngestOutcome,
  ) {
    const now = new Date();
    await Promise.all([
      this.runs.update({
        where: { id: runId },
        data: {
          status: 'ok',
          found: outcome.found,
          added: outcome.added,
          duplicates: outcome.duplicates,
          rejected: outcome.rejected,
          finishedAt: now,
        },
      }),
      this.sources.update({
        where: { id: source.id },
        data: { lastRunAt: now },
      }),
    ]);
  }

  private async alreadyHeld(source: SourceRow, rows: CleanProspect[]) {
    const refs = rows.map((row) => row.externalRef);
    const taxIds = rows.flatMap((row) => (row.taxId ? [row.taxId] : []));
    const [byRef, byTax] = await Promise.all([
      refs.length
        ? (this.prospects.findMany({
            where: {
              companyId: source.companyId,
              sourceId: source.id,
              externalRef: { in: refs },
            },
            select: { externalRef: true },
          }) as Promise<{ externalRef: string }[]>)
        : Promise.resolve([]),
      taxIds.length
        ? (this.prospects.findMany({
            where: {
              companyId: source.companyId,
              taxId: { in: taxIds },
              status: { not: 'discarded' },
            },
            select: { taxId: true },
          }) as Promise<{ taxId: string }[]>)
        : Promise.resolve([]),
    ]);
    return {
      refs: new Set(byRef.map((row) => row.externalRef)),
      taxIds: new Set(byTax.map((row) => row.taxId)),
    };
  }
}
