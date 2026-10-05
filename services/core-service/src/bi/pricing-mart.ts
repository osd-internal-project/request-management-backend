/**
 * CD-208 — วิเคราะห์ราคาและกำไร: the pricing mart (`mart_pricing`), rebuilt
 * in the Data Mart's transaction. Kept apart from `mart` because it carries
 * margins, costs and discounts, which Metabase's `metabase_ro` must not read
 * (SCOPE-04); the app reads it with `pricing.price.read`.
 */

import { HOURS_PER_MANDAY } from '../hr/timesheet-rules';

/** A `timestamp` column (stored as UTC, no zone) as Bangkok wall-clock time. */
const bkk = (column: string) =>
  `((${column}) AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'`;

/** Quotation versions that went past approval — what the analysis counts. */
export const COUNTED_QUOTATION_STATUSES = [
  'approved',
  'sent',
  'accepted',
  'declined',
] as const;

const COUNTED = `(${COUNTED_QUOTATION_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * Who the cost came from, read off the line's cost source: an SAP cost is
 * "SAP: … · <vendor>" (CD-206), a partner quote "ใบเสนอราคาคู่ค้า: <vendor>"
 * (CD-198), possibly marked expired. Anything else has no vendor.
 */
export const VENDOR_SQL = `CASE
  WHEN ql."costSource" LIKE 'SAP:%'
    THEN NULLIF(btrim(split_part(ql."costSource", ' · ', 2)), '')
  WHEN ql."costSource" LIKE 'ใบเสนอราคาคู่ค้า:%'
    THEN NULLIF(btrim(regexp_replace(
      substr(ql."costSource", length('ใบเสนอราคาคู่ค้า:') + 1),
      '\\s*\\(หมดอายุ\\)$', '')), '')
  ELSE NULL END`;

/** Each pricing-mart table and the statements that rebuild it, in order. */
export const PRICING_MART_TABLES: readonly { table: string; sql: string[] }[] =
  [
    {
      table: 'pricing.fact_quotation_lines',
      sql: [
        `DELETE FROM mart_pricing.fact_quotation_lines`,
        // The gross is the billed quantity × the unit price (CD-196: a lump
        // sum is quantity 1, a monthly line counts its months).
        `INSERT INTO mart_pricing.fact_quotation_lines
         SELECT q.id, ql."lineNo", q."quotationNo", q.version, c.code,
                q.status::text, q.status = 'accepted',
                (${bkk('q."approvedAt"')})::date,
                to_char(${bkk('q."approvedAt"')}, 'YYYY-MM'),
                q.currency, cu."customerCode", q."partyName",
                o."opportunityCode", q."ownerUserId", u."displayName", ou.name,
                ql."productCode", p."groupName", ql."workType", ql."priceModel",
                g.gross, ql."discountPct", g.gross - ql."lineTotal",
                ql."lineTotal", ql."lineCost", ql."lineTotal" - ql."lineCost",
                ql."costSource", ${VENDOR_SQL},
                ql."systemPrice" IS NOT NULL, ql."systemPrice"
         FROM quotation_lines ql
         JOIN quotations q ON q.id = ql."quotationId"
         JOIN companies c ON c.id = q."companyId"
         LEFT JOIN opportunities o ON o.id = q."opportunityId"
         LEFT JOIN customers cu ON cu.id = COALESCE(q."customerId", o."customerId")
         LEFT JOIN users u ON u.id = q."ownerUserId"
         LEFT JOIN org_units ou ON ou.id = q."ownerOrgUnitId"
         LEFT JOIN products p
           ON p."companyId" = q."companyId" AND p.code = ql."productCode"
         CROSS JOIN LATERAL (
           SELECT round(ql."unitPrice" * ql.quantity *
             CASE WHEN ql."priceModel" = 'monthly'
                  THEN COALESCE(ql."termMonths", 1) ELSE 1 END, 2) AS gross
         ) g
         WHERE q.status IN ${COUNTED}`,
      ],
    },
    {
      table: 'pricing.fact_pricing_exceptions',
      sql: [
        `DELETE FROM mart_pricing.fact_pricing_exceptions`,
        `INSERT INTO mart_pricing.fact_pricing_exceptions
         SELECT pe.id, c.code, pe.kind, pe.decision,
                (${bkk('pe."createdAt"')})::date,
                to_char(${bkk('pe."createdAt"')}, 'YYYY-MM'),
                pe."quotationNo", pe.version, pe."partyName", pe."workType",
                pe."productCode", pe."netTotal"
         FROM pricing_exceptions pe
         JOIN companies c ON c.id = pe."companyId"
         WHERE pe.decision <> 'superseded'`,
      ],
    },
    {
      // CD-234 — approved hours priced with the rate in effect on the day
      // worked (the person's level now × the line's work type), as
      // LaborCostService prices them; no level or no rate = unpriced (null).
      table: 'pricing.fact_labor_costs',
      sql: [
        `DELETE FROM mart_pricing.fact_labor_costs`,
        `INSERT INTO mart_pricing.fact_labor_costs
         SELECT l.id, c.code, l."workDate", to_char(l."workDate", 'YYYY-MM'),
                l.kind, p."projectNo", r."requestNo", r."typeCode",
                l."solutionId", l."internalCode", t."userId", u."displayName",
                lv.code, wt.code, l.hours, l.billable,
                rate."costPerManday",
                round(l.hours / ${HOURS_PER_MANDAY} * rate."costPerManday", 2)
         FROM hr_timesheet_lines l
         JOIN hr_timesheets t ON t.id = l."timesheetId" AND t.status = 'approved'
         JOIN companies c ON c.id = t."companyId"
         JOIN hr_work_types wt ON wt.id = l."workTypeId"
         LEFT JOIN hr_employees e
           ON e."companyId" = t."companyId" AND e."userId" = t."userId"
         LEFT JOIN hr_levels lv ON lv.id = e."levelId"
         LEFT JOIN projects p ON p.id = l."projectId"
         LEFT JOIN requests r ON r.id = l."requestId"
         LEFT JOIN users u ON u.id = t."userId"
         LEFT JOIN LATERAL (
           SELECT hr."costPerManday"
           FROM hr_labor_rates hr
           WHERE hr."companyId" = t."companyId"
             AND hr."levelId" = e."levelId"
             AND hr."workTypeId" = l."workTypeId"
             AND hr."deletedAt" IS NULL
             AND hr."validFrom" <= l."workDate"
             AND (hr."validTo" IS NULL OR hr."validTo" >= l."workDate")
           ORDER BY hr."validFrom" DESC
           LIMIT 1
         ) rate ON true`,
      ],
    },
  ];

/** `pricing.<table>` → `mart_pricing.<table>`; anything else lives in `mart`. */
export function martTableName(table: string): string {
  return table.startsWith('pricing.')
    ? `mart_pricing.${table.slice('pricing.'.length)}`
    : `mart.${table}`;
}
