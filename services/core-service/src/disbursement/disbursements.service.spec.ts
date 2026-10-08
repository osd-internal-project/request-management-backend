import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { DisbursementsService } from './disbursements.service';

const accountant = {
  userId: 'acc-1',
  username: 'acc',
  isServiceAccount: false,
  activeCompanyId: 'osd',
  permissions: ['disbursement.read.any', 'disbursement.verify', 'disbursement.pay'],
} as unknown as Principal;
const requester = {
  userId: 'may',
  username: 'may',
  isServiceAccount: false,
  activeCompanyId: 'osd',
  permissions: [],
} as unknown as Principal;

const d = (value: string) => new Prisma.Decimal(value);

const STEPS = {
  advanceTypeCode: 'FI05',
  pettyCashTypeCode: 'FI06',
  verifyStep: 'VERIFY',
  execStep: 'EXEC',
  payStep: 'PAY',
  clearStep: 'CLEAR',
  doneStep: 'DONE',
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    companyId: 'osd',
    docNo: 'ADV-OSD-2026-00007',
    kind: 'ADVANCE',
    requestId: 'req-1',
    requestNo: 'REQ-1',
    requesterId: 'may',
    status: 'PENDING_VERIFY',
    currency: 'THB',
    requestedAmount: d('15000.00'),
    paidAmount: d('0'),
    actualAmount: null,
    refundAmount: d('0'),
    extraPaidAmount: d('0'),
    verifyChecks: null,
    verifyNote: null,
    verifiedBy: null,
    paidBy: null,
    clearBy: null,
    lines: [],
    ...over,
  };
}

function harness(
  current: Record<string, unknown> | null,
  ticket: Record<string, unknown> = {},
  legacy = true,
  payouts: Record<string, unknown>[] = [],
  evidence: Record<string, unknown>[] = [],
) {
  const tx = {
    disbursement: { updateMany: jest.fn(() => Promise.resolve({ count: 1 })) },
    disbursementLine: {
      deleteMany: jest.fn(() => Promise.resolve({})),
      createMany: jest.fn(() => Promise.resolve({})),
    },
    disbursementMovement: { create: jest.fn(() => Promise.resolve({})) },
  };
  const disbursements = { findFirst: jest.fn(() => Promise.resolve(current)) };
  const requestRows = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        status: 'in_progress',
        flowVersionId: 'flow-1',
        currentStepCode: 'VERIFY',
        assigneeUserId: 'acc-1',
        receiverUserId: null,
        ...ticket,
      }),
    ),
    findMany: jest.fn(() => Promise.resolve([{ id: 'req-1' }])),
  };
  const requests = {
    advance: jest.fn(() => Promise.resolve({})),
    saveStepForm: jest.fn(() => Promise.resolve({})),
    complete: jest.fn(() => Promise.resolve({})),
  };
  const sync = {
    settingsOf: jest.fn(() => Promise.resolve(STEPS)),
    isLegacyRequest: jest.fn(() => Promise.resolve(legacy)),
    typeCodes: jest.fn(() => Promise.resolve(['FI05', 'FI06'])),
  };
  const movements = {
    findMany: jest.fn(() => Promise.resolve([])),
    findFirst: jest.fn(({ where }: { where: { id?: string; reversesId?: string } }) =>
      Promise.resolve(
        where.reversesId
          ? (payouts.find((m) => m.reversesId === where.reversesId) ?? null)
          : (payouts.find((m) => m.id === where.id && m.type === 'PAYOUT') ?? null),
      ),
    ),
  };
  const notifications = {
    disbursementNotice: jest.fn(() => Promise.resolve()),
  };
  const service = new DisbursementsService(
    disbursements as never,
    movements as never,
    { findMany: jest.fn(() => Promise.resolve(evidence)) } as never,
    requestRows as never,
    requests as never,
    sync as never,
    notifications as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work(tx)) } as never,
  );
  return { service, tx, requestRows, requests, notifications };
}

const CLEARED = new Date('2026-10-08T03:00:00Z');
const BEFORE = new Date('2026-10-08T02:00:00Z');
const AFTER = new Date('2026-10-08T04:00:00Z');
const slip = (kind: string, uploadedAt: Date) => ({
  kind,
  storageKey: `key-${kind}`,
  uploadedAt,
  deletedAt: null,
});

