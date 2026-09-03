import { format, toYearMonth } from './doc-number.service';

/** REQ-02 / D-02 / D-19 — `OSD-DSC-202608-0042`. */
describe('REQ-02 document number format', () => {
  const parts = {
    prefix: 'OSD',
    typeCode: 'DSC',
    yearMonth: 202608,
    seq: 42,
    padding: 4,
  };

  it('builds the number from the spec example', () => {
    expect(format('{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}', parts)).toBe(
      'OSD-DSC-202608-0042',
    );
  });

  it('pads the sequence to the configured width', () => {
    expect(format('{SEQ}', { ...parts, seq: 7 })).toBe('0007');
    expect(format('{SEQ}', { ...parts, seq: 7, padding: 6 })).toBe('000007');
  });

  /** A busy month must not silently corrupt the format. */
  it('does not truncate a sequence wider than the padding', () => {
    expect(format('{SEQ}', { ...parts, seq: 123456 })).toBe('123456');
  });

  it('honours a per-company pattern', () => {
    expect(format('{TYPE}/{YYYYMM}/{SEQ}', parts)).toBe('DSC/202608/0042');
  });

  it('leaves an unknown placeholder alone rather than emitting undefined', () => {
    expect(format('{PREFIX}-{NOPE}', parts)).toBe('OSD-{NOPE}');
  });

  /**
   * The format in force since 3 ก.ย. 2569, named by the chatbot use case.
   *
   * The company prefix is kept in the middle: `requestNo` is unique across the
   * database while the counter resets per company, so dropping it would have
   * two companies issue the same number and the second submit fail.
   */
  describe('REQ-{PREFIX}-{TYPE}-{YYMM}{SEQ}', () => {
    const presales = {
      prefix: 'OSD',
      typeCode: 'PS01',
      yearMonth: 202609,
      seq: 1,
      padding: 4,
    };

    it('builds the number the use case asks for', () => {
      expect(format('REQ-{PREFIX}-{TYPE}-{YYMM}{SEQ}', presales)).toBe(
        'REQ-OSD-PS01-26090001',
      );
    });

    it('keeps two companies apart in the same month', () => {
      const other = { ...presales, prefix: 'BCO' };

      expect(format('REQ-{PREFIX}-{TYPE}-{YYMM}{SEQ}', other)).not.toBe(
        format('REQ-{PREFIX}-{TYPE}-{YYMM}{SEQ}', presales),
      );
    });

    /*
      `{YYMM}` is a prefix of what `{YYYYMM}` expands to, so substituting it
      first would turn a full-year pattern into `{YY202609}`. Longest token
      first — this is the test that says so.
    */
    it('does not eat half of a pattern still using the full year', () => {
      expect(format('{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}', parts)).toBe(
        'OSD-DSC-202608-0042',
      );
    });

    it('takes the last two digits of the year, not the first', () => {
      expect(format('{YYMM}', { ...parts, yearMonth: 203012 })).toBe('3012');
    });
  });
});

describe('REQ-02 year-month key', () => {
  it('is CE year and month, per D-02', () => {
    expect(toYearMonth(new Date('2026-08-24T00:00:00Z'))).toBe(202608);
  });

  it('pads the month so ordering is numeric', () => {
    expect(toYearMonth(new Date('2026-01-05T00:00:00Z'))).toBe(202601);
    expect(toYearMonth(new Date('2026-12-31T00:00:00Z'))).toBe(202612);
  });

  /**
   * The counter key changes at the month boundary, which is what makes the
   * sequence reset monthly without anything having to clear it.
   */
  it('changes across a month boundary', () => {
    const dec = toYearMonth(new Date('2026-12-31T23:59:59Z'));
    const jan = toYearMonth(new Date('2027-01-01T00:00:01Z'));

    expect(dec).toBe(202612);
    expect(jan).toBe(202701);
    expect(jan).toBeGreaterThan(dec);
  });
});
