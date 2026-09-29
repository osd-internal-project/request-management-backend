import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  type Principal,
} from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { ERP_CLIENT } from '../erp/erp-client';
import type { ErpClient } from '../erp/erp-client';
import {
  assertSources,
  LAKE_SOURCES,
  LAKE_TABLES,
  SAP_INVOICES,
  type LakeSource,
} from './lake-sources';
import {
  EPOCH,
  LakeRepository,
  type LakeRow,
  type LakeState,
} from './lake.repository';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Rows per page — one lake transaction each. */
export const PAGE_SIZE = 2000;
/** Pages per source per run: a first run over a big table spreads over hours. */
const MAX_PAGES = 50;
/** Invoices per customer per day, as the 360° finance tab reads (CD-89). */
const INVOICE_LIMIT = 50;

export interface LakeTableStatus {
  table_name: string;
  module: string;
  excluded_columns: readonly string[];
  watermark: string | null;
  last_run_at: Date | null;
  last_rows: number | null;
  total_rows: number;
  last_error: string | null;
}

export interface LakeStatus {
  configured: boolean;
  interval_ms?: number;
  tables: LakeTableStatus[];
}

export interface SourceResult {
  source: string;
  rows: number;
  error: string | null;
}

/**
 * CD-90 — ท่อข้อมูลลง Data Lake (user decisions 29 ก.ย. 2569): a separate
 * PostgreSQL warehouse database (`LAKE_DATABASE_URL`), fed every hour with the
 * rows each Phase-1 module changed since the last run — Platform Request,
 * CRM, Sales and the reference data they point at — and once a day with the
 * customers' invoices from SAP. Every change is kept as a new version
 * (`raw.<table>`); `latest.<table>` is the current row. Sensitive columns are
 * dropped before a row leaves the application (see `lake-sources.ts`).
 *
 * Runs in core-service only (the intervals are 0 in external-service), and
 * does nothing while `LAKE_DATABASE_URL` is unset. A source that fails keeps
 * its cursor and is retried next run; the others go on.
 */
