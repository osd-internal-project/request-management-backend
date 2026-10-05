import {
  addMonths,
  articleProblems,
  helpfulScore,
  likePattern,
  nextArticleNo,
  normalizeTags,
  publishProblems,
  reviewMonthsOf,
  reviewState,
  searchTerms,
  union,
} from './kb-rules';

const ok = {
  title: 'รีเซ็ต Firewall',
  summary: null,
  body: '1. กดปุ่ม',
  tags: [],
  productCodes: [],
  productGroups: [],
};

describe('CD-259 KB rules', () => {
  it('normalizes tags: trim, lower, no #, no repeats', () => {
    expect(normalizeTags([' #VPN ', 'vpn', 'ไฟดับ', '', 'Link  Down'])).toEqual(
      ['vpn', 'ไฟดับ', 'link down'],
    );
  });

  it('splits a search on spaces; Thai words stay whole', () => {
    expect(searchTerms('  vpn เชื่อมต่อไม่ได้  VPN a ')).toEqual([
      'vpn',
      'เชื่อมต่อไม่ได้',
    ]);
    expect(searchTerms(undefined)).toEqual([]);
    expect(
      searchTerms('1 2 3 4 5 6 7 8 9 10 11 aa bb cc dd ee ff gg hh ii'),
    ).toHaveLength(8);
  });

  it('escapes LIKE pattern characters', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('a draft needs a title; publishing needs a body too', () => {
    expect(articleProblems({ ...ok, title: ' ' })).toHaveLength(1);
    expect(articleProblems({ ...ok, body: '' })).toHaveLength(0);
    expect(publishProblems({ ...ok, body: ' ' })).toEqual([
      'ต้องมีเนื้อหาก่อนเผยแพร่',
    ]);
  });

  it('helpful score leans to the middle with few votes', () => {
    expect(helpfulScore(0, 0)).toBe(0.5);
    expect(helpfulScore(1, 0)).toBeCloseTo(0.667, 2);
    expect(helpfulScore(9, 1)).toBeCloseTo(0.833, 2);
  });

  it('numbers articles per company', () => {
    expect(nextArticleNo(null)).toBe('KB-00001');
    expect(nextArticleNo('KB-00041')).toBe('KB-00042');
  });
});

describe('CD-260 KB review rules', () => {
  it('review months: category, then parent, then 12', () => {
    expect(
      reviewMonthsOf({ reviewMonths: 6, parentId: 'p' }, { reviewMonths: 3 }),
    ).toBe(6);
    expect(
      reviewMonthsOf(
        { reviewMonths: null, parentId: 'p' },
        { reviewMonths: 3 },
      ),
    ).toBe(3);
    expect(reviewMonthsOf(null, null)).toBe(12);
  });

  it('adds months, holding to the month end', () => {
    expect(addMonths('2026-10-05', 12)).toBe('2027-10-05');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
  });

  it('review state against today', () => {
    expect(reviewState(null, '2026-10-05', 14)).toBe('none');
    expect(reviewState('2026-10-04', '2026-10-05', 14)).toBe('overdue');
    expect(reviewState('2026-10-19', '2026-10-05', 14)).toBe('due_soon');
    expect(reviewState('2026-10-20', '2026-10-05', 14)).toBe('ok');
  });

  it('union keeps order and drops repeats', () => {
    expect(union(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});
