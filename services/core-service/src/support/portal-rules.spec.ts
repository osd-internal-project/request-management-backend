import {
  caseProblems,
  customerStatus,
  inviteExpiry,
  inviteState,
  sessionExpiry,
} from './portal-rules';

describe('CD-249 customer portal rules', () => {
  const now = new Date('2026-10-05T00:00:00Z');

  it('invites last 90 days, sessions 8 hours', () => {
    expect(inviteExpiry(now).toISOString()).toBe('2027-01-03T00:00:00.000Z');
    expect(sessionExpiry(now).toISOString()).toBe('2026-10-05T08:00:00.000Z');
  });

  it('an invite opens the portal unless revoked or expired', () => {
    const live = {
      inviteHash: 'h',
      inviteExpires: inviteExpiry(now),
      revokedAt: null,
    };
    expect(inviteState(live, now)).toBe('active');
    expect(inviteState(live, new Date('2027-01-04T00:00:00Z'))).toBe('expired');
    expect(inviteState({ ...live, revokedAt: now }, now)).toBe('revoked');
    expect(inviteState({ ...live, inviteHash: null }, now)).toBe('none');
  });

  it('a case needs a subject and a known severity', () => {
    expect(caseProblems({ subject: 'กล้องดับ', severity: 'high' })).toEqual([]);
    expect(caseProblems({ subject: ' ', severity: 'urgent' })).toHaveLength(2);
  });

  it('shows the customer plain words for a status', () => {
    expect(customerStatus('submitted')).toBe('received');
    expect(customerStatus('in_progress')).toBe('working');
    expect(customerStatus('on_hold')).toBe('waiting');
    expect(customerStatus('closed')).toBe('done');
    expect(customerStatus('rejected')).toBe('cancelled');
  });
});
