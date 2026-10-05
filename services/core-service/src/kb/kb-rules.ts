/**
 * CD-259 คลังบทความความรู้ (part of CD-22 KBMS) — the rules, apart from the
 * database: what an article needs, how its tags read, and how a search is
 * split into terms. Thai has no spaces between words and Postgres full-text
 * cannot cut it, so a search is the words the reader typed, each of which
 * must appear somewhere (title, summary, body, tags, product codes).
 */

export const ARTICLE_STATUSES = ['draft', 'published', 'archived'] as const;
export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

export const MAX_TITLE = 200;
export const MAX_SUMMARY = 500;
export const MAX_BODY = 100_000;
export const MAX_TAGS = 20;
export const MAX_TAG = 40;
export const MAX_PRODUCTS = 50;
export const MAX_TERMS = 8;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_ARTICLE = 30;

/** Images show inline in an article; the rest are links. */
export const FILE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

/** Lower-case, single spaces, no leading `#`; empty and repeats dropped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
    if (tag) seen.add(tag.slice(0, MAX_TAG));
  }
  return [...seen];
}

/** The terms of a search: split on spaces, repeats and 1-char latin dropped. */
export function searchTerms(query: string | undefined | null): string[] {
  if (!query) return [];
  const terms = new Set<string>();
  for (const word of query.trim().toLowerCase().split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]$/.test(word)) continue;
    terms.add(word);
  }
  return [...terms].slice(0, MAX_TERMS);
}

/** `%term%` for ILIKE, with the pattern characters taken literally. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export interface ArticleInput {
  title: string;
  summary?: string | null;
  body: string;
  tags: readonly string[];
  productCodes: readonly string[];
  productGroups: readonly string[];
}

export function articleProblems(input: ArticleInput): string[] {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('ต้องระบุชื่อบทความ');
  if (input.title.trim().length > MAX_TITLE)
    problems.push(`ชื่อบทความยาวไม่เกิน ${MAX_TITLE} ตัวอักษร`);
  if ((input.summary ?? '').length > MAX_SUMMARY)
    problems.push(`สรุปย่อยาวไม่เกิน ${MAX_SUMMARY} ตัวอักษร`);
  if (input.body.length > MAX_BODY)
    problems.push(`เนื้อหายาวไม่เกิน ${MAX_BODY.toLocaleString()} ตัวอักษร`);
  if (input.tags.length > MAX_TAGS)
    problems.push(`แท็กไม่เกิน ${MAX_TAGS} รายการ`);
  if (input.productCodes.length + input.productGroups.length > MAX_PRODUCTS)
    problems.push(`ผูกสินค้า/กลุ่มสินค้ารวมไม่เกิน ${MAX_PRODUCTS} รายการ`);
  return problems;
}

/** What publishing needs on top of a valid draft. */
export function publishProblems(input: ArticleInput): string[] {
  const problems = articleProblems(input);
  if (!input.body.trim()) problems.push('ต้องมีเนื้อหาก่อนเผยแพร่');
  return problems;
}

/** Helpful share with a prior (one up, one down) so a single vote is not 100%. */
export function helpfulScore(yes: number, no: number): number {
  return (yes + 1) / (yes + no + 2);
}

/** KB-00001: the next number after the company's highest. */
export function nextArticleNo(highest: string | null): string {
  const n = highest ? Number(highest.replace(/^KB-/, '')) || 0 : 0;
  return `KB-${String(n + 1).padStart(5, '0')}`;
}
