import { Injectable } from '@nestjs/common';
import { PrismaService, type TQueryClient } from '@request-management/share';
import { SLA_STATUS_SQL } from '../sla/sla-status';

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;
/** A `timestamp` column as the instant it is (for `timestamptz` columns). */
const utc = (column: string) => `(${column}) AT TIME ZONE 'UTC'`;
const BKK_TODAY = `(now() AT TIME ZONE 'Asia/Bangkok')::date`;
const BKK_MONTH = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`;

/** Kept in step with `OPEN_OPPORTUNITY_STAGES` (sales.dto.ts). */
const OPEN_STAGES = `('qualifying','proposing','negotiating')`;
/**
 * Not yet finished: `TERMINAL_STATUSES` plus drafts, which were never sent.
 * `completed` stays open — it waits for the requester to accept.
 */
const NOT_OPEN = `('draft','rejected','closed','cancelled')`;

/** Each mart table and the statements that rebuild it, in order. */
export const MART_TABLES: readonly { table: string; sql: string[] }[] = [
  {
    table: 'fact_sales',
    sql: [
      `DELETE FROM mart.fact_sales`,
      `INSERT INTO mart.fact_sales
       SELECT so.id, so."saleOrderCode", c.code, c.name,
              ${utc('so."orderedAt"')},
              (${bkk('so."orderedAt"')})::date,
              to_char(${bkk('so."orderedAt"')}, 'YYYY-MM'),
              so.status::text, so.status = 'cancelled',
              so.amount, so.currency,
              cu."customerCode", cu."nameTh", cu.type::text,
              o."opportunityCode",
              so."ownerUserId", u."displayName", so."ownerOrgUnitId", ou.name,
              so."erpStatus"::text
       FROM sale_orders so
       JOIN companies c ON c.id = so."companyId"
       LEFT JOIN customers cu ON cu.id = so."customerId"
       LEFT JOIN opportunities o ON o.id = so."opportunityId"
       LEFT JOIN users u ON u.id = so."ownerUserId"
       LEFT JOIN org_units ou ON ou.id = so."ownerOrgUnitId"`,
    ],
  },
  {
    table: 'fact_pipeline',
    sql: [
      `DELETE FROM mart.fact_pipeline`,
      // Weighted as the CRM dashboard and the sales-target forecast do:
      // no probability counts as 0.
      `INSERT INTO mart.fact_pipeline
       SELECT o.id, o."opportunityCode", o.title, c.code, c.name,
              o.stage::text, o.amount, o.currency, o.probability,
              round(COALESCE(o.amount, 0) * COALESCE(o.probability, 0) / 100.0, 2),
              (${bkk('o."expectedCloseAt"')})::date,
              to_char(${bkk('o."expectedCloseAt"')}, 'YYYY-MM'),
              COALESCE(cu."nameTh", o."prospectName"), o."customerId" IS NULL,
              o."ownerUserId", u."displayName", o."ownerOrgUnitId", ou.name,
              (${bkk('o."createdAt"')})::date,
              ${BKK_TODAY} - (${bkk('o."createdAt"')})::date,
              ${utc('o."lastActivityAt"')}
       FROM opportunities o
       JOIN companies c ON c.id = o."companyId"
       LEFT JOIN customers cu ON cu.id = o."customerId"
       LEFT JOIN users u ON u.id = o."ownerUserId"
       LEFT JOIN org_units ou ON ou.id = o."ownerOrgUnitId"
       WHERE o.stage IN ${OPEN_STAGES}`,
    ],
  },
  {
    table: 'sales_target_actual',
    sql: [
      `DELETE FROM mart.sales_target_actual`,
      // The same figures as the เป้าและพยากรณ์ screen (SalesTargetsService):
      // sold = open sale orders ordered in the Bangkok month; a unit's target
      // counts its whole subtree; a period already over has no pipeline left.
      `WITH sold AS (
         SELECT "companyId", "ownerUserId", "ownerOrgUnitId", amount,
                to_char(${bkk('"orderedAt"')}, 'YYYY-MM') AS period
         FROM sale_orders WHERE status = 'open'
       ),
       pipe AS (
         SELECT "companyId", "ownerUserId", "ownerOrgUnitId",
                COALESCE(amount, 0) * COALESCE(probability, 0) / 100.0 AS weighted,
                to_char(${bkk('"expectedCloseAt"')}, 'YYYY-MM') AS period
         FROM opportunities
         WHERE stage IN ${OPEN_STAGES} AND "expectedCloseAt" IS NOT NULL
       ),
       measured AS (
         SELECT t.id, c.code AS company_code, t.period, t.scope::text AS scope,
                t."subjectId" AS subject_id,
                CASE WHEN t.scope = 'user' THEN u."displayName" ELSE ou.name END
                  AS subject_name,
                t.amount AS target_amount,
                t.period < ${BKK_MONTH} AS is_closed,
                (SELECT COALESCE(sum(s.amount), 0) FROM sold s
                  WHERE s."companyId" = t."companyId" AND s.period = t.period
                    AND ((t.scope = 'user' AND s."ownerUserId" = t."subjectId")
                      OR (t.scope = 'org_unit' AND (s."ownerOrgUnitId" = t."subjectId"
                          OR s."ownerOrgUnitId" IN (SELECT "descendantId" FROM org_closure
                                                  WHERE "ancestorId" = t."subjectId"))))
                ) AS actual,
                (SELECT COALESCE(sum(p.weighted), 0) FROM pipe p
                  WHERE p."companyId" = t."companyId" AND p.period = t.period
                    AND ((t.scope = 'user' AND p."ownerUserId" = t."subjectId")
                      OR (t.scope = 'org_unit' AND (p."ownerOrgUnitId" = t."subjectId"
                          OR p."ownerOrgUnitId" IN (SELECT "descendantId" FROM org_closure
                                                  WHERE "ancestorId" = t."subjectId"))))
                ) AS weighted
         FROM sales_targets t
         JOIN companies c ON c.id = t."companyId"
         LEFT JOIN users u ON t.scope = 'user' AND u.id = t."subjectId"
         LEFT JOIN org_units ou ON t.scope = 'org_unit' AND ou.id = t."subjectId"
       )
       INSERT INTO mart.sales_target_actual
       SELECT id, company_code, period, scope, subject_id, subject_name,
              target_amount, actual,
              CASE WHEN is_closed THEN 0 ELSE round(weighted, 2) END,
              actual + CASE WHEN is_closed THEN 0 ELSE round(weighted, 2) END,
              CASE WHEN target_amount > 0
                   THEN round(100.0 * actual / target_amount, 1) END,
              CASE WHEN target_amount > 0
                   THEN round(100.0 * (actual + CASE WHEN is_closed THEN 0 ELSE weighted END)
                              / target_amount, 1) END,
              is_closed
       FROM measured`,
    ],
  },
  {
    table: 'open_requests',
    sql: [
      `DELETE FROM mart.open_requests`,
      // sla_status is SLA_STATUS_SQL — the one definition of overdue (CD-50).
      `INSERT INTO mart.open_requests
       SELECT r.id, r."requestNo", c.code, c.name, r."typeCode", rt.name,
              r.status::text, r."receiverOrgUnitId", ro.name,
              au."displayName", ru."displayName", rqo.name,
              ${utc('r."submittedAt"')}, ${utc('r."dueAt"')},
              age.days,
              CASE WHEN age.days <= 3 THEN '0-3 วัน'
                   WHEN age.days <= 7 THEN '4-7 วัน'
                   WHEN age.days <= 14 THEN '8-14 วัน'
                   WHEN age.days <= 30 THEN '15-30 วัน'
                   ELSE 'เกิน 30 วัน' END,
              CASE WHEN sc.id IS NULL THEN NULL ELSE ${SLA_STATUS_SQL} END
       FROM requests r
       JOIN companies c ON c.id = r."companyId"
       JOIN request_types rt ON rt.id = r."requestTypeId"
       LEFT JOIN org_units ro ON ro.id = r."receiverOrgUnitId"
       LEFT JOIN users au ON au.id = r."assigneeUserId"
       LEFT JOIN users ru ON ru.id = r."requesterId"
       LEFT JOIN org_units rqo ON rqo.id = r."requesterOrgUnitId"
       LEFT JOIN sla_clocks sc ON sc."requestId" = r.id
       CROSS JOIN LATERAL (
         SELECT GREATEST(0, ${BKK_TODAY}
                - (${bkk('COALESCE(r."submittedAt", r."createdAt")')})::date) AS days
       ) age
       WHERE r.status NOT IN ${NOT_OPEN}`,
    ],
  },
  {
    table: 'request_backlog_daily',
    sql: [
      `DELETE FROM mart.request_backlog_daily WHERE snapshot_date = ${BKK_TODAY}`,
      `INSERT INTO mart.request_backlog_daily
       SELECT ${BKK_TODAY}, company_code, COALESCE(receiver_unit, '-'),
              type_code, max(type_name), status,
              count(*), count(*) FILTER (WHERE sla_status = 'overdue'),
              round(avg(age_days), 1)
       FROM mart.open_requests
       GROUP BY company_code, COALESCE(receiver_unit, '-'), type_code, status`,
    ],
  },
];

export interface MartTableStatus {
  table_name: string;
  refreshed_at: Date | null;
  row_count: number | null;
  duration_ms: number | null;
}

/**
 * CD-91 — not a model repository: it owns the raw SQL that rebuilds the
 * `mart` schema, which lives outside Prisma's datamodel. The statements are
 * constants — nothing from a request ever reaches them.
 */
@Injectable()
export class DataMartRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Rebuilds every table in one transaction, so a reader sees the old mart or
   * the new one, never half of each. Returns false when another instance holds
   * the rebuild lock — it is already doing the same work.
   */
  async rebuild(): Promise<
    { table: string; rows: number; ms: number }[] | false
  > {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(hashtext('ctd.mart.rebuild')) AS locked`,
        );
        if (!lock?.locked) return false;

        const done: { table: string; rows: number; ms: number }[] = [];
        for (const step of MART_TABLES) {
          const started = Date.now();
          for (const statement of step.sql) {
            await tx.$executeRawUnsafe(statement);
          }
          const rows = await this.count(tx, step.table);
          const ms = Date.now() - started;
          await tx.$executeRawUnsafe(
            `INSERT INTO mart.refresh_log (table_name, refreshed_at, row_count, duration_ms)
             VALUES ($1, now(), $2, $3)
             ON CONFLICT (table_name) DO UPDATE
               SET refreshed_at = EXCLUDED.refreshed_at,
                   row_count = EXCLUDED.row_count,
                   duration_ms = EXCLUDED.duration_ms`,
            step.table,
            rows,
            ms,
          );
          done.push({ table: step.table, rows, ms });
        }
        return done;
      },
      { timeout: 120_000 },
    );
  }

  async status(): Promise<MartTableStatus[]> {
    const rows = await this.prisma.$queryRawUnsafe<MartTableStatus[]>(
      `SELECT table_name, refreshed_at, row_count, duration_ms
       FROM mart.refresh_log`,
    );
    const byName = new Map(rows.map((row) => [row.table_name, row]));
    return MART_TABLES.map(
      ({ table }) =>
        byName.get(table) ?? {
          table_name: table,
          refreshed_at: null,
          row_count: null,
          duration_ms: null,
        },
    );
  }

  private async count(client: TQueryClient, table: string) {
    const [row] = await client.$queryRawUnsafe<{ n: number }[]>(
      table === 'request_backlog_daily'
        ? `SELECT count(*)::int AS n FROM mart.request_backlog_daily
           WHERE snapshot_date = ${BKK_TODAY}`
        : `SELECT count(*)::int AS n FROM mart.${table}`,
    );
    return row?.n ?? 0;
  }
}