@Injectable()
export class DataLakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataLakeService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(
    private readonly lake: LakeRepository,
    @Inject(ERP_CLIENT) private readonly erp: ErpClient,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
  ) {
    assertSources(LAKE_SOURCES);
  }

  onModuleInit(): void {
    if (!this.lake.configured) return;
    const extractMs =
      this.config.get<number>('lake.extractIntervalMs') ?? HOUR_MS;
    const sapMs = this.config.get<number>('lake.sapIntervalMs') ?? DAY_MS;
    if (extractMs > 0) {
      const tick = backgroundTick(this.logger, 'CD-90 lake extract', () =>
        this.extract(),
      );
      this.schedule(tick, extractMs);
    }
    if (sapMs > 0) {
      const tick = backgroundTick(this.logger, 'CD-90 lake SAP extract', () =>
        this.extractSap(),
      );
      this.schedule(tick, sapMs);
    }
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Every source's changes since its cursor. Null while a run is in progress. */
  async extract(): Promise<SourceResult[] | null> {
    if (this.running) return null;
    this.running = true;
    try {
      await this.lake.ensureSchema();
      const cursors = new Map(
        (await this.lake.states()).map((state) => [state.source, state]),
      );
      const results: SourceResult[] = [];
      for (const source of LAKE_SOURCES) {
        const state = cursors.get(source.name);
        results.push(
          await this.extractSource(source, {
            watermark: state?.watermark ?? EPOCH,
            lastId: state?.last_id ?? '',
          }),
        );
      }
      const total = results.reduce((sum, result) => sum + result.rows, 0);
      const failed = results.filter((result) => result.error);
      this.logger.log(
        `CD-90: ${total} row version(s) into the lake` +
          (failed.length
            ? ` — ${failed.length} source(s) failed: ${failed.map((f) => f.source).join(', ')}`
            : ''),
      );
      return results;
    } finally {
      this.running = false;
    }
  }

  /**
   * The customers' SAP invoices, one version per invoice per day. Never from
   * the mock connector: invented invoices must not become history.
   */
  async extractSap(now: Date = new Date()): Promise<SourceResult> {
    if (this.erp.mode === 'mock') {
      return { source: SAP_INVOICES, rows: 0, error: 'ERP อยู่ในโหมด mock' };
    }
    await this.lake.ensureSchema();
    const day = bangkokDay(now);
    const rows: LakeRow[] = [];
    let failures = 0;
    for (const customer of await this.lake.sapCustomers()) {
      try {
        const invoices = await this.erp.listInvoices(
          { companyCode: customer.companyCode },
          customer.externalCode,
          INVOICE_LIMIT,
        );
        for (const invoice of invoices) {
          rows.push({
            id: `${customer.companyCode}:${customer.externalCode}:${invoice.docNo}`,
            ts: `${day}T00:00:00.000000`,
            data: { ...invoice, ...customer, snapshotOn: day },
          });
        }
      } catch {
        failures += 1; // SAP down for one customer: the others still count
      }
    }
    const error = failures
      ? `อ่านจาก SAP ไม่ได้ ${failures} ราย — รอบถัดไปลองใหม่`
      : null;
    // At least one call, so the run is recorded even with nothing to store.
    let stored = 0;
    let start = 0;
    do {
      stored += await this.lake.appendPage(
        SAP_INVOICES,
        rows.slice(start, start + PAGE_SIZE),
        null,
      );
      start += PAGE_SIZE;
    } while (start < rows.length);
    if (error) await this.lake.recordError(SAP_INVOICES, error);
    return { source: SAP_INVOICES, rows: stored, error };
  }

  /** For the BI settings screen: each lake table, its cursor and last run. */
  async status(): Promise<LakeStatus> {
    if (!this.lake.configured) {
      return { configured: false, tables: [] };
    }
    const states = new Map(
      (await this.lake.states().catch((): LakeState[] => [])).map((state) => [
        state.source,
        state,
      ]),
    );
    return {
      configured: true,
      interval_ms: this.config.get<number>('lake.extractIntervalMs') ?? HOUR_MS,
      tables: LAKE_TABLES.map((name) => {
        const state = states.get(name);
        const source = LAKE_SOURCES.find((entry) => entry.name === name);
        return {
          table_name: name,
          module: source?.module ?? 'sap',
          excluded_columns: source?.exclude ?? [],
          watermark:
            state && state.watermark !== EPOCH ? state.watermark : null,
          last_run_at: state?.last_run_at ?? null,
          last_rows: state?.last_rows ?? null,
          total_rows: state ? Number(state.total_rows) : 0,
          last_error: state?.last_error ?? null,
        };
      }),
    };
  }

  /** "Run now" from the BI settings screen — audited, it is an admin act. */
  async runNow(actor: Principal) {
    if (!this.lake.configured) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งค่า LAKE_DATABASE_URL — ยังไม่มี Data Lake ให้ส่งข้อมูล',
      );
    }
    const results = await this.extract();
    if (results === null) {
      throw new AppError('CONFLICT', 'กำลังส่งข้อมูลลง Data Lake อยู่แล้ว');
    }
    await this.audit.record({
      eventType: 'bi.lake.extracted',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'data_lake',
      resourceId: 'lake',
      after: {
        rows: results.reduce((sum, result) => sum + result.rows, 0),
        failed: results.filter((r) => r.error).map((r) => r.source),
      },
    });
    return this.status();
  }

  private async extractSource(
    source: LakeSource,
    start: { watermark: string; lastId: string },
  ): Promise<SourceResult> {
    let cursor = start;
    let rows = 0;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const batch = await this.lake.changedRows(source, cursor, PAGE_SIZE);
        const last = batch[batch.length - 1];
        const next = last ? { watermark: last.ts, lastId: last.id } : null;
        rows += await this.lake.appendPage(source.name, batch, next);
        if (!next || batch.length < PAGE_SIZE) break;
        cursor = next;
      }
      return { source: source.name, rows, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`CD-90 lake source ${source.name}: ${message}`);
      await this.lake.recordError(source.name, message).catch(() => undefined);
      return { source: source.name, rows, error: message };
    }
  }

  /** First run a minute after boot (not a whole interval later), then every interval. */
  private schedule(tick: () => void, interval: number) {
    const first = setTimeout(tick, Math.min(60_000, interval));
    first.unref?.();
    const every = setInterval(tick, interval);
    every.unref?.();
    this.timers.push(first, every);
  }
}

function bangkokDay(now: Date): string {
  return new Date(now.getTime() + 7 * HOUR_MS).toISOString().slice(0, 10);
}
