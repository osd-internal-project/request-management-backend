import {
  baselineAssumptions,
  changeFromAssumption,
  completeProblems,
  mergeAssumptions,
  surveyProblems,
} from './survey-rules';

const baseline = {
  scope: {
    assumptions: [
      { category: 'site', text: 'มีไฟเลี้ยงทุกจุด', owner: 'customer' },
      { category: 'site', text: 'เพดานสูงไม่เกิน 4 ม.', owner: 'customer' },
    ],
  },
};

describe('CD-210 survey rules', () => {
  it('the Solution assumptions come from the baseline', () => {
    expect(baselineAssumptions(baseline)).toEqual([
      'มีไฟเลี้ยงทุกจุด',
      'เพดานสูงไม่เกิน 4 ม.',
    ]);
    expect(baselineAssumptions(null)).toEqual([]);
  });

  it('answers are laid over them by index; a link to a change request is kept', () => {
    const texts = baselineAssumptions(baseline);
    const first = mergeAssumptions(
      texts,
      [],
      [{ index: 1, holds: false, note: 'สูง 6 ม.' }],
    );
    expect(first).toEqual([
      {
        index: 0,
        text: 'มีไฟเลี้ยงทุกจุด',
        holds: null,
        note: null,
        changeRequestId: null,
      },
      {
        index: 1,
        text: 'เพดานสูงไม่เกิน 4 ม.',
        holds: false,
        note: 'สูง 6 ม.',
        changeRequestId: null,
      },
    ]);
    const linked = first.map((row) =>
      row.index === 1 ? { ...row, changeRequestId: 'cr-1' } : row,
    );
    const again = mergeAssumptions(texts, linked, [{ index: 0, holds: true }]);
    expect(again[0].holds).toBe(true);
    expect(again[1]).toMatchObject({ holds: false, changeRequestId: 'cr-1' });
  });

  it('a survey is synced with a device id, a site and a date not in the future', () => {
    const ok = {
      id: '2f1c7a52-3d0e-4b8a-9a55-1c2d3e4f5a6b',
      site: 'อาคาร A',
      surveyedOn: '2026-10-08',
      latitude: 13.75,
      longitude: 100.5,
      today: '2026-10-08',
    };
    expect(surveyProblems(ok)).toEqual([]);
    expect(
      surveyProblems({
        ...ok,
        id: 'x',
        site: ' ',
        surveyedOn: '2026-10-09',
        latitude: 99,
      }),
    ).toHaveLength(4);
  });

  it('completed only when every assumption is checked, and each that differs is a change request', () => {
    expect(
      completeProblems([
        { index: 0, text: 'ก', holds: null, note: null, changeRequestId: null },
        {
          index: 1,
          text: 'ข',
          holds: false,
          note: null,
          changeRequestId: null,
        },
      ]),
    ).toEqual([
      'ยังไม่ได้ตรวจสมมติฐานข้อ 1',
      'สมมติฐานที่ไม่ตรงต้องบอกว่าไม่ตรงอย่างไร: ข้อ 2',
      'สมมติฐานที่ไม่ตรงต้องแปลงเป็นคำขอเปลี่ยนแปลงก่อน: ข้อ 2',
    ]);
    expect(
      completeProblems([
        { index: 0, text: 'ก', holds: true, note: null, changeRequestId: null },
        {
          index: 1,
          text: 'ข',
          holds: false,
          note: 'ไม่ตรง',
          changeRequestId: 'cr',
        },
      ]),
    ).toEqual([]);
  });

  it('the change request names the survey and the assumption', () => {
    expect(
      changeFromAssumption({
        survey: 'S-1',
        site: 'อาคาร A',
        text: 'เพดานสูงไม่เกิน 4 ม.',
        note: 'สูง 6 ม. ต้องใช้นั่งร้าน',
      }),
    ).toEqual({
      title: 'S-1: สมมติฐานไม่ตรงหน้างาน — เพดานสูงไม่เกิน 4 ม.',
      reason: 'สำรวจหน้างาน อาคาร A: สูง 6 ม. ต้องใช้นั่งร้าน',
    });
  });
});
