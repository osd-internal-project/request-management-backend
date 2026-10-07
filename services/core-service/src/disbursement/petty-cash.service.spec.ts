import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { PettyCashService } from './petty-cash.service';

const custodian = {
  userId: 'cust',
  username: 'cust',
  isServiceAccount: false,
  activeCompanyId: 'osd',
  permissions: ['disbursement.fund.manage', 'disbursement.pay'],
} as unknown as Principal;

const d = (value: string) => new Prisma.Decimal(value);

const FUND = {
  id: 'fund-1',
  companyId: 'osd',
  code: 'PC-HQ',
  name: 'เงินสดย่อยสำนักงานใหญ่',
  custodianUserId: 'cust',
  orgUnitId: null,
  imprestAmount: d('20000.00'),
  perClaimLimit: d('2000.00'),
  currency: 'THB',
  active: true,
};

function harness(opts: {
  fund?: Record<string, unknown> | null;
  ledger?: string[];
  claims?: { id: string; paidAmount: Prisma.Decimal }[];
  matrix?: boolean;
  replenishment?: Record<string, unknown> | null;
} = {}) {
  const tx = {
    pettyCashFund: {
      create: jest.fn(() => Promise.resolve({ ...FUND })),
      update: jest.fn(() => Promise.resolve({})),
    },
    pettyCashReplenishment: {
      create: jest.fn(() => Promise.resolve({ id: 'rep-1' })),
      update: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    disbursement: {
      updateMany: jest.fn(() =>
        Promise.resolve({ count: (opts.claims ?? []).length }),
      ),
    },
    disbursementMovement: { create: jest.fn(() => Promise.resolve({})) },
  };
  const funds = {
    findFirst: jest.fn(() =>
      Promise.resolve(opts.fund === undefined ? FUND : opts.fund),
    ),
    findMany: jest.fn(() => Promise.resolve([FUND])),
    count: jest.fn(() => Promise.resolve(0)),
  };
  const replenishments = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        opts.replenishment ?? {
          id: 'rep-1',
          companyId: 'osd',
          status: 'APPROVED',
          totalAmount: d('0'),
        },
      ),
    ),
    count: jest.fn(() => Promise.resolve(0)),
    update: jest.fn(() => Promise.resolve({})),
  };
  const disbursements = {
    findMany: jest.fn(() => Promise.resolve(opts.claims ?? [])),
  };
  const movements = {
    findMany: jest.fn(() =>
      Promise.resolve((opts.ledger ?? ['20000.00']).map((a) => ({ amount: d(a) }))),
    ),
  };
  const approvals = {
    hasPublishedMatrix: jest.fn(() => Promise.resolve(opts.matrix ?? false)),
    openCase: jest.fn(() => Promise.resolve({ id: 'case-7' })),
  };
  const runNumbers = {
    issueUnused: jest.fn(() => Promise.resolve('PCR-OSD-2026-00001')),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new PettyCashService(
    funds as never,
    replenishments as never,
    disbursements as never,
    movements as never,
    approvals as never,
    runNumbers as never,
    { on: jest.fn() } as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work(tx)) } as never,
  );
  return { service, tx, approvals, replenishments, funds };
}

