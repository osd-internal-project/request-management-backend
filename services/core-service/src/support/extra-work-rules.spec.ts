import {
  decideBlocker,
  extraLines,
  extrasCloseBlocker,
  proposalProblems,
} from './extra-work-rules';
import { prepareBlocker } from './billing-rules';
import { rebuildLines, type ChargeLine } from './time-material-rules';

describe('CD-228 out-of-contract work on a job', () => {
  it('a proposal says what, why, and how much', () => {
    expect(
      proposalProblems({
        description: 'เปลี่ยนสาย',
        reason: 'หนูกัด',
        estimate: 1500,
      }),
    ).toEqual([]);
    expect(
      proposalProblems({ description: ' ', reason: '', estimate: 0 }),
    ).toEqual([
      'ต้องระบุงานที่ต้องทำเพิ่ม',
      'ต้องระบุว่าทำไมอยู่นอกสัญญา',
      'ต้องระบุประมาณการค่าใช้จ่ายมากกว่า 0',
    ]);
  });

  it('only a waiting item is decided; a waiting one holds the job open', () => {
    expect(decideBlocker('proposed')).toBeNull();
    expect(decideBlocker('agreed')).toBe('รายการนี้ตัดสินไปแล้ว');
    expect(
      extrasCloseBlocker([
        { seq: 1, status: 'declined' },
        { seq: 2, status: 'agreed' },
      ]),
    ).toBeNull();
    expect(
      extrasCloseBlocker([
        { seq: 1, status: 'proposed' },
        { seq: 3, status: 'proposed' },
      ]),
    ).toContain('X-1, X-3');
  });

  it('only agreed items are charged', () => {
    expect(
      extraLines([
        { seq: 1, description: 'เปลี่ยนสาย', estimate: 1500, status: 'agreed' },
        { seq: 2, description: 'ย้ายกล้อง', estimate: 900, status: 'declined' },
      ]),
    ).toEqual([
      {
        productCode: null,
        description: 'งานนอกสัญญา X-1: เปลี่ยนสาย',
        quantity: 1,
        unit: null,
        unitPrice: 1500,
        discountPct: 0,
      },
    ]);
  });

  it('an in-contract job is charged when something beyond it was agreed', () => {
    expect(
      prepareBlocker({ billing: 'in_contract' }, 'completed'),
    ).not.toBeNull();
    expect(
      prepareBlocker({ billing: 'in_contract' }, 'completed', 1),
    ).toBeNull();
    expect(prepareBlocker({ billing: 'in_contract' }, 'in_progress', 1)).toBe(
      'เรียกเก็บได้เมื่องานเสร็จแล้ว',
    );
  });

  it('rebuilding keeps the estimate when only extras are fresh', () => {
    const line = (source: ChargeLine['source'], description: string) =>
      ({
        source,
        description,
        productCode: null,
        quantity: 1,
        unit: null,
        unitPrice: 100,
        discountPct: 0,
      }) as ChargeLine;
    expect(
      rebuildLines(
        [line('estimate', 'ประมาณการ'), line('extra', 'X-1 เก่า')],
        [line('extra', 'X-1 ใหม่')],
      ).map((row) => row.description),
    ).toEqual(['ประมาณการ', 'X-1 ใหม่']);
  });
});
