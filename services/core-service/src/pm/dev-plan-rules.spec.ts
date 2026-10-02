import { addProblems, coverage, devSources, itemTitle } from './dev-plan-rules';

const baseline = {
  scope: {
    inScope: ['ระบบลงทะเบียน', 'รายงานยอดขาย'],
    deliverables: [{ title: 'คู่มือผู้ใช้', criteria: ['ครบทุกหน้าจอ'] }],
  },
};

describe('CD-212 development plan rules', () => {
  it('the SOW: scope lines, deliverables as a whole, then approved changes', () => {
    expect(
      devSources(baseline, [
        { id: 'c1', seq: 2, scopeAdded: 'ส่งออก Excel' },
        { id: 'c2', seq: 3, scopeAdded: null },
      ]),
    ).toEqual([
      { ref: 'scope:0', source: 'scope', text: 'ระบบลงทะเบียน' },
      { ref: 'scope:1', source: 'scope', text: 'รายงานยอดขาย' },
      {
        ref: 'deliverable:0',
        source: 'deliverable',
        text: 'ส่งมอบ คู่มือผู้ใช้',
      },
      { ref: 'change:c1', source: 'change', text: 'CR-2: ส่งออก Excel' },
    ]);
    expect(devSources(null, [])).toEqual([]);
  });

  it('coverage counts live items only; a cancelled item frees its line', () => {
    const sources = devSources(baseline, []);
    const result = coverage(sources, [
      { sowRef: 'scope:0', status: 'done' },
      { sowRef: 'scope:1', status: 'cancelled' },
      { sowRef: 'deliverable:0', status: 'in_progress' },
    ]);
    expect(result).toMatchObject({ total: 3, planned: 2, done: 1 });
    expect(result.unplanned.map((row) => row.ref)).toEqual(['scope:1']);
  });

  it('adding refuses lines unknown, repeated or already planned', () => {
    const sources = devSources(baseline, []);
    expect(
      addProblems({
        refs: ['scope:1'],
        sources,
        planned: new Set(['scope:0']),
      }),
    ).toEqual([]);
    expect(
      addProblems({
        refs: ['scope:0', 'scope:0', 'scope:9'],
        sources,
        planned: new Set(['scope:0']),
      }),
    ).toEqual([
      'เลือกข้อ SOW ซ้ำ',
      'ไม่พบข้อ SOW: scope:9',
      'ข้อ SOW นี้อยู่ในรอบงานแล้ว: scope:0, scope:0',
    ]);
    expect(addProblems({ refs: [], sources, planned: new Set() })).toEqual([
      'ต้องเลือกข้อ SOW อย่างน้อยหนึ่งข้อ',
    ]);
  });

  it('a title fits the plan', () => {
    expect(itemTitle('  ก  ข ')).toBe('ก ข');
    expect(itemTitle('x'.repeat(300))).toHaveLength(255);
  });
});
