import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import { backgroundTick } from '../common/background-tick';
import { SMART_CONNECTORS, type SmartConnector } from './smart-connector';
import {
  SmartIngestService,
  type IngestOutcome,
  type SourceRow,
} from './smart-ingest.service';
import { isConnectorKind, isDue } from './smart-rules';
import { SmartSourceRepository } from './smart.repositories';

/**
 * CD-289 — sweeps connector sources (DBD, web, social): on their schedule,
 * or now when someone presses "sweep". Pushed and imported sources are fed
 * from outside and never swept here.
 */
@Injectable()
export class SmartSweepService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmartSweepService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly sources: SmartSourceRepository,
    private readonly ingest: SmartIngestService,
    private readonly config: ConfigService,
    @Inject(SMART_CONNECTORS)
    private readonly connectors: Map<string, SmartConnector>,
  ) {}

  onModuleInit(): void {
    const interval =
      this.config.get<number>('smart.sweepIntervalMs') ?? 900_000;
    if (interval <= 0) return;
    this.timer = setInterval(
      backgroundTick(this.logger, 'CD-289 AI SMART sweeps', () =>
        this.sweepDue(),
      ),
      interval,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Every source whose interval has passed; returns how many were swept. */
  async sweepDue(now = new Date()) {
    const rows = (await this.sources.findMany({
      where: { active: true, intervalHours: { not: null } },
    })) as SourceRow[];
    let swept = 0;
    for (const source of rows.filter((row) => isDue(row, now))) {
      await this.run(source, 'schedule', null).catch((error: Error) =>
        this.logger.warn(`sweep ${source.code} failed: ${error.message}`),
      );
      swept += 1;
    }
    return { swept };
  }

  /** One sweep of one connector source. A connector failure is a failed run, recorded. */
  async run(
    source: SourceRow,
    trigger: 'schedule' | 'manual',
    startedBy: string | null,
  ): Promise<IngestOutcome> {
    if (!isConnectorKind(source.kind)) {
      throw new AppError(
        'CONFLICT',
        'แหล่งนี้รับข้อมูลจากภายนอก (ส่งเข้ามาหรือนำเข้าไฟล์) — กวาดเองไม่ได้',
      );
    }
    const connector = this.connectors.get(source.kind);
    if (!connector) {
      throw new AppError(
        'CONFLICT',
        `ยังไม่มีตัวเชื่อมสำหรับแหล่งชนิด ${source.kind} (SMART_CONNECTOR_MODE=off)`,
      );
    }
    try {
      const found = await connector.search(source.criteria ?? {});
      return await this.ingest.ingest(source, found, trigger, startedBy);
    } catch (error) {
      if (error instanceof AppError) throw error;
      await this.ingest.fail(
        source,
        trigger,
        (error as Error).message,
        startedBy,
      );
      throw new AppError(
        'UPSTREAM_ERROR',
        `กวาดจากแหล่ง ${source.name} ไม่สำเร็จ: ${(error as Error).message}`,
      );
    }
  }
}
