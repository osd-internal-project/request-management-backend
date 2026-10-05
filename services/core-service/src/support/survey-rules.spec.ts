import { assessHealth } from '../crm/keeper-rules';
import {
  answerProblems,
  expiryFrom,
  groupFigures,
  isLow,
  newToken,
  surveyFigures,
  surveyState,
  tokenHash,
} from './survey-rules';

const fact = (
  over: Partial<Parameters<typeof surveyFigures>[0][number]> = {},
) => ({
  sentAt: new Date(),
  answeredAt: new Date(),
  overall: 4,
  speed: 4,
  technician: 5,
  outcome: null,
  assigneeUserId: 'u1',
  month: '2026-10',
  ...over,
});

describe('CD-248 satisfaction survey rules', () => {
  it('keeps only the hash of the link secret', () => {
    const { token, hash } = newToken();
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toBe(tokenHash(token));
    expect(hash).not.toContain(token);
  });

  it('is open until answered or expired (14 days)', () => {
    const sent = new Date('2026-10-05T00:00:00Z');
    const expiresAt = expiryFrom(sent);
    expect(expiresAt.toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(
      surveyState(
        { answeredAt: null, expiresAt },
        new Date('2026-10-18T00:00:00Z'),
      ),
    ).toBe('open');
    expect(
      surveyState(
        { answeredAt: null, expiresAt },
        new Date('2026-10-19T00:00:00Z'),
      ),
    ).toBe('expired');
    expect(
      surveyState(
        { answeredAt: sent, expiresAt },
        new Date('2026-12-01T00:00:00Z'),
      ),
    ).toBe('answered');
  });

  it('needs an overall 1–5; the aspects are optional but 1–5', () => {
    expect(answerProblems({ overall: 5 })).toEqual([]);
    expect(answerProblems({ overall: 0 })).toHaveLength(1);
    expect(answerProblems({ overall: 3, speed: 6 })).toEqual([
      'คะแนนต้องอยู่ระหว่าง 1–5',
    ]);
    expect(answerProblems({ overall: 3, speed: null })).toEqual([]);
    expect(isLow(2)).toBe(true);
    expect(isLow(3)).toBe(false);
  });

  it('adds up the response rate and averages, overall and by technician', () => {
    const rows = [
      fact(),
      fact({ overall: 2, speed: 1, assigneeUserId: 'u2' }),
      fact({ answeredAt: null, overall: null, speed: null, technician: null }),
    ];
    expect(surveyFigures(rows)).toEqual({
      sent: 3,
      answered: 2,
      responsePct: 66.7,
      overall: 3,
      speed: 2.5,
      technician: 5,
      outcome: null,
      low: 1,
    });
    expect(
      groupFigures(rows, (row) => row.assigneeUserId).map((g) => [
        g.key,
        g.overall,
      ]),
    ).toEqual([
      ['u1', 4],
      ['u2', 2],
    ]);
  });

  it('feeds Keeper: low recent ratings make the customer amber or red (2 answers at least)', () => {
    const base = {
      cases: null,
      invoiceOverdue: null,
      contracts: { endingInDays: null, renewalOpen: false, renewalLost: false },
      satisfaction: null,
      lastContactAt: new Date(),
      since: new Date(),
    };
    const level = (csat: { avg: number; count: number } | null) =>
      assessHealth({ ...base, csat }, { noContactDays: 0 }, new Date()).level;
    expect(level(null)).toBe('green');
    expect(level({ avg: 3.0, count: 1 })).toBe('green');
    expect(level({ avg: 3.0, count: 2 })).toBe('amber');
    expect(level({ avg: 2.0, count: 3 })).toBe('red');
    expect(level({ avg: 4.2, count: 5 })).toBe('green');
  });
});
