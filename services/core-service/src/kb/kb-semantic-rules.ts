import { createHash } from 'node:crypto';

/**
 * CD-267 — searching the knowledge base by meaning: articles cut into
 * passages by heading, each embedded once, and a search ranks by cosine
 * similarity, then fused with the keyword ranking (reciprocal rank fusion).
 */

/** About what an embedding model reads well at once. */
export const MAX_PASSAGE = 1500;
/** Shorter sections join the next one rather than stand alone. */
const MIN_PASSAGE = 200;
/** Passages a single article is cut into, at most. */
export const MAX_PASSAGES = 40;
/** Reciprocal rank fusion constant (the usual 60). */
export const RRF_K = 60;

export interface Passage {
  seq: number;
  heading: string | null;
  text: string;
  /** What is embedded: title and heading give the passage its context. */
  input: string;
  hash: string;
}

const HEADING = /^#{1,3}\s+(.+?)\s*#*\s*$/;

/** Split long text at paragraph, then line, then hard boundaries. */
function split(text: string, max = MAX_PASSAGE): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * An article as passages: the summary and tags open the first; every heading
 * (#, ##, ###) starts a section; short sections join the next; long ones are
 * split. The same article always gives the same passages and hashes.
 */
export function passagesOf(article: {
  title: string;
  summary: string | null;
  body: string;
  tags: string[];
}): Passage[] {
  const sections: { heading: string | null; text: string }[] = [];
  let current: { heading: string | null; lines: string[] } = {
    heading: null,
    lines: [],
  };
  const flush = () => {
    const text = current.lines.join('\n').trim();
    if (text || current.heading)
      sections.push({ heading: current.heading, text });
  };
  for (const line of article.body.replace(/\r\n/g, '\n').split('\n')) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      current = { heading: match[1].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const lead = [
    article.summary?.trim(),
    article.tags.length ? article.tags.join(', ') : '',
  ]
    .filter(Boolean)
    .join('\n');
  if (lead) {
    if (sections.length && sections[0].heading === null)
      sections[0].text = `${lead}\n\n${sections[0].text}`.trim();
    else sections.unshift({ heading: null, text: lead });
  }

  // short sections join the next (the heading of the first one stays)
  const merged: { heading: string | null; text: string }[] = [];
  for (const section of sections) {
    const last = merged[merged.length - 1];
    if (last && last.text.length < MIN_PASSAGE) {
      const head = section.heading ? `${section.heading}\n` : '';
      last.text = `${last.text}\n\n${head}${section.text}`.trim();
      continue;
    }
    merged.push({ ...section });
  }

  const passages: Passage[] = [];
  for (const section of merged) {
    for (const text of split(section.text)) {
      if (!text && !section.heading) continue;
      const input = [article.title, section.heading, text]
        .filter(Boolean)
        .join('\n');
      passages.push({
        seq: passages.length,
        heading: section.heading,
        text,
        input,
        hash: createHash('sha256').update(input).digest('hex'),
      });
    }
  }
  if (!passages.length) {
    const input = article.title;
    passages.push({
      seq: 0,
      heading: null,
      text: '',
      input,
      hash: createHash('sha256').update(input).digest('hex'),
    });
  }
  return passages.slice(0, MAX_PASSAGES);
}

/** Cosine similarity; 0 when the sizes differ or a vector is empty. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface SemanticHit {
  articleId: string;
  similarity: number;
  /** The passage that matched best. */
  seq: number;
  heading: string | null;
}

/**
 * The best passage per article, at least `minSimilarity`, best first, at
 * most `limit` articles.
 */
export function bestByArticle(
  scored: {
    articleId: string;
    seq: number;
    heading: string | null;
    similarity: number;
  }[],
  minSimilarity: number,
  limit: number,
): SemanticHit[] {
  const best = new Map<string, SemanticHit>();
  for (const s of scored) {
    if (s.similarity < minSimilarity) continue;
    const seen = best.get(s.articleId);
    if (!seen || s.similarity > seen.similarity)
      best.set(s.articleId, { ...s });
  }
  return [...best.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Reciprocal rank fusion of the keyword ranking and the meaning ranking: an
 * article high in either comes up; one in both comes first. Ties keep the
 * keyword order.
 */
export function fuseRanks(keyword: string[], semantic: string[]): string[] {
  const score = new Map<string, number>();
  const order = new Map<string, number>();
  const add = (ids: string[]) =>
    ids.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
      if (!order.has(id)) order.set(id, order.size);
    });
  add(keyword);
  add(semantic);
  return [...score.keys()].sort(
    (a, b) => score.get(b)! - score.get(a)! || order.get(a)! - order.get(b)!,
  );
}

/** How an article was found. */
export function matchOf(
  id: string,
  keyword: Set<string>,
  semantic: Map<string, SemanticHit>,
): 'both' | 'keyword' | 'meaning' {
  const k = keyword.has(id);
  const s = semantic.has(id);
  return k && s ? 'both' : s ? 'meaning' : 'keyword';
}
