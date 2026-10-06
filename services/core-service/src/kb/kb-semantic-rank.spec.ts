import { byRank, matchFields } from './kb-semantic-rank';
import type { SemanticMatch } from './kb-semantic.service';

const hit = (articleId: string, similarity: number): SemanticMatch => ({
  articleId,
  similarity,
  seq: 1,
  heading: 'วิธีแก้',
  passage: 'ท่อนที่ตรง',
});

describe('byRank', () => {
  const rows = [
    { id: 'sem', score: 0.5, keyword_hit: false },
    { id: 'k2', score: 3, keyword_hit: true },
    { id: 'both', score: 6, keyword_hit: true },
    { id: 'k1', score: 9, keyword_hit: true },
  ];

  it('keeps the keyword order without a search by meaning', () => {
    expect(byRank(rows, null, 2).map((r) => r.id)).toEqual(['sem', 'k2']);
    expect(byRank(rows, new Map(), 10)).toHaveLength(4);
  });

  it('fuses: found both ways first, then keyword and meaning in turn', () => {
    const meaning = new Map([
      ['both', hit('both', 0.9)],
      ['sem', hit('sem', 0.7)],
      // not visible to this viewer: the query did not return it
      ['hidden', hit('hidden', 0.95)],
    ]);
    expect(byRank(rows, meaning, 10).map((r) => r.id)).toEqual([
      'both',
      'k1',
      'sem',
      'k2',
    ]);
    expect(byRank(rows, meaning, 2).map((r) => r.id)).toEqual(['both', 'k1']);
  });
});

describe('matchFields', () => {
  it('says how a row was found and shows the passage', () => {
    const meaning = new Map([['a', hit('a', 0.8)]]);
    expect(matchFields({ id: 'a', keyword_hit: false }, meaning)).toEqual({
      match: 'meaning',
      passage: { heading: 'วิธีแก้', text: 'ท่อนที่ตรง', similarity: 0.8 },
    });
    expect(matchFields({ id: 'a', keyword_hit: true }, meaning).match).toBe(
      'both',
    );
    expect(matchFields({ id: 'b', keyword_hit: true }, meaning)).toEqual({
      match: 'keyword',
      passage: null,
    });
    expect(matchFields({ id: 'a' }, null).match).toBe('keyword');
  });
});
