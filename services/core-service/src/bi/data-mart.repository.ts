import { Injectable } from '@nestjs/common';
import { PrismaService, type TQueryClient } from '@request-management/share';
import { CONTACT_TYPES } from '../crm/prospecting-rules';
import { martTableName, PRICING_MART_TABLES } from './pricing-mart';
import { CAMPAIGN_MART_TABLES } from './campaign-mart';
import { HOURS_PER_MANDAY } from '../hr/timesheet-rules';
import { DEFAULT_CREDIT_DAYS } from '../pm/payment-rules';
import { SLA_STATUS_SQL } from '../sla/sla-status';

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;
/** A `timestamp` column as the instant it is (for `timestamptz` columns). */
const utc = (column: string) => `(${column}) AT TIME ZONE 'UTC'`;
const BKK_TODAY = `(now() AT TIME ZONE 'Asia/Bangkok')::date`;
const BKK_MONTH = `to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM')`;

/** CD-85's definition of a contact attempt, as an SQL list (constants only). */
const CONTACT_TYPES_SQL = `(${CONTACT_TYPES.map((type) => `'${type}'`).join(',')})`;
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
    // CD-92 — Getter: every lead, where it came from, whether it became a deal.
    table: 'fact_leads',
    sql: [
      `DELETE FROM mart.fact_leads`,
      `INSERT INTO mart.fact_leads
       SELECT l.id, c.code,
              (${bkk('l."createdAt"')})::date,
              to_char(${bkk('l."createdAt"')}, 'YYYY-MM'),
              l."sourceCode", cp.code, ta.id IS NOT NULL,
              l.status, COALESCE(ls.kind::text, 'open'),
              l."convertedOpportunityId" IS NOT NULL,
              (${bkk('o."createdAt"')})::date,
              (${bkk('o."createdAt"')})::date - (${bkk('l."createdAt"')})::date,
              (SELECT count(*)::int FROM lead_activities a
                WHERE a."leadId" = l.id AND a."completedAt" IS NOT NULL
                  AND a.type IN ${CONTACT_TYPES_SQL}),
              u."displayName", ou.name
       FROM leads l
       JOIN companies c ON c.id = l."companyId"
       LEFT JOIN lead_statuses ls
         ON ls."companyId" = l."companyId" AND ls.code = l.status
       LEFT JOIN campaigns cp ON cp.id = l."campaignId"
       LEFT JOIN target_accounts ta ON ta."leadId" = l.id
       LEFT JOIN opportunities o ON o.id = l."convertedOpportunityId"
       LEFT JOIN users u ON u.id = l."ownerUserId"
       LEFT JOIN org_units ou ON ou.id = l."ownerOrgUnitId"`,
    ],
  },
  {
    // CD-92 — every deal, open or closed: win rate and deal types (CD-86).
    table: 'fact_deals',
    sql: [
      `DELETE FROM mart.fact_deals`,
      `INSERT INTO mart.fact_deals
       SELECT o.id, o."opportunityCode", c.code, o."dealType"::text,
              o.stage::text, o.stage IN ${OPEN_STAGES},
              o.stage = 'won', o.stage = 'lost', o.amount,
              (${bkk('o."createdAt"')})::date,
              to_char(${bkk('o."createdAt"')}, 'YYYY-MM'),
              (${bkk('COALESCE(o."wonAt", o."lostAt")')})::date,
              to_char(${bkk('COALESCE(o."wonAt", o."lostAt")')}, 'YYYY-MM'),
              COALESCE(lr.name, o."lostReasonCode"),
              cu."customerCode",
              EXISTS (SELECT 1 FROM leads l WHERE l."convertedOpportunityId" = o.id),
              u."displayName", ou.name
       FROM opportunities o
       JOIN companies c ON c.id = o."companyId"
       LEFT JOIN customers cu ON cu.id = o."customerId"
       LEFT JOIN opportunity_lost_reasons lr
         ON lr."companyId" = o."companyId" AND lr.code = o."lostReasonCode"
       LEFT JOIN users u ON u.id = o."ownerUserId"
       LEFT JOIN org_units ou ON ou.id = o."ownerOrgUnitId"`,
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
  {
    // CD-192 — every project, with its health from the latest weekly report
    table: 'fact_projects',
    sql: [
      `DELETE FROM mart.fact_projects`,
      `INSERT INTO mart.fact_projects
       SELECT p.id, c.code, p."projectNo", p.name, cc."contractNo",
              cu."nameTh", u."displayName", p.status::text, p."contractValue",
              p."startOn", p."endOn",
              r."healthLevel", r."healthScore",
              (SELECT string_agg(f->>'label', ', ')
                 FROM jsonb_array_elements(r.snapshot->'health'->'factors') f),
              r."workPct", r."plannedPct", r."weekStart", r.status,
              COALESCE(r.status = 'submitted', false)
       FROM projects p
       JOIN companies c ON c.id = p."companyId"
       JOIN customer_contracts cc ON cc.id = p."contractId"
       LEFT JOIN customers cu ON cu.id = p."customerId"
       LEFT JOIN users u ON u.id = p."managerUserId"
       LEFT JOIN LATERAL (
         SELECT * FROM project_status_reports s
         WHERE s."projectId" = p.id
         ORDER BY s."weekStart" DESC LIMIT 1
       ) r ON true`,
    ],
  },
  {
    // CD-192 — projects by health per week, from every report kept
    table: 'project_health_weekly',
    sql: [
      `DELETE FROM mart.project_health_weekly`,
      `INSERT INTO mart.project_health_weekly
       SELECT s."weekStart", c.code, s."healthLevel", count(*)::int
       FROM project_status_reports s
       JOIN companies c ON c.id = s."companyId"
       GROUP BY 1, 2, 3`,
    ],
  },
  {
    // CD-235 — Utilization per person × month, the last 12 months (this
    // month to date). Available = the company's working days (its weekdays,
    // less its holidays — the SLA calendar) × 8, less approved leave (half a
    // day = 4). Logged = approved timesheets. Hours only: no rate, no cost.
    table: 'fact_utilization',
    sql: [
      `DELETE FROM mart.fact_utilization`,
      `INSERT INTO mart.fact_utilization
       WITH today AS (
         SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
       ),
       months AS (
         SELECT to_char(m, 'YYYY-MM') AS month, m::date AS first_day,
                LEAST((m + interval '1 month - 1 day')::date, today.d) AS last_day
         FROM today, generate_series(
           date_trunc('month', today.d) - interval '11 months',
           date_trunc('month', today.d), interval '1 month') m
       ),
       calendars AS (
         SELECT c.id AS company_id, c.code,
                COALESCE(NULLIF(h."workingWeekdays", '{}'), '{1,2,3,4,5}') AS weekdays,
                COALESCE(h.holidays, '[]'::jsonb) AS holidays
         FROM companies c
         LEFT JOIN holiday_calendars h ON h."companyId" = c.id
       ),
       work_days AS (
         SELECT k.company_id, k.code, mo.month, d::date AS day
         FROM calendars k
         CROSS JOIN months mo
         CROSS JOIN generate_series(mo.first_day, mo.last_day, interval '1 day') d
         WHERE extract(isodow FROM d)::int = ANY (k.weekdays)
           AND NOT (k.holidays ? to_char(d, 'YYYY-MM-DD'))
       ),
       people AS (
         SELECT "companyId" AS company_id, "userId" AS user_id
         FROM hr_employees WHERE status <> 'resigned'
         UNION
         SELECT "companyId", "userId" FROM hr_timesheets WHERE status = 'approved'
       ),
       capacity AS (
         SELECT p.company_id, wd.code, p.user_id, wd.month,
                count(*) * ${HOURS_PER_MANDAY} AS working,
                sum(LEAST(${HOURS_PER_MANDAY}, COALESCE(lv.hours, 0))) AS leave
         FROM people p
         JOIN work_days wd ON wd.company_id = p.company_id
         LEFT JOIN LATERAL (
           SELECT sum(CASE WHEN l.part = 'full' THEN ${HOURS_PER_MANDAY}
                           ELSE ${HOURS_PER_MANDAY} / 2 END) AS hours
           FROM hr_leaves l
           WHERE l."companyId" = p.company_id AND l."userId" = p.user_id
             AND l.status = 'approved'
             AND wd.day BETWEEN l."startDate" AND l."endDate"
         ) lv ON true
         GROUP BY 1, 2, 3, 4
       ),
       logged AS (
         SELECT t."companyId" AS company_id, t."userId" AS user_id,
                to_char(l."workDate", 'YYYY-MM') AS month,
                sum(l.hours) AS hours,
                COALESCE(sum(l.hours) FILTER (WHERE l.billable), 0) AS billable,
                COALESCE(sum(l.hours) FILTER (WHERE l.kind = 'project'), 0) AS project,
                COALESCE(sum(l.hours) FILTER (WHERE l.kind = 'service'), 0) AS service,
                COALESCE(sum(l.hours) FILTER (WHERE l.kind = 'presales'), 0) AS presales,
                COALESCE(sum(l.hours) FILTER (WHERE l.kind = 'internal'), 0) AS internal
         FROM hr_timesheet_lines l
         JOIN hr_timesheets t ON t.id = l."timesheetId" AND t.status = 'approved'
         GROUP BY 1, 2, 3
       )
       SELECT cap.code, cap.month, cap.user_id, u."displayName", ou.name,
              lv.code, lv.name,
              cap.working, cap.leave, cap.working - cap.leave,
              COALESCE(lg.hours, 0), COALESCE(lg.billable, 0),
              COALESCE(lg.project, 0), COALESCE(lg.service, 0),
              COALESCE(lg.presales, 0), COALESCE(lg.internal, 0),
              GREATEST(cap.working - cap.leave - COALESCE(lg.hours, 0), 0),
              round(100.0 * COALESCE(lg.billable, 0)
                    / NULLIF(cap.working - cap.leave, 0), 1),
              round(100.0 * lg.billable / NULLIF(lg.hours, 0), 1)
       FROM capacity cap
       LEFT JOIN logged lg ON lg.company_id = cap.company_id
         AND lg.user_id = cap.user_id AND lg.month = cap.month
       LEFT JOIN users u ON u.id = cap.user_id
       LEFT JOIN org_units ou ON ou.id = u."orgUnitId"
       LEFT JOIN hr_employees e
         ON e."companyId" = cap.company_id AND e."userId" = cap.user_id
       LEFT JOIN hr_levels lv ON lv.id = e."levelId"`,
    ],
  },
  {
    // CD-256 — every phase (milestone, not cancelled) of every project: its
    // deliveries (CD-250), its acceptance (CD-189) and whether that came by
    // the milestone's due day; points still open; certificate (CD-252) and
    // handover to the service team (CD-255).
    table: 'fact_delivery_phases',
    sql: [
      `DELETE FROM mart.fact_delivery_phases`,
      `INSERT INTO mart.fact_delivery_phases
       WITH today AS (
         SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
       ),
       trips AS (
         SELECT "milestoneId" AS milestone_id,
                count(*) FILTER (WHERE status <> 'cancelled')::int AS planned,
                count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
                max("plannedOn") FILTER (WHERE status = 'delivered') AS last_on
         FROM project_deliveries GROUP BY 1
       ),
       rounds AS (
         SELECT "milestoneId" AS milestone_id,
                count(*) FILTER (WHERE status <> 'cancelled')::int AS rounds,
                min(seq) FILTER (WHERE status <> 'cancelled') AS first_seq
         FROM project_acceptances WHERE "milestoneId" IS NOT NULL GROUP BY 1
       ),
       passed AS (
         SELECT DISTINCT ON ("milestoneId") "milestoneId" AS milestone_id,
                id, seq, status, "decidedOn"::date AS decided_on
         FROM project_acceptances
         WHERE "milestoneId" IS NOT NULL
           AND status IN ('accepted', 'conditional')
         ORDER BY "milestoneId", seq
       ),
       open_items AS (
         SELECT a."milestoneId" AS milestone_id, count(*)::int AS n
         FROM project_acceptance_items i
         JOIN project_acceptances a ON a.id = i."acceptanceId"
         WHERE i.status = 'open' AND a."milestoneId" IS NOT NULL
         GROUP BY 1
       )
       SELECT c.code, p.id, p."projectNo", p.name, p.status::text,
              cu."nameTh", u."displayName",
              m.id, m.seq, m.title, m."dueOn"::date,
              COALESCE(t.planned, 0), COALESCE(t.delivered, 0), t.last_on::date,
              COALESCE(r.rounds, 0),
              CASE
                WHEN pa.id IS NOT NULL THEN 'accepted'
                WHEN COALESCE(r.rounds, 0) > 0 THEN 'in_acceptance'
                WHEN COALESCE(t.planned, 0) > 0
                     AND t.delivered = t.planned THEN 'delivered'
                WHEN COALESCE(t.delivered, 0) > 0 THEN 'delivering'
                ELSE 'not_started'
              END,
              pa.decided_on, to_char(pa.decided_on, 'YYYY-MM'), pa.status,
              CASE WHEN pa.id IS NULL THEN NULL ELSE pa.seq = r.first_seq END,
              CASE WHEN pa.decided_on IS NULL OR m."dueOn" IS NULL THEN NULL
                   ELSE pa.decided_on <= m."dueOn"::date END,
              CASE
                WHEN m."dueOn" IS NULL THEN NULL
                WHEN pa.decided_on IS NOT NULL
                  THEN GREATEST(pa.decided_on - m."dueOn"::date, 0)
                ELSE NULLIF(GREATEST(today.d - m."dueOn"::date, 0), 0)
              END,
              COALESCE(oi.n, 0),
              EXISTS (SELECT 1 FROM acceptance_certificates ac
                      WHERE ac."acceptanceId" = pa.id AND ac.status = 'signed'),
              (SELECT h.status FROM service_handovers h
               WHERE h."acceptanceId" = pa.id)
       FROM project_milestones m
       CROSS JOIN today
       JOIN projects p ON p.id = m."projectId"
       JOIN companies c ON c.id = p."companyId"
       LEFT JOIN customers cu ON cu.id = p."customerId"
       LEFT JOIN users u ON u.id = p."managerUserId"
       LEFT JOIN trips t ON t.milestone_id = m.id
       LEFT JOIN rounds r ON r.milestone_id = m.id
       LEFT JOIN passed pa ON pa.milestone_id = m.id
       LEFT JOIN open_items oi ON oi.milestone_id = m.id
       WHERE m.status <> 'cancelled' AND p.status::text <> 'cancelled'`,
    ],
  },
  {
    // CD-256 — every installment billed (an invoice day recorded, by hand
    // CD-193 or read back from SAP CD-253): due ${DEFAULT_CREDIT_DAYS} days
    // after the invoice, as CD-193 counts it; overdue while unpaid after that.
    table: 'fact_receivables',
    sql: [
      `DELETE FROM mart.fact_receivables`,
      `INSERT INTO mart.fact_receivables
       WITH today AS (
         SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date AS d
       )
       SELECT c.code, cc.id, cc."contractNo", i.seq, i.label, i.kind,
              p.id, p."projectNo", p.name, cu."nameTh",
              cc."ownerUserId", u."displayName",
              i.amount, b."invoiceNo", b."invoicedOn"::date, b."invoicedAmount",
              b."invoicedOn"::date + ${DEFAULT_CREDIT_DAYS},
              b."paidOn"::date, b."paidAmount",
              CASE
                WHEN b."paidOn" IS NOT NULL THEN 'paid'
                WHEN b."invoicedOn"::date + ${DEFAULT_CREDIT_DAYS} < today.d
                  THEN 'overdue'
                ELSE 'open'
              END,
              CASE
                WHEN b."paidOn" IS NULL
                     AND b."invoicedOn"::date + ${DEFAULT_CREDIT_DAYS} < today.d
                  THEN today.d - (b."invoicedOn"::date + ${DEFAULT_CREDIT_DAYS})
              END
       FROM contract_installment_billings b
       CROSS JOIN today
       JOIN contract_installments i
         ON i."contractId" = b."contractId" AND i.seq = b.seq
       JOIN customer_contracts cc ON cc.id = b."contractId"
       JOIN companies c ON c.id = cc."companyId"
       LEFT JOIN projects p ON p."contractId" = cc.id
       LEFT JOIN customers cu ON cu.id = COALESCE(p."customerId", cc."customerId")
       LEFT JOIN users u ON u.id = cc."ownerUserId"
       WHERE b."invoicedOn" IS NOT NULL`,
    ],
  },
  // CD-274 — campaign results to revenue
  ...CAMPAIGN_MART_TABLES,
];

/**
 * CD-92 — tables filled from rows the application computes (the Keeper's
 * health, KeeperService) rather than from SQL alone. Rebuilt in the same
 * transaction, after {@link MART_TABLES}.
 */
export const COMPUTED_TABLES = [
  'customer_accounts',
  'customer_health_daily',
] as const;

/** Rows per INSERT when writing computed rows (one JSON parameter each). */
const COMPUTED_BATCH = 500;

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
  async rebuild(
    accounts: readonly object[] = [],
  ): Promise<{ table: string; rows: number; ms: number }[] | false> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
          `SELECT pg_try_advisory_xact_lock(hashtext('ctd.mart.rebuild')) AS locked`,
        );
        if (!lock?.locked) return false;

        const done: { table: string; rows: number; ms: number }[] = [];
        const steps: { table: string; run: () => Promise<void> }[] = [
          // CD-208 — the pricing mart rides the same rebuild.
          ...[...MART_TABLES, ...PRICING_MART_TABLES].map((step) => ({
            table: step.table,
            run: async () => {
              for (const statement of step.sql) {
                await tx.$executeRawUnsafe(statement);
              }
            },
          })),
          {
            table: 'customer_accounts',
            run: async () => {
              await tx.$executeRawUnsafe(`DELETE FROM mart.customer_accounts`);
              for (let at = 0; at < accounts.length; at += COMPUTED_BATCH) {
                // The rows are the application's own objects, passed as one
                // JSON parameter — never spliced into the statement.
                await tx.$executeRawUnsafe(
                  `INSERT INTO mart.customer_accounts
                   SELECT * FROM jsonb_populate_recordset(
                     NULL::mart.customer_accounts, $1::jsonb)`,
                  JSON.stringify(accounts.slice(at, at + COMPUTED_BATCH)),
                );
              }
            },
          },
          {
            table: 'customer_health_daily',
            run: async () => {
              await tx.$executeRawUnsafe(
                `DELETE FROM mart.customer_health_daily
                 WHERE snapshot_date = ${BKK_TODAY}`,
              );
              await tx.$executeRawUnsafe(
                `INSERT INTO mart.customer_health_daily
                 SELECT ${BKK_TODAY}, company_code, health, count(*)::int
                 FROM mart.customer_accounts
                 GROUP BY company_code, health`,
              );
            },
          },
        ];
        for (const step of steps) {
          const started = Date.now();
          await step.run();
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
    return [
      ...MART_TABLES.map(({ table }) => table),
      ...COMPUTED_TABLES,
      ...PRICING_MART_TABLES.map(({ table }) => table),
    ].map(
      (table) =>
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
      table === 'request_backlog_daily' || table === 'customer_health_daily'
        ? `SELECT count(*)::int AS n FROM mart.${table}
           WHERE snapshot_date = ${BKK_TODAY}`
        : `SELECT count(*)::int AS n FROM ${martTableName(table)}`,
    );
    return row?.n ?? 0;
  }
}
