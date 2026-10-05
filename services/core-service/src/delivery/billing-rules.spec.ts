import {
  billingBlockers,
  installmentReference,
  retentionDue,
  type BillingFacts,
} from './billing-rules';

const base: BillingFacts = {
  kind: 'progress',
  today: '2026-10-05',
  contractSigned: true,
  hasCustomer: true,
  billed: null,
  milestone: { title: 'เฟส 1', status: 'achieved' },
  certificateSigned: true,
  openPoints: 0,
  exceptionApproved: false,
  milestonesOpen: 1,
  warrantyEnds: null,
};

describe('CD-253 billing gate', () => {
  it('reference ไม่ชนกับงานบริการ', () => {
    expect(installmentReference('CT-1', 2)).toBe('INS-CT-1-2');
  });

  it('งวดตามความคืบหน้าผ่านเมื่อหมุดหมายบรรลุ + ใบรับรองลงนาม + ไม่มีรายการค้าง', () => {
    expect(billingBlockers(base)).toEqual({
      blockers: [],
      exceptionable: false,
    });
  });

  it('ยังไม่ตรวจรับ / ใบรับรองไม่ลงนาม / วางบิลซ้ำ', () => {
    const r = billingBlockers({
      ...base,
      billed: 'here',
      milestone: { title: 'เฟส 1', status: 'planned' },
      certificateSigned: false,
    });
    expect(r.blockers).toEqual([
      'งวดนี้ส่งวางบิลแล้ว',
      'หมุดหมาย "เฟส 1" ยังไม่บรรลุ',
      'ใบรับรองการตรวจรับของเฟสนี้ยังไม่ได้ลงนาม',
    ]);
  });

  it('รายการค้างอย่างเดียว = ขอยกเว้นได้; อนุมัติแล้วผ่าน', () => {
    expect(billingBlockers({ ...base, openPoints: 2 })).toEqual({
      blockers: ['รายการค้างจากการรับมอบมีเงื่อนไขยังไม่ปิด 2 ข้อ'],
      exceptionable: true,
    });
    expect(
      billingBlockers({ ...base, openPoints: 2, exceptionApproved: true })
        .blockers,
    ).toEqual([]);
  });

  it('งวดสุดท้ายต้องครบทุกหมุดหมาย; มัดจำต้องลงนามสัญญา; คืนเงินประกันต้องพ้นประกัน', () => {
    expect(billingBlockers({ ...base, kind: 'final' }).blockers).toHaveLength(
      1,
    );
    expect(
      billingBlockers({ ...base, kind: 'final', milestonesOpen: 0 }).blockers,
    ).toEqual([]);
    expect(
      billingBlockers({ ...base, kind: 'deposit', contractSigned: false })
        .blockers,
    ).toEqual(['สัญญายังไม่ได้ลงนามครบทั้งสองฝ่าย']);
    expect(
      billingBlockers({
        ...base,
        kind: 'retention',
        warrantyEnds: '2026-12-31',
      }).blockers,
    ).toEqual(['ยังไม่พ้นระยะประกัน (สิ้นสุด 2026-12-31)']);
    expect(
      billingBlockers({
        ...base,
        kind: 'retention',
        warrantyEnds: '2026-10-04',
      }).blockers,
    ).toEqual([]);
  });

  it('เตือนคืนเงินประกันล่วงหน้า', () => {
    expect(retentionDue('2026-11-01', '2026-10-05', 30)).toBe(true);
    expect(retentionDue('2026-12-31', '2026-10-05', 30)).toBe(false);
    expect(retentionDue(null, '2026-10-05', 30)).toBe(false);
  });
});
