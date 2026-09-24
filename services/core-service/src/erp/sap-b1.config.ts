/**
 * ERP_B1_COMPANY_DBS → `{ OSD: 'SBO_OSD', LEXTECH: 'SBO_LEX' }`.
 * Format `CODE=CompanyDB,CODE=CompanyDB`; blanks and malformed pairs skipped.
 */
export function parseCompanyDbs(
  raw: string | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [code, db] = pair.split('=').map((part) => part.trim());
    if (code && db) map[code] = db;
  }
  return map;
}
