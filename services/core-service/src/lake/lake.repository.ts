import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@request-management/share';
import { LAKE_TABLES, type LakeSource } from './lake-sources';

/** A row as it travels: its id, its change time (UTC, no zone) and its data. */
export interface LakeRow {
  id: string;
  ts: string;
  data: unknown;
}

export interface LakeState {
  source: string;
  watermark: string;
  last_id: string;
  last_run_at: Date | null;
  last_rows: number | null;
  total_rows: string | number;
  last_error: string | null;
}

/** Where an extract starts when a table has never been read. */
export const EPOCH = '1970-01-01T00:00:00.000000';

/**
 * Rows younger than this are left for the next run: a transaction still open
 * in the application may commit a row stamped a moment ago, and a watermark
 * already past it would never read it.
 */
const SETTLE = `interval '1 minute'`;

/**
 * CD-90 — not a model repository: it owns the raw SQL on both sides of the
 * lake pipe. The application side reads through the shared PrismaService;
 * the lake is a separate PostgreSQL database (`LAKE_DATABASE_URL`) reached
 * through a second, schema-less Prisma client used only for raw SQL. The
 * lake's tables are created here, not by Prisma migrations — it is a
 * different database, outside the application's datamodel.
 */
@Injectable()
export class LakeRepository implements OnModuleDestroy {
  private client: PrismaClient | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get configured(): boolean {
    return Boolean(this.url);
  }

  private get url(): string {
    return this.config.get<string>('lake.databaseUrl') ?? '';
  }

  private get lake(): PrismaClient {
    if (!this.url) throw new Error('LAKE_DATABASE_URL is not set');
    this.client ??= new PrismaClient({ datasourceUrl: this.url });
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.$disconnect();
    this.client = null;
  }

  /** The lake's schemas, tables and `latest` views — idempotent. */
  async ensureSchema(): Promise<void> {
    const lake = this.lake;
    await lake.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS raw`);
    await lake.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS latest`);
    await lake.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS raw._state (
         source      TEXT PRIMARY KEY,
         watermark   TIMESTAMP NOT NULL,
         last_id     TEXT NOT NULL DEFAULT '',
         last_run_at TIMESTAMPTZ,
         last_rows   INTEGER,
         total_rows  BIGINT NOT NULL DEFAULT 0,
         last_error  TEXT
       )`,
    );
    for (const name of LAKE_TABLES) {
      // Every version of a row: the key is the row and when it changed, so
      // extracting the same change twice stores it once.
      await lake.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS raw.${name} (
           id            TEXT NOT NULL,
           _source_ts    TIMESTAMPTZ NOT NULL,
           _extracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
           data          JSONB NOT NULL,
           PRIMARY KEY (id, _source_ts)
         )`,
      );
      await lake.$executeRawUnsafe(
        `CREATE OR REPLACE VIEW latest.${name} AS
         SELECT DISTINCT ON (id) id, _source_ts, _extracted_at, data
         FROM raw.${name}
         ORDER BY id, _source_ts DESC`,
      );
    }
  }

  async states(): Promise<LakeState[]> {
    return this.lake.$queryRawUnsafe<LakeState[]>(
      `SELECT source, to_char(watermark, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS watermark,
              last_id, last_run_at, last_rows, total_rows, last_error
       FROM raw._state`,
    );
  }

  /**
   * The next page of changed rows, oldest first. `(watermark, id)` is the
   * cursor, so many rows sharing one timestamp are neither skipped nor
   * repeated across pages.
   */
  async changedRows(
    source: LakeSource,
    after: { watermark: string; lastId: string },
    limit: number,
  ): Promise<LakeRow[]> {
    const wm = source.watermark;
    return this.prisma.$queryRawUnsafe<LakeRow[]>(
      `SELECT t.id::text AS id,
              to_char(${wm}, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS ts,
              (to_jsonb(t) - $1::text[]) AS data
       FROM ${source.from}
       WHERE ${wm} IS NOT NULL
         AND (${wm}, t.id::text) > ($2::timestamp, $3::text)
         AND ${wm} <= (now() AT TIME ZONE 'UTC') - ${SETTLE}
       ORDER BY ${wm}, t.id::text
       LIMIT ${Math.floor(limit)}`,
      [...source.exclude],
      after.watermark,
      after.lastId,
    );
  }

  /**
   * One page into the lake and the cursor moved past it — in one lake
   * transaction, so a crash between the two cannot lose or skip a page.
   */
  async appendPage(
    name: string,
    rows: LakeRow[],
    cursor: { watermark: string; lastId: string } | null,
  ): Promise<number> {
    return this.lake.$transaction(async (tx) => {
      const inserted = rows.length
        ? await tx.$executeRawUnsafe(
            `INSERT INTO raw.${name} (id, _source_ts, data)
             SELECT r.id, (r.ts::timestamp AT TIME ZONE 'UTC'), r.data
             FROM jsonb_to_recordset($1::jsonb) AS r(id text, ts text, data jsonb)
             ON CONFLICT (id, _source_ts) DO NOTHING`,
            JSON.stringify(rows),
          )
        : 0;
      await tx.$executeRawUnsafe(
        `INSERT INTO raw._state (source, watermark, last_id, last_run_at, last_rows, total_rows, last_error)
         VALUES ($1, COALESCE($2::timestamp, $4::timestamp), COALESCE($3, ''), now(), $5, $5, NULL)
         ON CONFLICT (source) DO UPDATE SET
           watermark   = CASE WHEN $2::timestamp IS NULL THEN raw._state.watermark
                              ELSE GREATEST(raw._state.watermark, $2::timestamp) END,
           last_id     = CASE WHEN $2::timestamp IS NULL THEN raw._state.last_id
                              WHEN $2::timestamp >= raw._state.watermark THEN $3
                              ELSE raw._state.last_id END,
           last_run_at = now(),
           last_rows   = $5,
           total_rows  = raw._state.total_rows + $5,
           last_error  = NULL`,
        name,
        cursor?.watermark ?? null,
        cursor?.lastId ?? null,
        EPOCH,
        inserted,
      );
      return inserted;
    });
  }

  /** A source that failed this run — its cursor stays where it was. */
  async recordError(name: string, error: string): Promise<void> {
    await this.lake.$executeRawUnsafe(
      `INSERT INTO raw._state (source, watermark, last_run_at, last_error)
       VALUES ($1, $2::timestamp, now(), $3)
       ON CONFLICT (source) DO UPDATE SET last_run_at = now(), last_error = $3`,
      name,
      EPOCH,
      error.slice(0, 2000),
    );
  }

  /** CD-90 — the customers SAP knows (a BP number), for the invoice extract. */
  async sapCustomers(): Promise<
    {
      customerId: string;
      customerCode: string;
      companyCode: string;
      externalCode: string;
    }[]
  > {
    return this.prisma.$queryRawUnsafe(
      `SELECT c.id AS "customerId", c."customerCode", co.code AS "companyCode",
              x."externalCode"
       FROM customer_external_codes x
       JOIN customers c ON c.id = x."customerId" AND c."mergedIntoCustomerId" IS NULL
       JOIN companies co ON co.id = c."companyId"
       WHERE x.system = 'sap'`,
    );
  }
}
