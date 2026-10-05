import {
  ackProblems,
  closeBlocker,
  confirmProblems,
  startBlocker,
  suggestBilling,
} from './work-order-rules';

describe('CD-239 work order rules', () => {
  const ma = {
    id: 'ma',
    title: 'MA 24x7',
    correctiveLeft: null,
    preventiveLeft: 0,
  };
  const warranty = {
    id: 'w',
    title: 'ประกัน',
    correctiveLeft: 2,
    preventiveLeft: 1,
  };

  it('suggests in contract while a cover has visits of the kind left', () => {
    expect(suggestBilling([ma, warranty], 'corrective')).toMatchObject({
      billing: 'in_contract',
      entitlementId: 'ma',
    });
    // MA's preventive visits are used up — the warranty still has one
    expect(suggestBilling([ma, warranty], 'preventive')).toMatchObject({
      billing: 'in_contract',
      entitlementId: 'w',
    });
    expect(suggestBilling([ma], 'preventive')).toEqual({
      billing: 'billable',
      entitlementId: 'ma',
      note: 'โควตาบำรุงรักษาของ MA 24x7 หมดแล้ว',
    });
    expect(suggestBilling([], 'corrective')).toMatchObject({
      billing: 'billable',
      entitlementId: null,
    });
  });

  it('a confirmation against the suggestion says why', () => {
    const base = {
      billing: 'billable',
      suggested: 'billable',
      reason: '',
      entitlementId: null,
    };
    expect(confirmProblems(base)).toEqual([]);
    expect(confirmProblems({ ...base, billing: 'in_contract' })).toEqual([
      'เลือกต่างจากที่ระบบเสนอ ต้องระบุเหตุผล',
      'อยู่ในสัญญา ต้องระบุสิทธิ์บริการที่ครอบคลุม',
    ]);
    expect(confirmProblems({ ...base, billing: 'x' })).toHaveLength(1);
  });

  it('a billed job starts only once the customer agreed', () => {
    expect(startBlocker({ billing: null, ackOn: null })).toContain(
      'ยังไม่ได้ยืนยัน',
    );
    expect(startBlocker({ billing: 'billable', ackOn: null })).toContain(
      'ลูกค้ารับทราบ',
    );
    expect(
      startBlocker({ billing: 'billable', ackOn: '2026-10-05' }),
    ).toBeNull();
    expect(startBlocker({ billing: 'in_contract', ackOn: null })).toBeNull();
    expect(
      ackProblems({
        name: '',
        on: '2026-10-09',
        estimate: -1,
        today: '2026-10-05',
      }),
    ).toHaveLength(3);
  });

  it('closes with its cause and fix', () => {
    expect(closeBlocker({ cause: 'สายหลวม', resolution: null })).not.toBeNull();
    expect(
      closeBlocker({ cause: 'สายหลวม', resolution: 'เข้าหัวใหม่' }),
    ).toBeNull();
  });
});
