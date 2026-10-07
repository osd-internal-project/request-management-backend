import {
  bangkokClock,
  checkBeforeCall,
  DEFAULT_WINDOWS,
  inWindow,
  openingFor,
  windowsProblem,
} from './call-rules';

/** 2026-10-07 is a Wednesday; 03:00Z is 10:00 in Bangkok. */
const WED_10 = new Date('2026-10-07T03:00:00Z');

const ready = {
  policyCertified: true,
  listStatus: 'active',
  targetStatus: 'pending',
  phone: '021234567',
  blocked: false,
  attempts: 0,
  lastAttemptAt: null,
  maxAttempts: 3,
  minGapDays: 3,
  inWindow: true,
  now: WED_10,
};

describe('CD-291 calling rules', () => {
  it('reads the clock in Bangkok', () => {
    expect(bangkokClock(WED_10)).toEqual({
      weekday: 3,
      time: '10:00',
      date: '2026-10-07',
    });
    expect(bangkokClock(new Date('2026-10-10T18:00:00Z')).weekday).toBe(7);
  });

  it('calls only inside a window, never on a holiday or a Sunday', () => {
    expect(inWindow(DEFAULT_WINDOWS, [], WED_10)).toBe(true);
    expect(inWindow(DEFAULT_WINDOWS, ['2026-10-07'], WED_10)).toBe(false);
    // Wednesday 18:30 Bangkok
    expect(
      inWindow(DEFAULT_WINDOWS, [], new Date('2026-10-07T11:30:00Z')),
    ).toBe(false);
    // Saturday 11:00 yes, 12:30 no; Sunday never
    expect(
      inWindow(DEFAULT_WINDOWS, [], new Date('2026-10-10T04:00:00Z')),
    ).toBe(true);
    expect(
      inWindow(DEFAULT_WINDOWS, [], new Date('2026-10-10T05:30:00Z')),
    ).toBe(false);
    expect(
      inWindow(DEFAULT_WINDOWS, [], new Date('2026-10-11T03:00:00Z')),
    ).toBe(false);
  });

  it('rejects windows that make no sense', () => {
    expect(windowsProblem([])).not.toBeNull();
    expect(
      windowsProblem([{ day: 8, from: '09:00', to: '10:00' }]),
    ).not.toBeNull();
    expect(
      windowsProblem([{ day: 1, from: '18:00', to: '09:00' }]),
    ).not.toBeNull();
    expect(windowsProblem(DEFAULT_WINDOWS)).toBeNull();
  });

  it('holds a call for the first reason a person should read', () => {
    expect(checkBeforeCall(ready)).toBeNull();
    expect(
      checkBeforeCall({ ...ready, policyCertified: false, blocked: true }),
    ).toBe('policy_uncertified');
    expect(checkBeforeCall({ ...ready, listStatus: 'draft' })).toBe(
      'list_not_active',
    );
    expect(checkBeforeCall({ ...ready, blocked: true, inWindow: false })).toBe(
      'do_not_contact',
    );
    expect(checkBeforeCall({ ...ready, attempts: 3 })).toBe('attempts_used');
    expect(
      checkBeforeCall({
        ...ready,
        attempts: 1,
        lastAttemptAt: new Date('2026-10-05T03:00:00Z'),
      }),
    ).toBe('too_soon');
    expect(checkBeforeCall({ ...ready, inWindow: false })).toBe(
      'outside_window',
    );
    expect(checkBeforeCall({ ...ready, phone: null })).toBe('no_phone');
    // a target stopped by the register says so, not just "finished"
    expect(checkBeforeCall({ ...ready, targetStatus: 'blocked' })).toBe(
      'do_not_contact',
    );
    expect(checkBeforeCall({ ...ready, targetStatus: 'done' })).toBe('finished');
  });

  it('the opening names the company and always ends with how to refuse', () => {
    const said = openingFor(
      {
        openingScript: 'โทรจาก {company} ค่ะ',
        optOutScript: 'พูดว่า ไม่ต้องติดต่ออีก',
      },
      'OSD',
    );
    expect(said).toBe('โทรจาก OSD ค่ะ พูดว่า ไม่ต้องติดต่ออีก');
  });
});