const moveData = (tx: ReturnType<typeof harness>['tx']) =>
  (tx.disbursement.updateMany.mock.calls[0] as unknown as [
    { data: Record<string, unknown> },
  ])[0].data;

const CHECKS = {
  checked_cost_center: true,
  checked_documents: true,
  checked_authority: true,
  note: 'เห็นควรเสนอผู้บริหาร',
};

describe('disbursement — verify moves the ticket to the executive', () => {
  it('records the checks, fills the step form and advances to the executive step', async () => {
    const { service, tx, requests } = harness(row());
    const result = await service.verify(
      accountant,
      'ADV-OSD-2026-00007',
      CHECKS,
      'Bearer t',
    );
    expect(moveData(tx)).toMatchObject({
      status: 'PENDING_VERIFY',
      verifyNote: CHECKS.note,
      verifiedBy: 'acc-1',
    });
    expect(requests.saveStepForm).toHaveBeenCalledWith(
      'req-1',
      { data: CHECKS },
      accountant,
    );
    expect(requests.advance).toHaveBeenCalledWith(
      'req-1',
      { to_step: 'EXEC' },
      accountant,
      'Bearer t',
    );
    expect(result.ticketMove).toEqual({ moved: true, message: null });
  });

  it('a flowless request has no executive step: verified is approved', async () => {
    const { service, tx, requests } = harness(row(), {
      flowVersionId: null,
      currentStepCode: null,
    });
    await service.verify(accountant, 'ADV-OSD-2026-00007', CHECKS, 't');
    expect(moveData(tx)).toMatchObject({ status: 'APPROVED' });
    expect(requests.advance).not.toHaveBeenCalled();
  });

  it('refuses when the ticket is not at the verify step', async () => {
    const { service } = harness(row(), { currentStepCode: 'HEAD' });
    await expect(
      service.verify(accountant, 'ADV-OSD-2026-00007', CHECKS, 't'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('only whoever holds the ticket may verify it', async () => {
    const { service } = harness(row(), { assigneeUserId: 'someone-else' });
    await expect(
      service.verify(accountant, 'ADV-OSD-2026-00007', CHECKS, 't'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a ticket that will not move is reported, the checks stay recorded', async () => {
    const { service, requests } = harness(row());
    requests.advance.mockRejectedValueOnce(new Error('ขั้นนี้ไปต่อไม่ได้'));
    const result = await service.verify(accountant, 'ADV-OSD-2026-00007', CHECKS, 't');
    expect(result.ticketMove).toEqual({ moved: false, message: 'ขั้นนี้ไปต่อไม่ได้' });
  });
});

describe('disbursement — pay, clear, close', () => {
  it('paying an advance records the money out and moves the ticket to clearing', async () => {
    const { service, tx, requests, notifications } = harness(
      row({ status: 'APPROVED', clearBy: new Date('2026-09-15T00:00:00Z') }),
      { currentStepCode: 'PAY' },
    );
    await service.pay(accountant, 'ADV-OSD-2026-00007', { amount: 15000, method: 'transfer' }, 't');
    expect(moveData(tx)).toMatchObject({ status: 'PAID' });
    const movement = (tx.disbursementMovement.create.mock.calls[0] as unknown as [
      { data: { type: string; amount: Prisma.Decimal } },
    ])[0].data;
    expect(movement.type).toBe('PAYOUT');
    expect(movement.amount.toString()).toBe('-15000.00');
    expect(requests.advance).toHaveBeenCalledWith(
      'req-1',
      { to_step: 'CLEAR' },
      accountant,
      't',
    );
    expect(notifications.disbursementNotice).toHaveBeenCalledWith(
      ['may'],
      'osd',
      'disbursement.paid',
      'd-1',
      {
        doc_no: 'ADV-OSD-2026-00007',
        amount: '15,000.00',
        clear_note: ' — ส่งเคลียร์ค่าใช้จ่ายภายใน 15/09/2569',
      },
    );
  });

  it('petty cash closes when paid and the ticket ends', async () => {
    const { service, tx, requests } = harness(
      row({ kind: 'PETTY_CASH', docNo: 'PC-OSD-2026-00001', status: 'APPROVED' }),
      { currentStepCode: 'PAY' },
    );
    await service.pay(accountant, 'PC-OSD-2026-00001', { amount: 15000, method: 'cash' }, 't');
    expect(moveData(tx)).toMatchObject({ status: 'CLOSED', closedBy: 'acc-1' });
    expect(requests.advance).toHaveBeenCalledWith(
      'req-1',
      { to_step: 'DONE' },
      accountant,
      't',
    );
  });

  it('cannot pay before approval', async () => {
    const { service } = harness(row({ status: 'PENDING_EXEC' }));
    await expect(
      service.pay(accountant, 'ADV-OSD-2026-00007', { amount: 1, method: 'cash' }, 't'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('only the requester clears, and the actual spend is totalled', async () => {
    const paid = row({ status: 'PAID', paidAmount: d('15000.00') });
    await expect(
      harness(paid).service.submitClearing(accountant, 'ADV-OSD-2026-00007', {
        items: [{ description: 'x', amount: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const mine = harness(paid);
    await mine.service.submitClearing(requester, 'ADV-OSD-2026-00007', {
      items: [
        { description: 'ค่าเดินทาง', amount: 6000 },
        { description: 'ค่าที่พัก', amount: 4400 },
        { description: 'ค่าอาหาร', amount: 1450 },
        { description: 'เบ็ดเตล็ด', amount: 500 },
      ],
    });
    expect(moveData(mine.tx)).toMatchObject({
      status: 'CLEARING',
      actualAmount: '12350.00',
    });
  });

  it('closing settles the 2,650 refund and ends the ticket', async () => {
    const { service, tx, requests, notifications } = harness(
      row({
        status: 'CLEARING',
        paidAmount: d('15000.00'),
        actualAmount: d('12350.00'),
        clearingAt: CLEARED,
      }),
      { currentStepCode: 'CLEAR' },
      true,
      [],
      [slip('REFUND_PROOF', AFTER)],
    );
    const result = await service.close(
      accountant,
      'ADV-OSD-2026-00007',
      { method: 'transfer' },
      't',
    );
    expect(moveData(tx)).toMatchObject({
      status: 'CLOSED',
      refundAmount: '2650.00',
      extraPaidAmount: '0.00',
    });
    expect(tx.disbursementMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'REFUND',
        amount: '2650.00',
        evidenceFileKey: 'key-REFUND_PROOF',
      }) as unknown,
    });
    expect(requests.advance).toHaveBeenCalledWith(
      'req-1',
      { to_step: 'DONE' },
      accountant,
      't',
    );
    expect(notifications.disbursementNotice).toHaveBeenCalledWith(
      ['may'],
      'osd',
      'disbursement.closed',
      'd-1',
      { doc_no: 'ADV-OSD-2026-00007', settlement: 'คืนเงิน 2,650.00 บาท' },
    );
    expect(result.ticketMove).toEqual({ moved: true, message: null });
  });

  it('a flowless request is completed instead of advanced', async () => {
    const { service, requests } = harness(
      row({
        status: 'CLEARING',
        paidAmount: d('15000.00'),
        actualAmount: d('15000.00'),
      }),
      { flowVersionId: null, currentStepCode: null },
    );
    await service.close(accountant, 'ADV-OSD-2026-00007', {}, 't');
    expect(requests.advance).not.toHaveBeenCalled();
    expect(requests.complete).toHaveBeenCalled();
  });

  it('a difference with no method named is refused', async () => {
    const { service } = harness(
      row({
        status: 'CLEARING',
        paidAmount: d('15000.00'),
        actualAmount: d('16000.00'),
      }),
    );
    await expect(
      service.close(accountant, 'ADV-OSD-2026-00007', {}, 't'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('a refund cannot complete before its proof is attached', async () => {
    const { service, tx } = harness(
      row({
        status: 'CLEARING',
        paidAmount: d('15000.00'),
        actualAmount: d('12350.00'),
        clearingAt: CLEARED,
      }),
      {},
      true,
      [],
      // Attached before the latest clearing: it belongs to the clearing that was sent back.
      [slip('REFUND_PROOF', BEFORE)],
    );
    await expect(
      service.close(accountant, 'ADV-OSD-2026-00007', { method: 'transfer' }, 't'),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'files', reason: 'REFUND_PROOF' }],
    });
    expect(tx.disbursement.updateMany).not.toHaveBeenCalled();
  });

  it('an overspend needs the slip of the extra payment, not the refund proof', async () => {
    const overspent = row({
      status: 'CLEARING',
      paidAmount: d('15000.00'),
      actualAmount: d('16000.00'),
      clearingAt: CLEARED,
    });
    const refused = harness(overspent, {}, true, [], [slip('REFUND_PROOF', AFTER)]);
    await expect(
      refused.service.close(accountant, 'ADV-OSD-2026-00007', { method: 'transfer' }, 't'),
    ).rejects.toMatchObject({ details: [{ field: 'files', reason: 'PAYMENT_SLIP' }] });

    const paid = harness(overspent, {}, true, [], [slip('PAYMENT_SLIP', AFTER)]);
    await paid.service.close(accountant, 'ADV-OSD-2026-00007', { method: 'transfer' }, 't');
    expect(paid.tx.disbursementMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'EXTRA_PAY',
        amount: '-1000.00',
        evidenceFileKey: 'key-PAYMENT_SLIP',
      }) as unknown,
    });
  });

  it('out of scope reads answer 404', async () => {
    const { service } = harness(null);
    await expect(
      service.detail(requester, 'ADV-OSD-2026-00007'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

const accountant2 = { ...accountant, userId: 'acc-2' } as unknown as Principal;

describe('disbursement v3 — instalments, voids and separation of duties', () => {
  const approved = () => row({ status: 'APPROVED' });

  it('records one instalment as partly paid and leaves the request alone', async () => {
    const { service, tx, requests } = harness(approved(), {}, false);
    const result = await service.pay(accountant, 'ADV-OSD-2026-00007', { amount: 5000, method: 'transfer' }, 't');
    expect(moveData(tx)).toMatchObject({ status: 'PARTIALLY_PAID', paidAmount: '5000.00' });
    expect(requests.advance).not.toHaveBeenCalled();
    expect(result.ticketMove).toBeNull();
  });

  it('guards the move on the amount already paid, so two racing instalments cannot both land', async () => {
    const { service, tx } = harness(approved(), {}, false);
    await service.pay(accountant, 'ADV-OSD-2026-00007', { amount: 5000, method: 'transfer' }, 't');
    const where = (tx.disbursement.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ id: 'd-1', status: 'APPROVED' });
    expect(String(where.paidAmount)).toBe('0');
  });

  it('refuses an instalment above what is left of the approved amount', async () => {
    const { service } = harness(row({ status: 'PARTIALLY_PAID', paidAmount: d('10000.00') }), {}, false);
    await expect(
      service.pay(accountant, 'ADV-OSD-2026-00007', { amount: 6000, method: 'transfer' }, 't'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a requester paying their own advance, even with the pay permission', async () => {
    const self = { ...accountant, userId: 'may' } as unknown as Principal;
    const { service } = harness(approved(), {}, false);
    await expect(
      service.pay(self, 'ADV-OSD-2026-00007', { amount: 100, method: 'cash' }, 't'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a second accountant voids an instalment: reversed on the ledger, status back to approved', async () => {
    const payout = { id: 'm-1', type: 'PAYOUT', amount: d('-5000.00'), actedBy: 'acc-1' };
    const { service, tx } = harness(
      row({ status: 'PARTIALLY_PAID', paidAmount: d('5000.00') }),
      {},
      false,
      [payout],
    );
    await service.voidPayment(accountant2, 'ADV-OSD-2026-00007', 'm-1', { reason: 'โอนผิดบัญชี' });
    expect(moveData(tx)).toMatchObject({ status: 'APPROVED', paidAmount: '0.00' });
    expect(tx.disbursementMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'PAYOUT_VOID', reversesId: 'm-1', amount: '5000.00' }) as unknown,
    });
  });

  it('the accountant who paid an instalment cannot void it themselves', async () => {
    const payout = { id: 'm-1', type: 'PAYOUT', amount: d('-5000.00'), actedBy: 'acc-1' };
    const { service } = harness(row({ status: 'PARTIALLY_PAID', paidAmount: d('5000.00') }), {}, false, [payout]);
    await expect(
      service.voidPayment(accountant, 'ADV-OSD-2026-00007', 'm-1', { reason: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an instalment cannot be voided twice', async () => {
    const payout = { id: 'm-1', type: 'PAYOUT', amount: d('-5000.00'), actedBy: 'acc-1' };
    const voided = { id: 'm-2', type: 'PAYOUT_VOID', reversesId: 'm-1' };
    const { service } = harness(
      row({ status: 'PARTIALLY_PAID', paidAmount: d('5000.00') }),
      {},
      false,
      [payout, voided],
    );
    await expect(
      service.voidPayment(accountant2, 'ADV-OSD-2026-00007', 'm-1', { reason: 'x' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('petty cash paid in full waits for accounting to close it, then closes without settlement', async () => {
    const pc = row({ kind: 'PETTY_CASH', docNo: 'PC-OSD-2026-00001', status: 'APPROVED' });
    const paying = harness(pc, {}, false);
    await paying.service.pay(accountant, 'PC-OSD-2026-00001', { amount: 15000, method: 'cash' }, 't');
    expect(moveData(paying.tx)).toMatchObject({ status: 'PAID' });

    const closing = harness({ ...pc, status: 'PAID', paidAmount: d('15000.00') }, {}, false);
    await closing.service.close(accountant, 'PC-OSD-2026-00001', {}, 't');
    expect(moveData(closing.tx)).toMatchObject({ status: 'CLOSED', refundAmount: '0.00' });
    expect(closing.tx.disbursementMovement.create).not.toHaveBeenCalled();
  });

  it('records who refunded and when on the refund movement', async () => {
    const { service, tx } = harness(
      row({ status: 'CLEARING', paidAmount: d('15000.00'), actualAmount: d('12350.00'), clearingAt: CLEARED }),
      {},
      false,
      [],
      [slip('REFUND_PROOF', AFTER)],
    );
    await service.close(
      accountant,
      'ADV-OSD-2026-00007',
      { method: 'transfer', occurred_at: '2026-09-16' },
      't',
    );
    expect(tx.disbursementMovement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'REFUND',
        counterpartyUserId: 'may',
        occurredAt: new Date('2026-09-16T00:00:00Z'),
      }) as unknown,
    });
  });
});


describe('disbursement — who sees it', () => {
  it('accounting holding only disbursement.pay sees the whole company (no more 404 on rows it must pay)', async () => {
    const payer = { ...accountant, permissions: ['request.read', 'disbursement.pay'] } as unknown as Principal;
    const { service } = harness(null);
    await expect(service.visibleWhere(payer)).resolves.toEqual({ companyId: 'osd' });
  });

  it('anyone else sees their own, plus those whose request they may open', async () => {
    const head = { ...requester, userId: 'head-1' } as unknown as Principal;
    const { service, requestRows } = harness(null);
    await expect(service.visibleWhere(head)).resolves.toEqual({
      companyId: 'osd',
      OR: [{ requesterId: 'head-1' }, { requestId: { in: ['req-1'] } }],
    });
    expect(requestRows.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true } }),
    );
  });

  it('"mine" narrows even accounting to their own', async () => {
    const { service } = harness(null);
    await expect(service.visibleWhere(accountant, 'mine')).resolves.toEqual({
      companyId: 'osd',
      requesterId: 'acc-1',
    });
  });

  it('several statuses and overdue combine with visibility', async () => {
    const { service } = harness(null);
    const where = await service.listWhere(accountant, { status: 'PAID, CLEARING', overdue: true });
    expect(where).toMatchObject({
      AND: [
        { companyId: 'osd' },
        {},
        { status: { in: ['PAID', 'CLEARING'] } },
        { kind: 'ADVANCE', status: { in: ['PAID', 'CLEARING'] } },
      ],
    });
  });
});

describe('disbursement v3 — accounting checks on the disbursement, closing finishes the request', () => {
  it('verify makes it payable and leaves the request at its work step', async () => {
    const { service, tx, requests } = harness(row(), { currentStepCode: 'DISBURSE' }, false);
    await service.verify(accountant, 'ADV-OSD-2026-00007', CHECKS, 't');
    expect(moveData(tx)).toMatchObject({ status: 'APPROVED', verifiedBy: 'acc-1' });
    expect(requests.advance).not.toHaveBeenCalled();
  });

  it('closing moves the request from its work step to DONE', async () => {
    const { service, requests } = harness(
      row({ status: 'CLEARING', paidAmount: d('15000.00'), actualAmount: d('15000.00') }),
      { currentStepCode: 'DISBURSE' },
      false,
    );
    await service.close(accountant, 'ADV-OSD-2026-00007', {}, 't');
    expect(requests.advance).toHaveBeenCalledWith('req-1', { to_step: 'DONE' }, accountant, 't');
  });
});
