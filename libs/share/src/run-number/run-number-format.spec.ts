import { MAX_TAKEN_SKIPS, firstFreeCode } from './first-free-code';
import {
  formatRunNumber,
  periodKeyOf,
  tokensIn,
  unresolvedTokens,
  validatePattern,
} from './run-number-format';
import { tokensFor } from './run-number-tokens';
import type { RunNumberContext, RunNumberFormat } from './run-number.types';

function ctx(overrides: Partial<RunNumberContext> = {}): RunNumberContext {
  return {
    companyId: 'company-osd',
    docType: 'REQUEST',
    scopeKey: 'PS01',
    companyPrefix: 'OSD',
    companyCode: 'OSD',
    at: new Date('2026-09-22T03:00:00Z'),
    ...overrides,
  };
}

function fmt(overrides: Partial<RunNumberFormat> = {}): RunNumberFormat {
  return {
    pattern: 'REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}',
    seqPadding: 4,
    startNumber: 1,
    resetPeriod: 'monthly',
    ...overrides,
  };
}

/** REQ-02 / D-02 / D-19 — ยกมาจาก doc-number.spec.ts ทั้งชุด. */
describe('REQ-02 รูปแบบเลขที่เอกสาร', () => {
  const august = ctx({
    scopeKey: 'DSC',
    at: new Date('2026-08-24T03:00:00Z'),
  });

  it('สร้างเลขตามตัวอย่างในสเปค', () => {
    expect(
      formatRunNumber(
        fmt({ pattern: '{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}' }),
        august,
        42,
      ),
    ).toBe('OSD-DSC-202608-0042');
  });

  it('เติมศูนย์ลำดับตามความยาวที่ตั้งไว้', () => {
    expect(formatRunNumber(fmt({ pattern: '{SEQ}' }), august, 7)).toBe('0007');
    expect(
      formatRunNumber(fmt({ pattern: '{SEQ}', seqPadding: 6 }), august, 7),
    ).toBe('000007');
  });

  it('ไม่ตัดลำดับที่ยาวกว่าความยาวที่ตั้งไว้', () => {
    expect(formatRunNumber(fmt({ pattern: '{SEQ}' }), august, 123456)).toBe(
      '123456',
    );
  });

  it('ใช้รูปแบบเฉพาะของแต่ละบริษัทได้', () => {
    expect(
      formatRunNumber(fmt({ pattern: '{TYPE}/{YYYYMM}/{SEQ}' }), august, 42),
    ).toBe('DSC/202608/0042');
  });

  it('ทิ้ง placeholder ที่ไม่รู้จักไว้ ไม่แทนด้วย undefined', () => {
    expect(
      formatRunNumber(fmt({ pattern: '{PREFIX}-{NOPE}' }), august, 1),
    ).toBe('OSD-{NOPE}');
  });

  describe('REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}', () => {
    it('สร้างเลขที่ use case ต้องการ', () => {
      expect(formatRunNumber(fmt(), ctx(), 1)).toBe('REQ-OSD-PS01-26090001');
    });

    it('แยกสองบริษัทออกจากกันในเดือนเดียวกัน', () => {
      expect(formatRunNumber(fmt(), ctx({ companyPrefix: 'BCO' }), 1)).not.toBe(
        formatRunNumber(fmt(), ctx(), 1),
      );
    });

    it('ไม่กินครึ่ง pattern ที่ยังใช้ปีเต็ม', () => {
      expect(
        formatRunNumber(
          fmt({ pattern: '{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}' }),
          august,
          42,
        ),
      ).toBe('OSD-DSC-202608-0042');
    });

    it('เอาเลขปีสองหลักท้าย ไม่ใช่สองหลักหน้า', () => {
      expect(
        formatRunNumber(
          fmt({ pattern: '{YYMM}' }),
          ctx({ at: new Date('2030-12-05T03:00:00Z') }),
          1,
        ),
      ).toBe('3012');
    });
  });
});

