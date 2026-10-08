import {
  canMove,
  fromSatang,
  leaveBlocker,
  statusOnStep,
  linesFromItems,
  moveBlocker,
  settlement,
  settlementEvidence,
  startStatus,
  statusOnRequestEvent,
  toSatang,
  totalSatang,
} from './disbursement-rules';

describe('disbursement rules — status moves', () => {
  it('follows the advance path end to end', () => {
    expect(canMove('PENDING_HEAD', 'PENDING_VERIFY')).toBe(true);
    expect(canMove('PENDING_VERIFY', 'PENDING_EXEC')).toBe(true);
    expect(canMove('PENDING_EXEC', 'APPROVED')).toBe(true);
    expect(canMove('APPROVED', 'PAID')).toBe(true);
    expect(canMove('PAID', 'CLEARING')).toBe(true);
    expect(canMove('CLEARING', 'CLOSED')).toBe(true);
  });

  it('never leaves a terminal status', () => {
    expect(canMove('CLOSED', 'PAID')).toBe(false);
    expect(canMove('REJECTED', 'PENDING_VERIFY')).toBe(false);
    expect(canMove('CANCELLED', 'PENDING_HEAD')).toBe(false);
  });

  it('cannot pay before approval or cancel after paying', () => {
    expect(moveBlocker('ADVANCE', 'PENDING_VERIFY', 'PAID')).not.toBeNull();
    expect(moveBlocker('ADVANCE', 'PAID', 'CANCELLED')).not.toBeNull();
  });

  it('petty cash has no clearing step', () => {
    expect(moveBlocker('PETTY_CASH', 'PAID', 'CLEARING')).toBe(
      'เงินสดย่อยไม่มีขั้นเคลียร์ค่าใช้จ่าย',
    );
    expect(moveBlocker('PETTY_CASH', 'PAID', 'CLOSED')).toBeNull();
  });

  it('starts at the head when the request waits for approval, else at accounting', () => {
    expect(startStatus('pending_approval')).toBe('PENDING_HEAD');
    expect(startStatus('submitted')).toBe('PENDING_VERIFY');
  });

  it('maps request events, and ignores the ones that would go backwards', () => {
    expect(statusOnRequestEvent('PENDING_HEAD', 'pre_approved')).toBe(
      'PENDING_VERIFY',
    );
    expect(statusOnRequestEvent('PENDING_HEAD', 'returned')).toBe('RETURNED');
    expect(statusOnRequestEvent('PAID', 'cancelled')).toBeNull();
    expect(statusOnRequestEvent('PENDING_VERIFY', 'pre_approved')).toBeNull();
  });
});

describe('disbursement rules — lines and money', () => {
  it('reads the form table and totals it in satang', () => {
    const { lines, problems } = linesFromItems([
      { description: 'ค่าเดินทาง', cost_center: '2002', amount: 6000 },
      { description: 'ค่าที่พัก', cost_center: '2002', amount: '5000.10' },
      { description: 'เบ็ดเตล็ด', amount: 0.1 + 0.2 },
    ]);
    expect(problems).toEqual([]);
    expect(totalSatang(lines)).toBe(1100040);
    expect(fromSatang(totalSatang(lines))).toBe('11000.40');
  });

  it('reports every bad row and an empty table', () => {
    expect(
      linesFromItems([{ description: '', amount: -1 }]).problems,
    ).toHaveLength(2);
    expect(linesFromItems(undefined).problems).toEqual([
      'ต้องมีรายการค่าใช้จ่ายอย่างน้อย 1 รายการ',
    ]);
  });

  it('rejects amounts that are not numbers', () => {
    expect(toSatang('abc')).toBeNull();
    expect(toSatang('')).toBeNull();
    expect(toSatang(null)).toBeNull();
  });

  it('settles a refund, an overspend, and an exact spend', () => {
    // screen 7: 15,000 advanced, 12,350 spent → 2,650 back
    expect(settlement(1500000, 1235000)).toEqual({
      refundSatang: 265000,
      extraPaySatang: 0,
    });
    expect(settlement(1500000, 1600000)).toEqual({
      refundSatang: 0,
      extraPaySatang: 100000,
    });
    expect(settlement(1500000, 1500000)).toEqual({
      refundSatang: 0,
      extraPaySatang: 0,
    });
  });

  describe('the slip a settlement needs', () => {
    const cleared = new Date('2026-10-08T03:00:00Z');
    const file = (kind: string, at: string, deletedAt: Date | null = null) => ({
      kind,
      storageKey: `${kind}@${at}`,
      uploadedAt: new Date(at),
      deletedAt,
    });
    const refund = { refundSatang: 50000, extraPaySatang: 0 };

    it('an exact spend needs none', () => {
      expect(settlementEvidence({ refundSatang: 0, extraPaySatang: 0 }, [], cleared)).toEqual({
        kind: null,
        file: null,
      });
    });

    it('a refund needs a proof attached since the latest clearing', () => {
      expect(settlementEvidence(refund, [], cleared)).toEqual({ kind: 'REFUND_PROOF', file: null });
      expect(
        settlementEvidence(refund, [file('REFUND_PROOF', '2026-10-08T02:00:00Z')], cleared).file,
      ).toBeNull();
      expect(
        settlementEvidence(
          refund,
          [file('REFUND_PROOF', '2026-10-08T04:00:00Z', new Date('2026-10-08T05:00:00Z'))],
          cleared,
        ).file,
      ).toBeNull();
    });

    it('takes the newest matching file', () => {
      const result = settlementEvidence(
        refund,
        [
          file('REFUND_PROOF', '2026-10-08T04:00:00Z'),
          file('REFUND_PROOF', '2026-10-08T06:00:00Z'),
          file('PAYMENT_SLIP', '2026-10-08T07:00:00Z'),
        ],
        cleared,
      );
      expect(result.file?.storageKey).toBe('REFUND_PROOF@2026-10-08T06:00:00Z');
    });

    it('an overspend needs the payment slip', () => {
      expect(
        settlementEvidence({ refundSatang: 0, extraPaySatang: 100000 }, [], cleared).kind,
      ).toBe('PAYMENT_SLIP');
    });
  });
});


