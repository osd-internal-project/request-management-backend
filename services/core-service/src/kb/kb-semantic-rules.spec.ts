import {
  MAX_PASSAGE,
  bestByArticle,
  cosine,
  fuseRanks,
  matchOf,
  passagesOf,
} from './kb-semantic-rules';

const article = (
  body: string,
  extra: Partial<{ summary: string; tags: string[] }> = {},
) => ({
  title: 'ตั้งค่า VPN',
  summary: extra.summary ?? null,
  body,
  tags: extra.tags ?? [],
});

describe('passagesOf', () => {
  it('cuts by heading and puts title and heading into what is embedded', () => {
    const long = 'ก'.repeat(300);
    const passages = passagesOf(
      article(`## อาการ\n${long}\n\n## วิธีแก้\n${long}`),
    );
    expect(passages.map((p) => p.heading)).toEqual(['อาการ', 'วิธีแก้']);
    expect(passages[1].input).toBe(`ตั้งค่า VPN\nวิธีแก้\n${long}`);
    expect(passages.map((p) => p.seq)).toEqual([0, 1]);
  });

  it('joins short sections to the next and opens with summary and tags', () => {
    const passages = passagesOf(
      article('## สั้น\nข้อเดียว\n\n## ต่อ\nอีกข้อ', {
        summary: 'สรุป',
        tags: ['vpn', 'remote'],
      }),
    );
    expect(passages).toHaveLength(1);
    expect(passages[0].heading).toBeNull();
    expect(passages[0].text).toContain('สรุป');
    expect(passages[0].text).toContain('vpn, remote');
    expect(passages[0].text).toContain('ข้อเดียว');
    expect(passages[0].text).toContain('อีกข้อ');
  });

  it('splits a long section at paragraph boundaries', () => {
    const para = 'ข'.repeat(900);
    const passages = passagesOf(
      article(`## ยาว\n${para}\n\n${para}\n\n${para}`),
    );
    expect(passages.length).toBe(3);
    expect(passages.every((p) => p.text.length <= MAX_PASSAGE)).toBe(true);
    expect(passages.every((p) => p.heading === 'ยาว')).toBe(true);
  });

  it('is stable, and an empty article is its title', () => {
    const a = passagesOf(article('## หัว\n' + 'ค'.repeat(400)));
    const b = passagesOf(article('## หัว\n' + 'ค'.repeat(400)));
    expect(a.map((p) => p.hash)).toEqual(b.map((p) => p.hash));
    const empty = passagesOf(article(''));
    expect(empty).toHaveLength(1);
    expect(empty[0].input).toBe('ตั้งค่า VPN');
  });
});

describe('cosine', () => {
  it('measures direction and refuses mismatched sizes', () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([1, 0, 0], [1, 0])).toBe(0);
    expect(cosine([], [])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });
});

describe('bestByArticle', () => {
  it('keeps the best passage per article above the floor', () => {
    const hits = bestByArticle(
      [
        { articleId: 'a', seq: 0, heading: null, similarity: 0.5 },
        { articleId: 'a', seq: 2, heading: 'วิธีแก้', similarity: 0.8 },
        { articleId: 'b', seq: 0, heading: null, similarity: 0.6 },
        { articleId: 'c', seq: 0, heading: null, similarity: 0.2 },
      ],
      0.3,
      10,
    );
    expect(hits.map((h) => [h.articleId, h.seq])).toEqual([
      ['a', 2],
      ['b', 0],
    ]);
    expect(
      bestByArticle(
        [
          { articleId: 'a', seq: 0, heading: null, similarity: 0.9 },
          { articleId: 'b', seq: 0, heading: null, similarity: 0.8 },
        ],
        0,
        1,
      ),
    ).toHaveLength(1);
  });
});

describe('fuseRanks', () => {
  it('puts what both found first, then interleaves', () => {
    expect(fuseRanks(['k1', 'both', 'k2'], ['both', 's1'])).toEqual([
      'both',
      'k1',
      's1',
      'k2',
    ]);
    expect(fuseRanks([], ['s1', 's2'])).toEqual(['s1', 's2']);
    expect(fuseRanks(['k1'], [])).toEqual(['k1']);
  });

  it('says how each was found', () => {
    const sem = new Map([
      ['b', { articleId: 'b', similarity: 1, seq: 0, heading: null }],
      ['s', { articleId: 's', similarity: 1, seq: 0, heading: null }],
    ]);
    const kw = new Set(['k', 'b']);
    expect(['k', 'b', 's'].map((id) => matchOf(id, kw, sem))).toEqual([
      'keyword',
      'both',
      'meaning',
    ]);
  });
});