describe('ตัวแปรที่เพิ่มเข้ามา', () => {
  it('ให้ปี พ.ศ. ทั้งสี่หลักและสองหลัก', () => {
    expect(formatRunNumber(fmt({ pattern: '{BYYYY}-{BYY}' }), ctx(), 1)).toBe(
      '2569-69',
    );
  });

  it('ให้เดือนและวันสองหลัก', () => {
    expect(
      formatRunNumber(
        fmt({ pattern: '{YYYY}{MM}{DD}' }),
        ctx({ at: new Date('2026-01-05T03:00:00Z') }),
        1,
      ),
    ).toBe('20260105');
  });

  it('ใช้ค่าจาก master data ที่ผู้เรียกส่งมา', () => {
    expect(
      formatRunNumber(
        fmt({ pattern: 'REQ-{M:ORG_UNIT}-{SEQ}' }),
        ctx({ master: { 'M:ORG_UNIT': 'IT' } }),
        3,
      ),
    ).toBe('REQ-IT-0003');
  });

  it('อ่าน token ออกมาได้ทุกตัวรวมทั้งที่มีเครื่องหมายทวิภาค', () => {
    expect(tokensIn('A{SEQ}B{M:ORG_UNIT}')).toEqual(['SEQ', 'M:ORG_UNIT']);
  });

  it('{TYPE} ใช้ได้เฉพาะเอกสารที่มีขอบเขตย่อยจริง', () => {
    const request = tokensFor('REQUEST').map((def) => def.token);
    const customer = tokensFor('CUSTOMER').map((def) => def.token);

    expect(request).toContain('TYPE');
    expect(customer).not.toContain('TYPE');
  });
});

/** เขตเวลาไทย — ของเดิมใช้ UTC ทำให้วันที่ 1 ตอนเช้าตกไปอยู่เดือนก่อน. */
describe('คีย์ของช่วงรีเซ็ต', () => {
  it('ไม่รีเซ็ตคือคีย์เดียวตลอด', () => {
    expect(periodKeyOf('none', new Date('2026-09-22T03:00:00Z'))).toBe('-');
  });

  it('รายปี รายเดือน รายวัน ให้คีย์ตามช่วง', () => {
    const at = new Date('2026-09-22T03:00:00Z');

    expect(periodKeyOf('yearly', at)).toBe('2026');
    expect(periodKeyOf('monthly', at)).toBe('202609');
    expect(periodKeyOf('daily', at)).toBe('20260922');
  });

  it('เปลี่ยนคีย์เมื่อข้ามเดือน ซึ่งคือกลไกที่ทำให้ลำดับรีเซ็ตเอง', () => {
    const dec = periodKeyOf('monthly', new Date('2026-12-31T16:59:00Z'));
    const jan = periodKeyOf('monthly', new Date('2026-12-31T17:00:01Z'));

    expect(dec).toBe('202612');
    expect(jan).toBe('202701');
  });

  it('ตัดวันตามเวลาไทย ไม่ใช่ UTC', () => {
    // 02:00 ของวันที่ 1 ต.ค. ตามเวลาไทย = 19:00 ของวันที่ 30 ก.ย. UTC
    const at = new Date('2026-09-30T19:00:00Z');

    expect(periodKeyOf('monthly', at)).toBe('202610');
    expect(periodKeyOf('daily', at)).toBe('20261001');
  });
});

