import { careAnsweredSql, careResultSql } from '../care/care-results';

/**
 * CD-288 (CD-23 AI CARE) — every AI CARE conversation in the Data Mart, with
 * how it ended (care-results.ts): AI closed it by itself, a case was opened,
 * or a person took part — by channel and Bangkok month. Counts and times
 * only; no message text reaches the mart.
 */

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;
const month = (column: string) => `to_char(${bkk(column)}, 'YYYY-MM')`;
const minutes = (from: string, to: string) =>
  `(EXTRACT(EPOCH FROM (${to} - ${from})) / 60)::int`;

export const CARE_MART_TABLES: readonly { table: string; sql: string[] }[] = [
  {
    table: 'fact_care_conversations',
    sql: [
      `DELETE FROM mart.fact_care_conversations`,
      `INSERT INTO mart.fact_care_conversations
       SELECT c.id, co.code, c.channel, ${month('c."openedAt"')},
              c.status, c.outcome, ${careResultSql('c', 'a.n')},
              c.identification, cu."customerCode", c."handoverReason",
              c.messages, COALESCE(k.customer, 0), COALESCE(k.ai, 0),
              COALESCE(a.n, 0), COALESCE(k.agent, 0),
              ${minutes('c."openedAt"', 'c."humanAt"')},
              ${minutes('c."openedAt"', 'c."closedAt"')}
       FROM care_conversations c
       JOIN companies co ON co.id = c."companyId"
       LEFT JOIN customers cu ON cu.id = c."customerId"
       LEFT JOIN LATERAL ${careAnsweredSql('c')} a ON true
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE m.author = 'customer')::int AS customer,
                count(*) FILTER (WHERE m.author = 'ai')::int AS ai,
                count(*) FILTER (WHERE m.author = 'agent')::int AS agent
         FROM care_messages m WHERE m."conversationId" = c.id
       ) k ON true`,
    ],
  },
];
