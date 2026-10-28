import {
  fileProblems,
  inlineSafe,
  isoDay,
  issueDateFor,
} from './document-rules';

describe('company documents — rules', () => {
  it('a dated document must carry its issue date', () => {
    expect(issueDateFor('dated', undefined)).toEqual({
      ok: false,
      reason: 'กรอกวันที่ออกเอกสาร',
    });
    expect(issueDateFor('dated', '  ')).toMatchObject({ ok: false });
  });

  it('a dated document keeps the calendar day it was issued, whatever the time zone', () => {
    const result = issueDateFor('dated', '2026-10-07');
    expect(result).toMatchObject({ ok: true });
    const date = (result as { date: Date }).date;
    expect(date.toISOString()).toBe('2026-10-07T00:00:00.000Z');
    expect(isoDay(date)).toBe('2026-10-07');
    // a datetime from a date picker keeps its day part
    expect(
      isoDay(
        (issueDateFor('dated', '2026-10-07T17:00:00Z') as { date: Date }).date,
      ),
    ).toBe('2026-10-07');
  });

  it('refuses days that are not on the calendar', () => {
    expect(issueDateFor('dated', '2026-02-30')).toMatchObject({ ok: false });
    expect(issueDateFor('dated', '07/10/2026')).toMatchObject({ ok: false });
  });

  it('a general document has no issue date', () => {
    expect(issueDateFor('general', undefined)).toEqual({
      ok: true,
      date: null,
    });
    expect(issueDateFor('general', '2026-10-07')).toMatchObject({ ok: false });
    expect(isoDay(null)).toBeNull();
  });

  it('takes PDF and Office files up to 50 MB, nothing executable', () => {
    expect(fileProblems({ mimetype: 'application/pdf', size: 1024 })).toEqual(
      [],
    );
    expect(
      fileProblems({ mimetype: 'application/x-msdownload', size: 10 }),
    ).toHaveLength(1);
    expect(
      fileProblems({ mimetype: 'application/pdf', size: 51 * 1024 * 1024 }),
    ).toEqual(['ไฟล์ใหญ่เกิน 50 MB']);
  });

  it('only PDF and pictures open in the browser', () => {
    expect(inlineSafe('application/pdf')).toBe(true);
    expect(inlineSafe('application/zip')).toBe(false);
  });
});
