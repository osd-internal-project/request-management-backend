import {
  answerProblem,
  clauseChanged,
  compareVersions,
  diffText,
} from './contract-review';

describe('CD-147 comparing versions', () => {
  it('diffs by line, then Thai text by character within a changed line', () => {
    const before = 'ค่าปรับร้อยละ 0.1 ต่อวัน\nชำระภายใน 30 วัน';
    const after = 'ค่าปรับร้อยละ 0.05 ต่อวัน\nชำระภายใน 30 วัน';
    const ops = diffText(before, after);
    const side = (keep: 'add' | 'del') =>
      ops
        .filter((op) => op.type === 'same' || op.type === keep)
        .map((op) => op.text)
        .join('');
    expect(side('del')).toBe(before);
    expect(side('add')).toBe(after);
    // only the number changed; the rest of the line and the next line did not
    expect(
      ops
        .filter((op) => op.type !== 'same')
        .map((op) => op.text)
        .join(''),
    ).toMatch(/^[015]+$/);
    expect(ops[ops.length - 1]).toEqual({
      type: 'same',
      text: ' ต่อวัน\nชำระภายใน 30 วัน',
    });
    expect(diffText('ก', 'ก')).toEqual([{ type: 'same', text: 'ก' }]);
    expect(diffText('', 'ข้อใหม่')).toEqual([{ type: 'add', text: 'ข้อใหม่' }]);
  });

  it('a text too long to walk character by character is shown as replaced', () => {
    const before = 'ก'.repeat(3000);
    const after = 'ข'.repeat(3000);
    expect(diffText(before, after)).toEqual([
      { type: 'del', text: before },
      { type: 'add', text: after },
    ]);
  });

  it('lines up clauses on their key: changed, added, removed, moved', () => {
    const v1 = [
      { key: 'c1', heading: 'คู่สัญญา', body: 'ก กับ ข' },
      { key: 'c2', heading: 'ค่าปรับ', body: '0.1%' },
      { key: 'c3', heading: 'ข้อพิพาท', body: 'ศาลไทย' },
    ];
    const v2 = [
      { key: 'c2', heading: 'ค่าปรับและเพดาน', body: '0.1%' },
      { key: 'c1', heading: 'คู่สัญญา', body: 'ก กับ ข' },
      { key: 'new-1', heading: 'PDPA', body: 'ตามกฎหมาย' },
    ];
    const rows = compareVersions(v1, v2);
    expect(
      rows.map((row) => [row.key, row.change, row.moved, row.headingBefore]),
    ).toEqual([
      ['c2', 'changed', true, 'ค่าปรับ'],
      ['c1', 'same', true, null],
      ['new-1', 'added', false, null],
      ['c3', 'removed', false, null],
    ]);
  });

  it('a comment tells whether its clause changed since the version reviewed', () => {
    const v1 = [
      { key: 'c1', heading: 'ก', body: 'x' },
      { key: 'c2', heading: 'ข', body: 'y' },
    ];
    const v2 = [{ key: 'c1', heading: 'ก', body: 'x2' }];
    expect(clauseChanged('c1', v1, v2)).toBe(true);
    expect(clauseChanged('c2', v1, v2)).toBe(true); // taken out
    expect(clauseChanged('c1', v1, v1)).toBe(false);
  });

  it('an answer is fixed or not fixed — not fixed needs the reason', () => {
    expect(answerProblem('resolved', undefined)).toBeNull();
    expect(answerProblem('declined', ' ')).toBe('ไม่แก้ต้องให้เหตุผล');
    expect(answerProblem('declined', 'ลูกค้าไม่ยอม')).toBeNull();
    expect(answerProblem('open', 'x')).not.toBeNull();
  });
});
