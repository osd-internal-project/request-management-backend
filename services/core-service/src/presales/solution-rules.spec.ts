import {
  briefOf,
  cleanAssumptions,
  lockGaps,
  MAX_ASSUMPTION_LENGTH,
  MAX_ASSUMPTIONS,
  readAssumptions,
} from './solution-rules';

describe('CD-132 solution rules', () => {
  it('blank assumptions are dropped and text trimmed', () => {
    const { assumptions, problems } = cleanAssumptions([
      { category: 'technical', text: '  ลูกค้ามี VLAN แยก  ' },
      { category: 'customer', text: '   ' },
    ]);
    expect(problems).toEqual([]);
    expect(assumptions).toEqual([
      { category: 'technical', text: 'ลูกค้ามี VLAN แยก' },
    ]);
  });

  it('an unknown category, an over-long line and too many lines are each named', () => {
    expect(
      cleanAssumptions([{ category: 'magic', text: 'x' }]).problems[0],
    ).toContain('ข้อ 1');
    expect(
      cleanAssumptions([
        { category: 'technical', text: 'x'.repeat(MAX_ASSUMPTION_LENGTH + 1) },
      ]).problems,
    ).toHaveLength(1);
    const many = Array.from({ length: MAX_ASSUMPTIONS + 1 }, () => ({
      category: 'commercial',
      text: 'ok',
    }));
    expect(cleanAssumptions(many).problems).toEqual([
      `สมมติฐานได้ไม่เกิน ${MAX_ASSUMPTIONS} ข้อ`,
    ]);
  });

  it('a stored column is read defensively', () => {
    expect(readAssumptions(null)).toEqual([]);
    expect(
      readAssumptions([
        { category: 'third_party', text: 'ISP ส่งมอบวงจรภายใน 30 วัน' },
        { category: 'bogus', text: 'x' },
        'junk',
      ]),
    ).toEqual([
      { category: 'third_party', text: 'ISP ส่งมอบวงจรภายใน 30 วัน' },
    ]);
  });

  it('a version locks only with a summary and a design', () => {
    expect(lockGaps({ summary: ' ', design: '' })).toEqual([
      'ยังไม่มีสรุปทางออก',
      'ยังไม่มีรายละเอียดการออกแบบ',
    ]);
    expect(
      lockGaps({ summary: 'SD-WAN 12 สาขา', design: 'hub-spoke' }),
    ).toEqual([]);
  });

  it('the brief carries the known form fields only', () => {
    expect(
      briefOf({
        requirement: 'เชื่อม 12 สาขา',
        needs_demo: true,
        secret: 'x',
        site: '',
      }),
    ).toEqual({ requirement: 'เชื่อม 12 สาขา', needs_demo: 'ใช่' });
    expect(briefOf(null)).toEqual({});
  });
});
