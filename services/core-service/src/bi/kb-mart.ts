/**
 * CD-266 (CD-22 KBMS) — the knowledge base in the Data Mart, rebuilt with
 * the rest: how often the AI channels answered by themselves, month by
 * month and channel (CD-265), and the knowledge gaps opened and filled.
 * Counts only — no question or answer text reaches the mart. CD-288: an
 * answer a conversation then went to a person after is handed off, not
 * answered by AI alone (self_answered, self_answer_pct).
 */

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;
const month = (column: string) => `to_char(${bkk(column)}, 'YYYY-MM')`;

export const KB_MART_TABLES: readonly { table: string; sql: string[] }[] = [
  {
    table: 'fact_kb_ai_monthly',
    sql: [
      `DELETE FROM mart.fact_kb_ai_monthly`,
      `INSERT INTO mart.fact_kb_ai_monthly
       SELECT c.code, ${month('q."createdAt"')}, q.channel,
              count(*)::int,
              count(*) FILTER (WHERE q.outcome = 'answered')::int,
              count(*) FILTER (WHERE q.outcome = 'unanswered')::int,
              count(*) FILTER (WHERE q.outcome = 'pending')::int,
              round(100.0 * count(*) FILTER (WHERE q.outcome = 'answered' AND q."handedOffAt" IS NULL)
                    / NULLIF(count(*) FILTER (WHERE q.outcome IN ('answered', 'unanswered')), 0), 1),
              -- CD-288 — the conversation went to a person after it
              count(*) FILTER (WHERE q."handedOffAt" IS NOT NULL)::int,
              count(*) FILTER (WHERE q.outcome = 'answered' AND q."handedOffAt" IS NULL)::int
       FROM kb_ai_queries q
       JOIN companies c ON c.id = q."companyId"
       GROUP BY 1, 2, 3`,
    ],
  },
  {
    table: 'fact_kb_gaps_monthly',
    sql: [
      `DELETE FROM mart.fact_kb_gaps_monthly`,
      `INSERT INTO mart.fact_kb_gaps_monthly
       WITH opened AS (
         SELECT "companyId" AS cid, ${month('"firstSeenAt"')} AS month, kind, count(*)::int AS n
         FROM kb_gaps WHERE kind <> 'search_miss' OR occurrences >= 3
         GROUP BY 1, 2, 3
       ),
       closed AS (
         SELECT "companyId" AS cid, ${month('"resolvedAt"')} AS month, kind,
                count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
                count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
         FROM kb_gaps WHERE "resolvedAt" IS NOT NULL
         GROUP BY 1, 2, 3
       )
       SELECT c.code, COALESCE(o.month, x.month), COALESCE(o.kind, x.kind),
              COALESCE(o.n, 0), COALESCE(x.resolved, 0), COALESCE(x.dismissed, 0)
       FROM opened o
       FULL JOIN closed x ON x.cid = o.cid AND x.month = o.month AND x.kind = o.kind
       JOIN companies c ON c.id = COALESCE(o.cid, x.cid)`,
    ],
  },
];
