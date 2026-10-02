import {
  checkProblems,
  fromChecklist,
  readiness,
  systemChecks,
} from './readiness-rules';

const allGood = systemChecks({
  tests: { complete: true, total: 3, passed: 3 },
  issuesOpen: 0,
  asBuilt: { complete: true, missing: 0 },
});

describe('CD-225 readiness rules', () => {
  it('the system checks tests and open issues itself', () => {
    expect(allGood.every((check) => check.ok)).toBe(true);
    const bad = systemChecks({
      tests: { complete: false, total: 4, passed: 1 },
      issuesOpen: 2,
      asBuilt: { complete: false, missing: 3 },
    });
    expect(bad.map((check) => [check.key, check.detail])).toEqual([
      ['tests', 'ผ่าน 1/4'],
      ['issues', 'ค้าง 2 ข้อ'],
      ['as_built', 'ค้าง 3 รายการ'],
    ]);
    expect(
      systemChecks({
        tests: { complete: false, total: 0, passed: 0 },
        issuesOpen: 0,
        asBuilt: { complete: true, missing: 0 },
      })[0].detail,
    ).toBe('ยังไม่มีข้อทดสอบ');
  });

  it('the checklist drops blanks and repeats', () => {
    expect(fromChecklist([' ก ', '', 'ข', 'ก'])).toEqual(['ก', 'ข']);
  });

  it('a check has a result and a date not in the future; a fail says why', () => {
    const today = '2026-10-08';
    expect(
      checkProblems({ result: 'pass', checkedOn: today, note: '', today }),
    ).toEqual([]);
    expect(
      checkProblems({ result: 'fail', checkedOn: today, note: ' ', today }),
    ).toEqual(['ไม่ผ่าน: ต้องบอกว่าไม่พร้อมอย่างไร']);
    expect(
      checkProblems({
        result: 'pass',
        checkedOn: '2026-10-09',
        note: '',
        today,
      }),
    ).toEqual(['วันที่ตรวจต้องไม่เกินวันนี้']);
    expect(
      checkProblems({ result: 'x', checkedOn: null, note: '', today }),
    ).toHaveLength(2);
  });

  it('ready only when every line passed and every system check holds', () => {
    expect(
      readiness(
        [
          { text: 'ป้าย', result: 'pass' },
          { text: 'อบรม', result: 'pass' },
        ],
        allGood,
      ),
    ).toMatchObject({ ready: true, passed: 2, total: 2, blockers: [] });
    const notYet = readiness(
      [
        { text: 'ป้าย', result: 'fail' },
        { text: 'อบรม', result: null },
      ],
      systemChecks({
        tests: { complete: false, total: 2, passed: 1 },
        issuesOpen: 0,
        asBuilt: { complete: true, missing: 0 },
      }),
    );
    expect(notYet).toMatchObject({ ready: false, failed: 1, unchecked: 1 });
    expect(notYet.blockers).toEqual([
      'ทดสอบผ่านครบทุกข้อตามขอบเขตงาน: ผ่าน 1/2',
      'ไม่ผ่าน: ป้าย',
      'ยังไม่ตรวจ: อบรม',
    ]);
  });
});
