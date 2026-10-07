import {
  readyBlocker,
  canMove,
  editable,
  overdueNow,
  publishProblems,
  remindNow,
} from './content-rules';

describe('CD-271 content calendar rules', () => {
  it('draft → ready → published; cancelled can go back to draft; published is final', () => {
    expect(canMove('draft', 'ready')).toBe(true);
    expect(canMove('ready', 'published')).toBe(true);
    expect(canMove('ready', 'draft')).toBe(true);
    expect(canMove('draft', 'published')).toBe(false);
    expect(canMove('published', 'draft')).toBe(false);
    expect(canMove('cancelled', 'draft')).toBe(true);
    expect(editable('ready')).toBe(true);
    expect(editable('published')).toBe(false);
  });

  it('reminds once, the day before a ready post', () => {
    const plannedAt = new Date('2026-10-10T03:00:00Z');
    const base = { status: 'ready', plannedAt, remindedAt: null };
    expect(remindNow({ ...base, now: new Date('2026-10-09T04:00:00Z') })).toBe(
      true,
    );
    expect(remindNow({ ...base, now: new Date('2026-10-08T02:00:00Z') })).toBe(
      false,
    );
    expect(
      remindNow({
        ...base,
        remindedAt: new Date(),
        now: new Date('2026-10-09T04:00:00Z'),
      }),
    ).toBe(false);
    expect(
      remindNow({
        ...base,
        status: 'draft',
        now: new Date('2026-10-09T04:00:00Z'),
      }),
    ).toBe(false);
  });

  it('overdue an hour past its time while not published', () => {
    const plannedAt = new Date('2026-10-10T03:00:00Z');
    const base = { status: 'ready', plannedAt, overdueAt: null };
    expect(overdueNow({ ...base, now: new Date('2026-10-10T04:30:00Z') })).toBe(
      true,
    );
    expect(overdueNow({ ...base, now: new Date('2026-10-10T03:30:00Z') })).toBe(
      false,
    );
    expect(
      overdueNow({
        ...base,
        status: 'published',
        now: new Date('2026-10-11T00:00:00Z'),
      }),
    ).toBe(false);
  });

  it('publishing needs the live link', () => {
    expect(publishProblems('https://facebook.com/osd/posts/1')).toEqual([]);
    expect(publishProblems('')).toHaveLength(1);
    expect(publishProblems('facebook.com/x')).toHaveLength(1);
  });

  it('CD-272: flagged content (or all, by setting) needs approval for the current version', () => {
    const plain = {
      mentionsCustomer: false,
      mentionsPrice: false,
      mentionsPartner: false,
      approvalStatus: 'none',
      approvedVersion: null,
      version: 1,
    };
    expect(readyBlocker(plain, false)).toBeNull();
    expect(readyBlocker(plain, true)).not.toBeNull();
    const priced = { ...plain, mentionsPrice: true };
    expect(readyBlocker(priced, false)).not.toBeNull();
    expect(
      readyBlocker(
        { ...priced, approvalStatus: 'approved', approvedVersion: 1 },
        false,
      ),
    ).toBeNull();
    // edited after approval: version 2 is not what was approved
    expect(
      readyBlocker(
        {
          ...priced,
          approvalStatus: 'approved',
          approvedVersion: 1,
          version: 2,
        },
        false,
      ),
    ).not.toBeNull();
    expect(canMove('draft', 'pending_approval')).toBe(false);
    expect(canMove('pending_approval', 'ready')).toBe(false);
  });
});
