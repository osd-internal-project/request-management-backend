import {
  convertible,
  eventCounts,
  eventOpen,
  leadNote,
  seatFor,
} from './campaign-event-rules';

describe('CD-270 event rules', () => {
  it('a seat while there is one, then the waitlist; no limit = always a seat', () => {
    expect(seatFor(2, 1)).toBe('registered');
    expect(seatFor(2, 2)).toBe('waitlisted');
    expect(seatFor(null, 500)).toBe('registered');
  });

  it('the form closes once the event has ended', () => {
    const now = new Date('2026-10-20T10:00:00Z');
    expect(eventOpen(new Date('2026-10-20T11:00:00Z'), now)).toBe(true);
    expect(eventOpen(new Date('2026-10-20T09:00:00Z'), now)).toBe(false);
    expect(eventOpen(null, now)).toBe(true);
  });

  it('only those who came, are interested and are not yet a Lead convert', () => {
    const came = {
      status: 'registered',
      attendedAt: new Date(),
      interest: 'interested',
      leadId: null,
    };
    expect(convertible(came)).toBe(true);
    expect(convertible({ ...came, attendedAt: null })).toBe(false);
    expect(convertible({ ...came, interest: 'later' })).toBe(false);
    expect(convertible({ ...came, leadId: 'lead-1' })).toBe(false);
    expect(convertible({ ...came, status: 'cancelled' })).toBe(false);
  });

  it('counts the event', () => {
    const at = new Date();
    expect(
      eventCounts([
        {
          status: 'registered',
          attendedAt: at,
          interest: 'interested',
          leadId: 'l',
          walkIn: false,
        },
        {
          status: 'registered',
          attendedAt: null,
          interest: null,
          leadId: null,
          walkIn: false,
        },
        {
          status: 'waitlisted',
          attendedAt: null,
          interest: null,
          leadId: null,
          walkIn: false,
        },
        {
          status: 'registered',
          attendedAt: at,
          interest: 'later',
          leadId: null,
          walkIn: true,
        },
        {
          status: 'cancelled',
          attendedAt: null,
          interest: null,
          leadId: null,
          walkIn: false,
        },
      ]),
    ).toEqual({
      registered: 3,
      waitlisted: 1,
      cancelled: 1,
      attended: 2,
      walkIns: 1,
      interested: 1,
      converted: 1,
    });
  });

  it('the Lead says where it came from', () => {
    expect(
      leadNote({
        eventName: 'สัมมนา Smart Building',
        eventDay: '2026-10-20',
        walkIn: true,
        need: 'กล้อง 40 จุด',
        followNote: 'ขอใบเสนอราคาภายในเดือนนี้',
      }),
    ).toBe(
      'เข้าร่วม สัมมนา Smart Building (2026-10-20) · walk-in\nความต้องการ: กล้อง 40 จุด\nหมายเหตุหลังงาน: ขอใบเสนอราคาภายในเดือนนี้',
    );
  });
});
