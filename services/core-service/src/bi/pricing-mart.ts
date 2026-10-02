/**
 * CD-208 — วิเคราะห์ราคาและกำไร: the pricing mart (`mart_pricing`), rebuilt
 * in the Data Mart's transaction. Kept apart from `mart` because it carries
 * margins, costs and discounts, which Metabase's `metabase_ro` must not read
 * (SCOPE-04); the app reads it with `pricing.price.read`.
 */

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
  ];

/** `pricing.<table>` → `mart_pricing.<table>`; anything else lives in `mart`. */
export function martTableName(table: string): string {
  return table.startsWith('pricing.')
    ? `mart_pricing.${table.slice('pricing.'.length)}`
    : `mart.${table}`;
}
