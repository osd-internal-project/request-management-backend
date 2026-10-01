import {
  issueFromFailure,
  resultProblems,
  testCoverage,
  testSources,
  testState,
} from './test-rules';

const baseline = {
  scope: {
    inScope: ['ติดตั้งกล้อง 20 จุด', '  ', 'ตั้งค่าระบบบันทึกภาพ'],
    deliverables: [
      {
        title: 'ระบบกล้อง',
        description: '',
        criteria: ['ภาพชัดทุกจุด', 'บันทึกย้อนหลัง 30 วัน'],
      },
      { title: 'คู่มือ', description: '', criteria: [] },
    ],
  },
};

describe('CD-221 test rules', () => {
  it('scope lines, criteria and approved changes become items, in order', () => {
    const items = testSources(baseline, [
      { id: 'c1', seq: 2, scopeAdded: 'เพิ่มกล้องลานจอด 3 ตัว' },
      { id: 'c2', seq: 3, scopeAdded: null },
    ]);
    expect(items.map((item) => [item.sourceRef, item.text])).toEqual([
      ['scope:0', 'ติดตั้งกล้อง 20 จุด'],
      ['scope:1', 'ตั้งค่าระบบบันทึกภาพ'],
      ['deliverable:0:0', 'ภาพชัดทุกจุด'],
      ['deliverable:0:1', 'บันทึกย้อนหลัง 30 วัน'],
      ['deliverable:1', 'ส่งมอบ คู่มือ'],
      ['change:c1', 'CR-2: เพิ่มกล้องลานจอด 3 ตัว'],
    ]);
    expect(items[2].deliverable).toBe('ระบบกล้อง');
  });

  it('no baseline scope, no items', () => {
    expect(testSources(null, [])).toEqual([]);
  });

  it('the latest run decides; waived beats everything', () => {
    expect(testState({ waivedAt: null, runs: [] })).toBe('untested');
    expect(
      testState({
        waivedAt: null,
        runs: [{ result: 'pass' }, { result: 'fail' }],
      }),
    ).toBe('passed');
    expect(testState({ waivedAt: null, runs: [{ result: 'fail' }] })).toBe(
      'failed',
    );
    expect(
      testState({ waivedAt: new Date(), runs: [{ result: 'fail' }] }),
    ).toBe('waived');
  });

  it('complete only when every item that applies passed', () => {
    expect(testCoverage(['passed', 'waived'])).toMatchObject({
      total: 1,
      complete: true,
    });
    expect(testCoverage(['passed', 'untested']).complete).toBe(false);
    expect(testCoverage(['waived']).complete).toBe(false);
    expect(testCoverage([]).complete).toBe(false);
  });

  it('a fail says why; a pass carries evidence', () => {
    expect(
      resultProblems({
        result: 'fail',
        note: '',
        hasFile: false,
        waived: false,
      }),
    ).toEqual(['ไม่ผ่าน: ต้องบอกว่าไม่ผ่านอย่างไร']);
    expect(
      resultProblems({
        result: 'pass',
        note: 'ok',
        hasFile: false,
        waived: false,
      }),
    ).toEqual(['ผ่าน: ต้องแนบหลักฐาน (รูป ไฟล์ผลทดสอบ)']);
    expect(
      resultProblems({
        result: 'pass',
        note: '',
        hasFile: true,
        waived: false,
      }),
    ).toEqual([]);
    expect(
      resultProblems({ result: 'pass', note: '', hasFile: true, waived: true }),
    ).toHaveLength(1);
  });

  it('the issue a failure opens names the item', () => {
    expect(
      issueFromFailure({
        label: 'T-3',
        text: 'ภาพชัดทุกจุด',
        note: 'จุดที่ 7 ภาพมัว',
        tester: 'ช่างเอ',
      }),
    ).toEqual({
      title: 'ไม่ผ่านทดสอบ T-3: ภาพชัดทุกจุด',
      description: 'จุดที่ 7 ภาพมัว\n— บันทึกโดย ช่างเอ',
    });
  });
});
