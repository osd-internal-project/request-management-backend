import { changeFromLog, logProblems, owesChange } from './customer-log-rules';

describe('CD-186 a contact with the customer', () => {
  const ok = {
    kind: 'meeting',
    occurredOn: '2026-10-01',
    summary: 'ประชุมติดตามงาน',
    decision: null,
    affectsScope: false,
    today: '2026-10-01',
  };

  it('needs a day not in the future and a summary', () => {
    expect(logProblems(ok)).toEqual([]);
    expect(logProblems({ ...ok, occurredOn: '2026-10-02' })).toHaveLength(1);
    expect(logProblems({ ...ok, summary: ' ', kind: 'fax' })).toHaveLength(2);
  });

  it('a decision on the scope says what was decided, and owes a change request', () => {
    expect(logProblems({ ...ok, affectsScope: true })).toHaveLength(1);
    expect(owesChange({ affectsScope: true, changeRequestId: null })).toBe(
      true,
    );
    expect(owesChange({ affectsScope: true, changeRequestId: 'cr' })).toBe(
      false,
    );
    expect(owesChange({ affectsScope: false, changeRequestId: null })).toBe(
      false,
    );
  });

  it('becomes a change request carrying the decision', () => {
    expect(
      changeFromLog({
        seq: 3,
        occurredOn: '2026-10-01',
        contactName: 'คุณสมชาย',
        decision: 'ขอเพิ่มกล้องที่ลานจอดรถ',
        summary: 'ประชุมหน้างาน',
      }),
    ).toEqual({
      title: 'C-3: ขอเพิ่มกล้องที่ลานจอดรถ',
      reason: 'ลูกค้าตัดสินใจเมื่อ 2026-10-01 (คุณสมชาย) — ประชุมหน้างาน',
      scope_added: 'ขอเพิ่มกล้องที่ลานจอดรถ',
    });
  });
});
