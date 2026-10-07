/**
 * CD-279 — what the AI audit log keeps of an MCP call, decided without a
 * database so it can be tested on its own.
 *
 * The log answers "who asked what, and which records answered" — never the
 * records' contents. A write tool's arguments *are* a record's contents (a
 * new lead's name and phone), so of those only the field names are kept.
 */

/** A filter value longer than this is cut — a search, not a document. */
export const MAX_ARG_LENGTH = 200;
/** Row ids kept per call. */
export const MAX_RESULT_IDS = 100;
export const DEFAULT_RETENTION_DAYS = 365;
export const MIN_RETENTION_DAYS = 30;
export const MAX_RETENTION_DAYS = 3650;

/** `crm_post_leads`, `crm_patch_leads_id_owner` … change data; `_get_` reads. */
export function isWriteTool(tool: string): boolean {
  return /_(post|patch|put|delete)_/.test(tool);
}

function cut(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_ARG_LENGTH
      ? `${value.slice(0, MAX_ARG_LENGTH)}…`
      : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(cut);
  if (typeof value === 'object' && value !== null) return '[object]';
  return value;
}

/**
 * The arguments as the log keeps them: a read's filters (cut short), or a
 * write's field names only.
 */
export function auditArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (isWriteTool(tool)) return { fields: Object.keys(args).sort() };
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, cut(value)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A row's own id — or, for a shaped assistant row, the last part of its link. */
function idOf(row: Record<string, unknown>): string | null {
  for (const key of ['id', 'request_id', 'case_id']) {
    if (typeof row[key] === 'string') return row[key];
  }
  if (typeof row.link === 'string') {
    const last = row.link.split('/').filter(Boolean).pop();
    return last ?? null;
  }
  return null;
}

/**
 * Which rows answered and how many there were — read from the shapes the
 * tools return: a §11.1 page (`data` + `total`), `items`, a bare list, a
 * single record, or sections of those (the silent-deals answer).
 */
export function auditResult(value: unknown): { ids: string[]; count: number } {
  const ids: string[] = [];
  let count = 0;

  const rows = (list: unknown[], total: unknown) => {
    for (const row of list) {
      if (!isRecord(row)) continue;
      const id = idOf(row);
      if (id) ids.push(id);
    }
    count += typeof total === 'number' ? total : list.length;
  };

  const walk = (node: unknown, depth: number) => {
    if (Array.isArray(node)) return rows(node, undefined);
    if (!isRecord(node)) return;
    if (Array.isArray(node.data)) return rows(node.data, node.total);
    if (Array.isArray(node.items)) return rows(node.items, node.total);
    // One record — by its own id, not a section's link to a list page.
    if (depth === 0 && ['id', 'request_id', 'case_id'].some((k) => k in node)) {
      return rows([node], 1);
    }
    if (depth < 1) {
      for (const child of Object.values(node)) walk(child, depth + 1);
    }
  };

  walk(value, 0);
  return { ids: [...new Set(ids)].slice(0, MAX_RESULT_IDS), count };
}

/** The day before which a company's AI logs are removed. */
export function retentionCutoff(retentionDays: number, now = new Date()): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}
