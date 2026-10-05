import {
  coverageOn,
  entitlementProblems,
  entitlementState,
  quotaLeft,
  warrantyEnd,
} from './entitlement-rules';

describe('CD-237 entitlement rules', () => {
  it('a warranty runs its months from the acceptance date', () => {
    expect(warrantyEnd('2026-10-05', 12)).toBe('2027-10-04');
    expect(warrantyEnd('2026-01-31', 1)).toBe('2026-02-27');
    expect(warrantyEnd('2026-03-01', 24)).toBe('2028-02-29');
  });

  it('where an entitlement stands on a day', () => {
    const row = {
      startOn: '2026-10-05',
      endOn: '2027-10-04',
      cancelled: false,
    };
    expect(entitlementState(row, '2026-10-01')).toBe('upcoming');
    expect(entitlementState(row, '2027-10-04')).toBe('active');
    expect(entitlementState(row, '2027-10-05')).toBe('expired');
    expect(entitlementState({ ...row, cancelled: true }, '2026-12-01')).toBe(
      'cancelled',
    );
  });

  it('the strongest active coverage answers first', () => {
    const rows = [
      {
        id: 'w',
        startOn: '2026-10-05',
        endOn: '2027-10-04',
        cancelled: false,
        coverage: 'H8X5',
      },
      {
        id: 'ma',
        startOn: '2026-12-01',
        endOn: '2027-11-30',
        cancelled: false,
        coverage: 'H24X7',
      },
      {
        id: 'old',
        startOn: '2025-01-01',
        endOn: '2025-12-31',
        cancelled: false,
        coverage: 'H24X7',
      },
    ];
    expect(coverageOn(rows, '2026-11-01').map((r) => r.id)).toEqual(['w']);
    expect(coverageOn(rows, '2027-01-15').map((r) => r.id)).toEqual([
      'ma',
      'w',
    ]);
    expect(coverageOn(rows, '2028-01-01')).toEqual([]);
  });

  it('quotas: what is left, or unlimited', () => {
    expect(quotaLeft(4, 1)).toBe(3);
    expect(quotaLeft(2, 5)).toBe(0);
    expect(quotaLeft(null, 9)).toBeNull();
  });

  it('an entitlement names its kind, period, level and quotas properly', () => {
    const ok = {
      kind: 'service_contract',
      title: 'MA ปี 2027',
      startOn: '2027-01-01',
      endOn: '2027-12-31',
      coverage: 'H8X5',
      severityTargets: null,
      correctiveQuota: null,
      preventiveQuota: 4,
    };
    expect(entitlementProblems(ok)).toEqual([]);
    expect(
      entitlementProblems({
        ...ok,
        kind: 'x',
        title: ' ',
        endOn: '2026-01-01',
        coverage: 'H1',
        severityTargets: { critical: {} },
        preventiveQuota: -1,
      }),
    ).toHaveLength(6);
  });
});
