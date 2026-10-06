/**
 * CD-274 — วัดผลแคมเปญถึงรายได้จริง: two Data Mart tables, rebuilt with the
 * rest of the mart. A deal counts to the campaign of the Lead it came from
 * (first touch, user decision 6 ต.ค. 2569); its money is booked (sale orders
 * not cancelled), invoiced and paid (the installments of the contracts on
 * that deal, from SAP or recorded by hand), set against the campaign's actual
 * spend (CD-268, voided spend left out).
 */

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;
const month = (column: string) => `to_char(${bkk(column)}, 'YYYY-MM')`;

/** The Lead → deal link every figure hangs on. */
const DEALS = `deals AS (
  SELECT l."campaignId" AS cid, o.id AS oid, o.stage::text AS stage, o."wonAt"
  FROM leads l
  JOIN opportunities o ON o.id = l."convertedOpportunityId"
  WHERE l."campaignId" IS NOT NULL
)`;

export const CAMPAIGN_MART_TABLES: readonly { table: string; sql: string[] }[] =
  [
    {
      table: 'fact_campaigns',
      sql: [
        `DELETE FROM mart.fact_campaigns`,
        `INSERT INTO mart.fact_campaigns
         WITH ${DEALS},
         lead_counts AS (
           SELECT "campaignId" AS cid, count(*)::int AS leads,
                  count("convertedOpportunityId")::int AS converted
           FROM leads WHERE "campaignId" IS NOT NULL GROUP BY 1
         ),
         won AS (
           SELECT cid, count(*)::int AS won FROM deals
           WHERE stage = 'won' GROUP BY cid
         ),
         booked AS (
           SELECT d.cid, sum(so.amount) AS amount
           FROM deals d
           JOIN sale_orders so
             ON so."opportunityId" = d.oid AND so.status::text <> 'cancelled'
           GROUP BY d.cid
         ),
         billed AS (
           SELECT d.cid, sum(b."invoicedAmount") AS invoiced,
                  sum(b."paidAmount") AS paid
           FROM deals d
           JOIN customer_contracts cc ON cc."opportunityId" = d.oid
           JOIN contract_installment_billings b ON b."contractId" = cc.id
           GROUP BY d.cid
         ),
         spend AS (
           SELECT "campaignId" AS cid, sum(amount) AS spent
           FROM campaign_spends WHERE "voidedAt" IS NULL GROUP BY 1
         )
         SELECT ca.id, c.code, c.name, ca.code, ca.name, ca.kind,
                ca."salesAxis", ca.channel, ca."startDate"::date,
                ca."endDate"::date, ca.active, ca.budget,
                COALESCE(sp.spent, 0), COALESCE(lc.leads, 0),
                COALESCE(lc.converted, 0), COALESCE(w.won, 0),
                COALESCE(bk.amount, 0), COALESCE(bl.invoiced, 0),
                COALESCE(bl.paid, 0),
                round(sp.spent / NULLIF(lc.leads, 0), 2),
                round(sp.spent / NULLIF(w.won, 0), 2),
                round(bl.paid / NULLIF(sp.spent, 0), 2),
                round(bk.amount / NULLIF(sp.spent, 0), 2)
         FROM campaigns ca
         JOIN companies c ON c.id = ca."companyId"
         LEFT JOIN lead_counts lc ON lc.cid = ca.id
         LEFT JOIN won w ON w.cid = ca.id
         LEFT JOIN booked bk ON bk.cid = ca.id
         LEFT JOIN billed bl ON bl.cid = ca.id
         LEFT JOIN spend sp ON sp.cid = ca.id`,
      ],
    },
    {
      table: 'fact_campaign_monthly',
      sql: [
        `DELETE FROM mart.fact_campaign_monthly`,
        `INSERT INTO mart.fact_campaign_monthly
         WITH ${DEALS},
         events AS (
           SELECT "campaignId" AS cid, to_char("spentOn", 'YYYY-MM') AS m,
                  amount AS spent, 0 AS leads, 0 AS won,
                  0::numeric AS booked, 0::numeric AS invoiced, 0::numeric AS paid
           FROM campaign_spends WHERE "voidedAt" IS NULL
           UNION ALL
           SELECT "campaignId", ${month('"createdAt"')}, 0, 1, 0, 0, 0, 0
           FROM leads WHERE "campaignId" IS NOT NULL
           UNION ALL
           SELECT cid, ${month('"wonAt"')}, 0, 0, 1, 0, 0, 0
           FROM deals WHERE stage = 'won' AND "wonAt" IS NOT NULL
           UNION ALL
           SELECT d.cid, ${month('so."orderedAt"')}, 0, 0, 0, so.amount, 0, 0
           FROM deals d
           JOIN sale_orders so
             ON so."opportunityId" = d.oid AND so.status::text <> 'cancelled'
           WHERE so.amount IS NOT NULL
           UNION ALL
           SELECT d.cid, to_char(b."invoicedOn", 'YYYY-MM'), 0, 0, 0, 0,
                  b."invoicedAmount", 0
           FROM deals d
           JOIN customer_contracts cc ON cc."opportunityId" = d.oid
           JOIN contract_installment_billings b ON b."contractId" = cc.id
           WHERE b."invoicedOn" IS NOT NULL AND b."invoicedAmount" IS NOT NULL
           UNION ALL
           SELECT d.cid, to_char(b."paidOn", 'YYYY-MM'), 0, 0, 0, 0, 0,
                  b."paidAmount"
           FROM deals d
           JOIN customer_contracts cc ON cc."opportunityId" = d.oid
           JOIN contract_installment_billings b ON b."contractId" = cc.id
           WHERE b."paidOn" IS NOT NULL AND b."paidAmount" IS NOT NULL
         )
         SELECT ca.id, c.code, ca.code, e.m,
                sum(e.spent), sum(e.leads)::int, sum(e.won)::int,
                sum(e.booked), sum(e.invoiced), sum(e.paid)
         FROM events e
         JOIN campaigns ca ON ca.id = e.cid
         JOIN companies c ON c.id = ca."companyId"
         GROUP BY ca.id, c.code, ca.code, e.m`,
      ],
    },
  ];
