import {
  gapKey,
  isLowRated,
  remindDue,
  selfAnswerPct,
  thresholdsOf,
  DEFAULT_THRESHOLDS,
} from './kb-gap-rules';

describe('CD-266 knowledge gap rules', () => {
  it('the same question is one gap', () => {
    expect(gapKey('  VPN หลุด?? ทำไง! ')).toBe('vpn หลุด ทำไง');
    expect(gapKey('vpn   หลุด ทำไง')).toBe(gapKey('VPN หลุด, ทำไง?'));
  });

  it('low rated needs enough votes and a low share', () => {
    const t = DEFAULT_THRESHOLDS;
    expect(isLowRated(1, 3, t)).toBe(false); // 4 votes < 5
    expect(isLowRated(2, 3, t)).toBe(true); // 40%
    expect(isLowRated(3, 3, t)).toBe(false); // 50%
  });

  it('reminds past due, then every n days', () => {
    expect(remindDue('2026-10-10', null, '2026-10-10', 3)).toBe(false);
    expect(remindDue('2026-10-10', null, '2026-10-11', 3)).toBe(true);
    expect(remindDue('2026-10-10', '2026-10-11', '2026-10-13', 3)).toBe(false);
    expect(remindDue('2026-10-10', '2026-10-11', '2026-10-14', 3)).toBe(true);
  });

  it('thresholds from the rule, else standard', () => {
    expect(thresholdsOf({ min_votes: 10 }).minVotes).toBe(10);
    expect(thresholdsOf({}).helpfulPercent).toBe(50);
  });

  it('self-answer rate', () => {
    expect(selfAnswerPct(3, 1)).toBe(75);
    expect(selfAnswerPct(0, 0)).toBeNull();
  });
});
