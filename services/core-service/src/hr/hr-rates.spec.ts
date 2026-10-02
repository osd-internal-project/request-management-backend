import { dayBefore, laborLabel, rateOn } from './hr-rates';

describe('CD-207 อัตราต้นทุนคน', () => {
  const rates = [
    {
      id: 'old',
      levelId: 'L',
      workTypeId: 'W',
      validFrom: '2026-01-01',
      validTo: '2026-06-30',
    },
    {
      id: 'now',
      levelId: 'L',
      workTypeId: 'W',
      validFrom: '2026-07-01',
      validTo: null,
    },
    {
      id: 'other',
      levelId: 'L',
      workTypeId: 'X',
      validFrom: '2026-01-01',
      validTo: null,
    },
  ];

  it('อัตราที่มีผลในวันนั้นของระดับ × ประเภทงาน', () => {
    expect(rateOn(rates, 'L', 'W', '2026-03-15')?.id).toBe('old');
    expect(rateOn(rates, 'L', 'W', '2026-10-02')?.id).toBe('now');
    expect(rateOn(rates, 'L', 'W', '2025-12-31')).toBeNull();
    expect(rateOn(rates, 'L', 'Y', '2026-10-02')).toBeNull();
  });

  it('วันก่อนหน้า และชื่อที่บรรทัดแรงงานแสดง', () => {
    expect(dayBefore('2026-03-01')).toBe('2026-02-28');
    expect(
      laborLabel({ code: 'SE-2', name: 'วิศวกรอาวุโส' }, { name: 'ติดตั้ง' }),
    ).toBe('SE-2 วิศวกรอาวุโส · ติดตั้ง');
  });
});
