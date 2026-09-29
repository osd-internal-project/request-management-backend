import {
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
import { KeeperService } from '../crm/keeper.service';
import { DataMartRepository } from './data-mart.repository';

const DEFAULT_INTERVAL_MS = 3_600_000;
/** The first rebuild after boot — soon, so a fresh deploy is not an hour empty. */
const FIRST_RUN_DELAY_MS = 60_000;

/**
 * CD-91 — the Data Mart (`mart` schema): sales, pipeline, target vs actual and
 * open requests — and, since CD-92, leads, every deal (win rate) and each
 * account's Keeper health with a daily trend — rebuilt every hour (user decision 29 ก.ย. 2569) from the
 * application tables, plus a daily snapshot of the backlog so it can be read
 * as a trend. Executive dashboards (Metabase) read the mart instead of anyone
 * gathering the figures by hand.
 *
 * Runs in core-service only (`martRefreshIntervalMs` is 0 in
 * external-service). Two instances do not rebuild at once — the repository
 * takes an advisory lock and the loser skips its round.
 */
@Injectable()
export class DataMartService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DataMartService.name);
  private timer: NodeJS.Timeout | null = null;
  private firstRun: NodeJS.Timeout | null = null;

  constructor(
    private readonly mart: DataMartRepository,
    private readonly keeper: KeeperService,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('martRefreshIntervalMs') ?? DEFAULT_INTERVAL_MS;
    if (interval <= 0) return;
    const tick = backgroundTick(this.logger, 'CD-91 data mart', () =>
      this.refresh(),
    );
    this.firstRun = setTimeout(tick, Math.min(FIRST_RUN_DELAY_MS, interval));
    this.firstRun.unref?.();
    this.timer = setInterval(tick, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstRun) clearTimeout(this.firstRun);
    if (this.timer) clearInterval(this.timer);
    this.firstRun = null;
    this.timer = null;
  }

  /** One rebuild. `null` when another instance was already at it. */
  async refresh() {
    const started = Date.now();
    // CD-92 — the Keeper's health comes from the application, computed before
    // the transaction opens so the lock is held for writing only.
    const accounts = await this.keeper.martAccounts();
    const done = await this.mart.rebuild(accounts);
    if (done === false) {
      this.logger.log(
        'CD-91: another instance is rebuilding the mart — skipped',
      );
      return null;
    }
    this.logger.log(
      `CD-91: mart rebuilt in ${Date.now() - started} ms — ` +
        done.map((step) => `${step.table} ${step.rows}`).join(', '),
    );
    return done;
  }

  /** For the BI settings screen: when each table was last rebuilt. */
  async status() {
    return {
      interval_ms:
        this.config.get<number>('martRefreshIntervalMs') ?? DEFAULT_INTERVAL_MS,
      tables: await this.mart.status(),
    };
  }

  /** "Rebuild now" from the BI settings screen — audited, it is an admin act. */
  async refreshNow(actor: Principal) {
    const done = await this.refresh();
    if (done === null) {
      throw new AppError(
        'CONFLICT',
        'กำลังปรับปรุง Data Mart อยู่แล้ว — ลองใหม่อีกครู่',
      );
    }
    await this.audit.record({
      eventType: 'bi.mart.refreshed',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'data_mart',
      resourceId: 'mart',
      after: { tables: done.map((step) => `${step.table}:${step.rows}`) },
    });
    return this.status();
  }
}
