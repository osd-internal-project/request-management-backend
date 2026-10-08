/**
 * CD-295 (CD-16 AI SMART) — from a swept business to a won deal, in the Data
 * Mart. Each prospect is counted once, at the furthest stage it reached
 * (user decision 8 ต.ค. 2569):
 *
 *   swept → screened → called → reached → interested → handed off → deal → won
 *
 * "Reached" is a call someone answered (interested, not interested, refused).
 * A deal is the Lead it became, converted to an opportunity, or the upsell
 * deal opened for its account owner (CD-294); won is that deal's stage.
 * A prospect on several call lists counts to the one it was put on last.
 */

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;
const month = (column: string) => `to_char(${bkk(column)}, 'YYYY-MM')`;

const ANSWERED = `('interested', 'not_interested', 'refused')`;

export const SMART_MART_TABLES: readonly { table: string; sql: string[] }[] = [
  {
    table: 'fact_smart_prospects',
    sql: [
      `DELETE FROM mart.fact_smart_prospects`,
      `INSERT INTO mart.fact_smart_prospects
       WITH last_list AS (
         SELECT DISTINCT ON (t."prospectId") t."prospectId" AS pid,
                l.id AS list_id, l.name AS list_name
         FROM smart_call_targets t
         JOIN smart_call_lists l ON l.id = t."listId"
         ORDER BY t."prospectId", t."createdAt" DESC
       ),
       call_counts AS (
         SELECT "prospectId" AS pid, count(*)::int AS calls,
                bool_or(outcome IN ${ANSWERED}) AS reached,
                bool_or(outcome = 'refused') AS refused
         FROM smart_calls GROUP BY 1
       ),
       deals AS (
         SELECT p.id AS pid,
                COALESCE(p."keeperOpportunityId", l."convertedOpportunityId") AS oid
         FROM smart_prospects p
         LEFT JOIN leads l ON l.id = p."leadId"
       )
       SELECT p.id, c.code, s.id, s.code, s.name, s.kind,
              COALESCE(p."handoffAxis", p."salesAxis"),
              ll.list_id, ll.list_name,
              ${month('p."createdAt"')},
              p.status, p.score, p."matchKind",
              p."screenedAt" IS NOT NULL OR p.status IN ('screened', 'sent'),
              COALESCE(cc.calls, 0) > 0,
              COALESCE(cc.reached, false),
              COALESCE(cc.refused, false),
              p."interestedAt" IS NOT NULL,
              p."handedOffAt" IS NOT NULL,
              d.oid IS NOT NULL,
              COALESCE(o.stage::text = 'won', false),
              COALESCE(cc.calls, 0)
       FROM smart_prospects p
       JOIN smart_sources s ON s.id = p."sourceId"
       JOIN companies c ON c.id = p."companyId"
       LEFT JOIN last_list ll ON ll.pid = p.id
       LEFT JOIN call_counts cc ON cc.pid = p.id
       LEFT JOIN deals d ON d.pid = p.id
       LEFT JOIN opportunities o ON o.id = d.oid`,
    ],
  },
  {
    table: 'fact_smart_calls',
    sql: [
      `DELETE FROM mart.fact_smart_calls`,
      `INSERT INTO mart.fact_smart_calls
       SELECT k.id, c.code, k."listId", l.name, s.code,
              COALESCE(p."handoffAxis", p."salesAxis"),
              ${month('k."startedAt"')},
              k.status, k.outcome, k."durationSec",
              k.outcome IN ${ANSWERED}
       FROM smart_calls k
       JOIN smart_call_lists l ON l.id = k."listId"
       JOIN smart_prospects p ON p.id = k."prospectId"
       JOIN smart_sources s ON s.id = p."sourceId"
       JOIN companies c ON c.id = k."companyId"`,
    ],
  },
];
