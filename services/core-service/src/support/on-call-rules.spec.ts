import { DEFAULT_CALENDAR } from '../sla/business-hours';
import {
  escalationDue,
  outOfHours,
  pickOnCall,
  rotaDay,
  shiftProblems,
} from './on-call-rules';

// Bangkok is UTC+7: 2026-10-06 (Tue) 08:30 local = 01:30Z.
const at = (iso: string) => new Date(iso);

describe('CD-241 on-call rules', () => {
  it('is out of hours before opening, from closing, on weekends and holidays', () => {
    expect(outOfHours(at('2026-10-06T01:29:00Z'), DEFAULT_CALENDAR)).toBe(true);
    expect(outOfHours(at('2026-10-06T01:30:00Z'), DEFAULT_CALENDAR)).toBe(
      false,
    );
    // 17:29 / 17:30 local
    expect(outOfHours(at('2026-10-06T10:29:00Z'), DEFAULT_CALENDAR)).toBe(
      false,
    );
    expect(outOfHours(at('2026-10-06T10:30:00Z'), DEFAULT_CALENDAR)).toBe(true);
    // Saturday noon
    expect(outOfHours(at('2026-10-10T05:00:00Z'), DEFAULT_CALENDAR)).toBe(true);
    // a holiday Tuesday noon
    expect(
      outOfHours(at('2026-10-13T05:00:00Z'), {
        ...DEFAULT_CALENDAR,
        holidays: ['2026-10-13'],
      }),
    ).toBe(true);
  });

  it('answers by the local day — 02:00 Tuesday is Tuesday', () => {
    expect(rotaDay(at('2026-10-05T19:00:00Z'), DEFAULT_CALENDAR)).toBe(
      '2026-10-06',
    );
  });

  it('checks a span: dates, length, a different backup, no overlap', () => {
    const base = {
      startOn: '2026-10-05',
      endOn: '2026-10-11',
      primaryUserId: 'a',
      backupUserId: 'b',
    };
    expect(shiftProblems(base, [])).toEqual([]);
    expect(shiftProblems({ ...base, endOn: '2026-10-04' }, [])).toEqual([
      'วันสิ้นสุดต้องไม่ก่อนวันเริ่ม',
    ]);
    expect(shiftProblems({ ...base, endOn: '2026-11-30' }, [])[0]).toContain(
      'ไม่เกิน 31 วัน',
    );
    expect(shiftProblems({ ...base, backupUserId: 'a' }, [])).toEqual([
      'เวรสำรองต้องเป็นคนละคนกับเวรหลัก',
    ]);
    expect(shiftProblems({ ...base, startOn: 'x' }, [])).toEqual([
      'วันที่ไม่ถูกต้อง',
    ]);
    expect(
      shiftProblems(base, [
        { id: '1', startOn: '2026-10-11', endOn: '2026-10-17' },
      ])[0],
    ).toContain('ทับกับเวร 2026-10-11');
    expect(
      shiftProblems(base, [
        { id: '1', startOn: '2026-10-12', endOn: '2026-10-18' },
      ]),
    ).toEqual([]);
  });

  it('sends to the primary, the backup when the primary is away, else nobody', () => {
    const shift = { primaryUserId: 'a', backupUserId: 'b' };
    expect(pickOnCall(shift, new Set())).toEqual({
      userId: 'a',
      level: 'primary',
    });
    expect(pickOnCall(shift, new Set(['a']))).toEqual({
      userId: 'b',
      level: 'backup',
    });
    expect(pickOnCall(shift, new Set(['a', 'b']))).toBeNull();
    expect(
      pickOnCall({ primaryUserId: 'a', backupUserId: null }, new Set(['a'])),
    ).toBeNull();
  });

  it('hands on after the minutes allowed; 0 never', () => {
    const sent = at('2026-10-06T15:00:00Z');
    expect(escalationDue(sent, at('2026-10-06T15:29:00Z'), 30)).toBe(false);
    expect(escalationDue(sent, at('2026-10-06T15:30:00Z'), 30)).toBe(true);
    expect(escalationDue(sent, at('2026-10-07T15:30:00Z'), 0)).toBe(false);
  });
});
