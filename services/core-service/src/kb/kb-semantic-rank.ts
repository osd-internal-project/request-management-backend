import { fuseRanks } from './kb-semantic-rules';
import type { SemanticMatch } from './kb-semantic.service';

/**
 * CD-267 — the rows a keyword search found (score order, `keyword_hit`)
 * together with the articles found by meaning, in fused order, at most
 * `limit`. Without a search by meaning the keyword order stands.
 */
export function byRank<
  T extends { id: string; score: number; keyword_hit?: boolean },
>(rows: T[], meaning: Map<string, SemanticMatch> | null, limit: number): T[] {
  if (!meaning?.size) return rows.slice(0, limit);
  const keyword = rows
    .filter((r) => r.keyword_hit !== false)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.id);
  const found = new Set(rows.map((r) => r.id));
  const semantic = [...meaning.keys()].filter((id) => found.has(id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return fuseRanks(keyword, semantic)
    .slice(0, limit)
    .map((id) => byId.get(id)!);
}

/** How a result was found, and the passage that matched by meaning. */
export function matchFields(
  row: { id: string; keyword_hit?: boolean },
  meaning: Map<string, SemanticMatch> | null,
) {
  const hit = meaning?.get(row.id);
  if (!hit) return { match: 'keyword' as const, passage: null };
  return {
    match: row.keyword_hit === false ? ('meaning' as const) : ('both' as const),
    passage: {
      heading: hit.heading,
      text: hit.passage,
      similarity: hit.similarity,
    },
  };
}