describe('disbursement rules — the ticket’s steps', () => {
  const steps = {
    verifyStep: 'VERIFY',
    execStep: 'EXEC',
    payStep: 'PAY',
    clearStep: 'CLEAR',
    doneStep: 'DONE',
  };

  it('follows the ticket: verify, executive, pay', () => {
    expect(
      statusOnStep(steps, 'PENDING_HEAD', { stepCode: 'VERIFY', status: 'in_progress' }),
    ).toBe('PENDING_VERIFY');
    expect(
      statusOnStep(steps, 'PENDING_VERIFY', { stepCode: 'EXEC', status: 'pending_approval' }),
    ).toBe('PENDING_EXEC');
    expect(
      statusOnStep(steps, 'PENDING_EXEC', { stepCode: 'PAY', status: 'in_progress' }),
    ).toBe('APPROVED');
  });

  it('a ticket sent back to the requester returns the disbursement; a resent one waits for the head', () => {
    expect(
      statusOnStep(steps, 'PENDING_HEAD', { stepCode: 'DRAFT', status: 'returned' }),
    ).toBe('RETURNED');
    expect(
      statusOnStep(steps, 'RETURNED', { stepCode: 'HEAD', status: 'pending_approval' }),
    ).toBe('PENDING_HEAD');
  });

  it('ignores steps that do not change the money', () => {
    expect(
      statusOnStep(steps, 'PAID', { stepCode: 'CLEAR', status: 'in_progress' }),
    ).toBeNull();
  });

  it('holds the ticket at each money step until its work is recorded', () => {
    const advance = { kind: 'ADVANCE' as const, verified: false };
    expect(
      leaveBlocker(steps, { ...advance, status: 'PENDING_VERIFY' }, { from: 'VERIFY', backward: false }),
    ).not.toBeNull();
    expect(
      leaveBlocker(steps, { ...advance, status: 'PENDING_VERIFY', verified: true }, { from: 'VERIFY', backward: false }),
    ).toBeNull();
    expect(
      leaveBlocker(steps, { ...advance, status: 'APPROVED' }, { from: 'PAY', backward: false }),
    ).not.toBeNull();
    expect(
      leaveBlocker(steps, { ...advance, status: 'PAID' }, { from: 'PAY', backward: false }),
    ).toBeNull();
    expect(
      leaveBlocker(steps, { ...advance, status: 'CLEARING' }, { from: 'CLEAR', backward: false }),
    ).not.toBeNull();
    expect(
      leaveBlocker(steps, { kind: 'PETTY_CASH', verified: true, status: 'PAID' }, { from: 'PAY', backward: false }),
    ).not.toBeNull();
  });

  it('never holds a step going back', () => {
    expect(
      leaveBlocker(steps, { kind: 'ADVANCE', verified: false, status: 'PENDING_VERIFY' }, { from: 'VERIFY', backward: true }),
    ).toBeNull();
  });
});