const firstData = (mock: jest.Mock) =>
  (mock.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    .data;

describe('petty cash — funds', () => {
  it('opening a fund books the imprest as its first cash', async () => {
    const { service, tx } = harness();
    await service.openFund(custodian, {
      code: 'PC-HQ',
      name: 'เงินสดย่อยสำนักงานใหญ่',
      custodian_user_id: 'cust',
      imprest_amount: 20000,
      per_claim_limit: 2000,
    });
    expect(firstData(tx.pettyCashFund.create)).toMatchObject({
      imprestAmount: '20000.00',
      perClaimLimit: '2000.00',
    });
    expect(firstData(tx.disbursementMovement.create)).toMatchObject({
      type: 'FUND_OPEN',
      fundId: 'fund-1',
    });
  });

  it('cash on hand is the ledger’s sum; outstanding is what awaits a top-up', async () => {
    const { service } = harness({ ledger: ['20000.00', '-1500.00', '-450.50'] });
    await expect(service.fund(custodian, 'PC-HQ')).resolves.toMatchObject({
      cashOnHand: '18049.50',
      outstanding: '1950.50',
    });
  });

  it('raising the imprest books the difference as an adjustment', async () => {
    const { service, tx } = harness();
    await service.updateFund(custodian, 'PC-HQ', { imprest_amount: 25000 });
    expect(firstData(tx.disbursementMovement.create)).toMatchObject({
      type: 'FUND_ADJUST',
      amount: '5000.00',
    });
  });

  it('an unchanged imprest writes no ledger row', async () => {
    const { service, tx } = harness();
    await service.updateFund(custodian, 'PC-HQ', { name: 'ใหม่' });
    expect(tx.disbursementMovement.create).not.toHaveBeenCalled();
  });
});

describe('petty cash — replenishment', () => {
  const claims = [
    { id: 'c-1', paidAmount: d('1500.00') },
    { id: 'c-2', paidAmount: d('450.50') },
  ];

  it('gathers the paid claims; with no matrix it is approved at once', async () => {
    const { service, tx, approvals } = harness({ claims });
    await service.replenish(custodian, { fund_code: 'PC-HQ' }, 'Bearer t');
    expect(firstData(tx.pettyCashReplenishment.create)).toMatchObject({
      docNo: 'PCR-OSD-2026-00001',
      status: 'APPROVED',
      totalAmount: '1950.50',
    });
    expect(approvals.openCase).not.toHaveBeenCalled();
  });

  it('with a matrix it waits for approval on its own case', async () => {
    const { service, tx, approvals, replenishments } = harness({
      claims,
      matrix: true,
    });
    await service.replenish(custodian, { fund_code: 'PC-HQ' }, 'Bearer t');
    expect(firstData(tx.pettyCashReplenishment.create)).toMatchObject({
      status: 'PENDING_APPROVAL',
    });
    expect(approvals.openCase).toHaveBeenCalledWith(
      expect.objectContaining({
        subject_type: 'disbursement:REPLENISH',
        amount: '1950.50',
      }),
      custodian,
      'Bearer t',
    );
    expect(replenishments.update).toHaveBeenCalledWith({
      where: { id: 'rep-1' },
      data: { approvalCaseId: 'case-7' },
    });
  });

  it('only the custodian asks, and only when there is something to top up', async () => {
    const stranger = { ...custodian, userId: 'x' } as unknown as Principal;
    await expect(
      harness({ claims }).service.replenish(stranger, { fund_code: 'PC-HQ' }, 't'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      harness({ claims: [] }).service.replenish(custodian, { fund_code: 'PC-HQ' }, 't'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('a refused top-up releases its claims for the next one', async () => {
    const { service, tx } = harness({
      replenishment: { id: 'rep-1', companyId: 'osd', status: 'PENDING_APPROVAL' },
    });
    await service.onDecided('case-7', 'rejected');
    expect(tx.pettyCashReplenishment.update).toHaveBeenCalledWith({
      where: { id: 'rep-1' },
      data: { status: 'REJECTED' },
    });
    expect(tx.disbursement.updateMany).toHaveBeenCalledWith({
      where: { replenishmentId: 'rep-1' },
      data: { replenishmentId: null },
    });
  });

  it('paying an approved top-up puts the cash back into the fund', async () => {
    const { service, tx } = harness({
      replenishment: {
        id: 'rep-1',
        companyId: 'osd',
        fundId: 'fund-1',
        status: 'APPROVED',
        totalAmount: d('1950.50'),
      },
    });
    await service.payReplenishment(custodian, 'PCR-OSD-2026-00001', {
      method: 'transfer',
    });
    expect(firstData(tx.disbursementMovement.create)).toMatchObject({
      type: 'REPLENISH',
      fundId: 'fund-1',
      replenishmentId: 'rep-1',
    });
  });
});
