import {
  lateHours,
  penaltyEstimate,
  periodProblems,
  resolutionOutcome,
  responseOutcome,
  slaFigures,
  type JobClock,
} from './service-report-rules';

const at = (iso: string) => new Date(iso);
const now = at('2026-10-31T00:00:00Z');
const job = (over: Partial<JobClock> = {}): JobClock => ({
  severity: 'high',
  status: 'completed',
  doneAt: at('2026-10-10T05:00:00Z'),
  responseDueAt: at('2026-10-10T01:00:00Z'),
  respondedAt: at('2026-10-10T00:30:00Z'),
  responseBreachedAt: null,
  dueAt: at('2026-10-10T06:00:00Z'),
  breachedAt: null,
  ...over,
});

describe('CD-247 service report rules', () => {
  it('measures response and resolution apart', () => {
    expect(responseOutcome(job(), now)).toBe('met');
    expect(
      responseOutcome(job({ respondedAt: at('2026-10-10T02:00:00Z') }), now),
    ).toBe('missed');
    expect(
      responseOutcome(
        job({ respondedAt: null, responseDueAt: at('2026-11-01T00:00:00Z') }),
        now,
      ),
    ).toBe('pending');
    expect(responseOutcome(job({ responseDueAt: null }), now)).toBe('none');
    expect(resolutionOutcome(job(), now)).toBe('met');
    expect(
      resolutionOutcome(job({ doneAt: at('2026-10-10T09:00:00Z') }), now),
    ).toBe('missed');
    expect(
      resolutionOutcome(job({ status: 'in_progress', doneAt: null }), now),
    ).toBe('missed');
  });

  it('counts hours late, done or still open', () => {
    expect(lateHours(job({ doneAt: at('2026-10-10T09:00:00Z') }), now)).toBe(3);
    expect(lateHours(job(), now)).toBe(0);
    expect(
      lateHours(
        job({
          status: 'in_progress',
          doneAt: null,
          dueAt: at('2026-10-30T00:00:00Z'),
        }),
        now,
      ),
    ).toBe(24);
  });

  it('adds up per severity with a total row', () => {
    const rows = slaFigures(
      [
        job(),
        job({ doneAt: at('2026-10-10T09:00:00Z') }),
        job({ severity: 'critical', respondedAt: at('2026-10-10T03:00:00Z') }),
      ],
      now,
    );
    expect(rows.map((r) => r.severity)).toEqual(['critical', 'high', 'all']);
    expect(rows[1]).toMatchObject({
      jobs: 2,
      resolutionMet: 1,
      resolutionMissed: 1,
      resolutionPct: 50,
      responsePct: 100,
    });
    expect(rows[2]).toMatchObject({
      jobs: 3,
      responseMissed: 1,
      responsePct: 66.7,
    });
  });

  it('puts the contract penalty on misses, per occurrence or per day late, to its cap', () => {
    const terms = {
      ratePct: 1,
      period: 'occurrence',
      capPct: null,
      capAmount: null,
      contractValue: 1_000_000,
    };
    expect(
      penaltyEstimate(terms, 50_000, [{ lateHours: 3 }, { lateHours: 30 }]),
    ).toEqual({
      amount: 1000,
      units: 2,
      capped: false,
      cap: null,
    });
    expect(
      penaltyEstimate({ ...terms, period: 'day' }, 50_000, [
        { lateHours: 3 },
        { lateHours: 30 },
      ]),
    ).toMatchObject({ amount: 1500, units: 3 });
    expect(
      penaltyEstimate({ ...terms, period: 'day', capPct: 0.1 }, 50_000, [
        { lateHours: 3 },
        { lateHours: 30 },
      ]),
    ).toMatchObject({ amount: 1000, capped: true, cap: 1000 });
    expect(penaltyEstimate(terms, null, [{ lateHours: 3 }]).amount).toBeNull();
    expect(penaltyEstimate(terms, 50_000, []).amount).toBeNull();
  });

  it('checks a period', () => {
    expect(periodProblems('2026-10-01', '2026-10-31')).toEqual([]);
    expect(periodProblems('2026-10-31', '2026-10-01')).toHaveLength(1);
    expect(periodProblems('2025-01-01', '2026-10-31')).toHaveLength(1);
  });
});
