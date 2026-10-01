import { billingProblems, cashForecast, paymentStatus } from './payment-rules';

const today = '2026-11-15';
const base = {
  seq: 2,
  kind: 'progress',
  amount: 100000,
  dueOn: '2026-12-31',
  milestone: null,
  billing: null,
};

describe('CD-193 where an installment stands', () => {
  it('a deposit is billable once signed; paid when the money is in', () => {
    expect(
      paymentStatus(
        { ...base, kind: 'deposit', dueOn: null },
        { signed: true, today },
      ),
    ).toMatchObject({ state: 'billable', overdue: false });
    expect(
      paymentStatus(
        {
          ...base,
          billing: {
            invoicedOn: '2026-10-01',
            invoicedAmount: 100000,
            paidOn: '2026-10-20',
            paidAmount: 100000,
          },
        },
        { signed: true, today },
      ),
    ).toMatchObject({
      state: 'paid',
      expectedPayOn: '2026-10-20',
      received: 100000,
    });
  });

  it('a progress payment waits for its milestone, expected on its forecast plus credit', () => {
    expect(
      paymentStatus(
        {
          ...base,
          milestone: {
            status: 'planned',
            achievedOn: null,
            forecast: '2026-12-10',
          },
        },
        { signed: true, today },
      ),
    ).toMatchObject({
      state: 'waiting',
      expectedBillOn: '2026-12-10',
      expectedPayOn: '2027-01-09',
    });
    expect(
      paymentStatus(
        {
          ...base,
          milestone: {
            status: 'achieved',
            achievedOn: '2026-11-01',
            forecast: null,
          },
        },
        { signed: true, today },
      ),
    ).toMatchObject({ state: 'billable', expectedBillOn: '2026-11-01' });
  });

  it('late: billed and unpaid past its credit, or not billed past its due day', () => {
    expect(
      paymentStatus(
        {
          ...base,
          billing: {
            invoicedOn: '2026-10-01',
            invoicedAmount: 100000,
            paidOn: null,
            paidAmount: null,
          },
        },
        { signed: true, today },
      ),
    ).toMatchObject({
      state: 'invoiced',
      expectedPayOn: '2026-10-31',
      overdue: true,
    });
    expect(
      paymentStatus({ ...base, dueOn: '2026-11-01' }, { signed: true, today })
        .overdue,
    ).toBe(true);
  });
});

describe('CD-193 cash by month', () => {
  it('splits received from expected, and counts what has no date', () => {
    expect(
      cashForecast([
        {
          amount: 45000,
          state: 'paid',
          expectedPayOn: '2026-10-20',
          received: 45000,
        },
        {
          amount: 60000,
          state: 'invoiced',
          expectedPayOn: '2026-10-31',
          received: 0,
        },
        {
          amount: 45000,
          state: 'waiting',
          expectedPayOn: '2027-01-09',
          received: 0,
        },
        { amount: 10000, state: 'waiting', expectedPayOn: null, received: 0 },
      ]),
    ).toEqual({
      months: [
        { month: '2026-10', received: 45000, expected: 60000 },
        { month: '2027-01', received: 0, expected: 45000 },
      ],
      unscheduled: 10000,
    });
  });
});

describe('CD-193 a billing record', () => {
  it('paid only after billed, never in the future', () => {
    const ok = {
      invoicedOn: '2026-11-01',
      invoicedAmount: 1,
      paidOn: '2026-11-10',
      paidAmount: 1,
      today,
    };
    expect(billingProblems(ok)).toEqual([]);
    expect(billingProblems({ ...ok, invoicedOn: null })).toHaveLength(1);
    expect(billingProblems({ ...ok, paidOn: '2026-10-01' })).toHaveLength(1);
    expect(billingProblems({ ...ok, paidOn: '2026-11-20' })).toHaveLength(1);
  });
});