describe('ตรวจรูปแบบตอนบันทึก', () => {
  function check(
    overrides: Partial<Parameters<typeof validatePattern>[0]> = {},
  ) {
    return validatePattern({
      pattern: 'REQ-{COMPANY_PREFIX}-{SEQ}',
      docType: 'REQUEST',
      resetPeriod: 'none',
      seqPadding: 4,
      ...overrides,
    });
  }

  it('ผ่านเมื่อรูปแบบครบ', () => {
    expect(check()).toEqual([]);
  });

  it('ปฏิเสธรูปแบบที่ไม่มี {SEQ}', () => {
    expect(check({ pattern: 'REQ-{BYY}' }).join(' ')).toContain('{SEQ}');
  });

  it('ปฏิเสธ {SEQ} ซ้ำสองครั้ง', () => {
    expect(check({ pattern: '{SEQ}-{SEQ}' }).join(' ')).toContain(
      'ได้ครั้งเดียว',
    );
  });

  it('ปฏิเสธตัวแปรที่ไม่ได้ประกาศไว้', () => {
    expect(check({ pattern: '{SEQ}{NOPE}' }).join(' ')).toContain('{NOPE}');
  });

  it('ปฏิเสธ master token ของเอกสารชนิดอื่น', () => {
    expect(
      check({ pattern: '{SEQ}{M:SEGMENT}', docType: 'REQUEST' }).join(' '),
    ).toContain('M:SEGMENT');
  });

  it('ปฏิเสธรีเซ็ตรายเดือนที่รูปแบบไม่มีปีและเดือน', () => {
    const reasons = check({ pattern: '{SEQ}', resetPeriod: 'monthly' });

    expect(reasons.join(' ')).toContain('ปี');
    expect(reasons.join(' ')).toContain('เดือน');
  });

  it('ยอมรับรีเซ็ตรายเดือนเมื่อมี token รวมอย่าง {YYMM}', () => {
    expect(check({ pattern: '{YYMM}{SEQ}', resetPeriod: 'monthly' })).toEqual(
      [],
    );
  });

  it('ปฏิเสธรีเซ็ตรายวันที่มีแค่ปีเดือน', () => {
    expect(
      check({ pattern: '{YYMM}{SEQ}', resetPeriod: 'daily' }).join(' '),
    ).toContain('วัน');
  });

  it('ปฏิเสธความยาวลำดับที่อยู่นอกช่วง', () => {
    expect(check({ seqPadding: 0 }).join(' ')).toContain('1 ถึง 12');
    expect(check({ seqPadding: 13 }).join(' ')).toContain('1 ถึง 12');
  });

  it('ปฏิเสธรูปแบบที่ออกเลขยาวเกินคอลัมน์', () => {
    expect(check({ pattern: `${'X'.repeat(60)}{SEQ}` }).join(' ')).toContain(
      'เกินที่เก็บได้',
    );
  });
});

describe('ตัวแปรที่ผู้เรียกลืมส่งมา', () => {
  it('รายงาน master token ที่ไม่มีค่า', () => {
    expect(unresolvedTokens('REQ-{M:ORG_UNIT}-{SEQ}', ctx())).toEqual([
      'M:ORG_UNIT',
    ]);
  });

  it('ไม่รายงานเมื่อส่งมาครบ', () => {
    expect(
      unresolvedTokens(
        'REQ-{M:ORG_UNIT}-{SEQ}',
        ctx({ master: { 'M:ORG_UNIT': 'IT' } }),
      ),
    ).toEqual([]);
  });

  it('นับค่าว่างเป็นไม่มีค่า', () => {
    expect(
      unresolvedTokens('{COMPANY_PREFIX}{SEQ}', ctx({ companyPrefix: '' })),
    ).toEqual(['COMPANY_PREFIX']);
  });
});

/** ยกมาจาก crm/doc-code.spec.ts — ตัวเดียวที่ไม่ผูกกับ service ที่ถูกลบ. */
describe('ข้ามรหัสที่บริษัทอื่นถือไปแล้ว', () => {
  it('คืนรหัสตัวแรกที่ว่าง', async () => {
    let seq = 0;
    const taken = new Set(['CUS-OSD-000001', 'CUS-OSD-000002']);

    await expect(
      firstFreeCode(
        'customer code counter',
        () => Promise.resolve(`CUS-OSD-${String(++seq).padStart(6, '0')}`),
        (code) => Promise.resolve(taken.has(code)),
      ),
    ).resolves.toBe('CUS-OSD-000003');
  });

  it('เลิกพยายามหลัง MAX_TAKEN_SKIPS ไม่วนไม่จบ', async () => {
    const next = jest.fn(() => Promise.resolve('X'));

    await expect(
      firstFreeCode('test counter', next, () => Promise.resolve(true)),
    ).rejects.toThrow('test counter is behind');
    expect(next).toHaveBeenCalledTimes(MAX_TAKEN_SKIPS);
  });
});
