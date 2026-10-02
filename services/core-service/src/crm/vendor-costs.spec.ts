import {
  ageInDays,
  bestVendorCost,
  costIsStale,
  thaiToday,
  vendorCostSource,
  type VendorCostRow,
} from './vendor-costs';

const row = (patch: Partial<VendorCostRow>): VendorCostRow => ({
  productCode: 'IP-PHONE',
  vendorCode: 'V1',
  vendorName: 'ผู้ขาย 1',
  source: 'purchase_order',
  unitCost: 2000,
  currency: 'THB',
  docNo: '1001',
  costDate: '2026-09-01',
  validTo: null,
  ...patch,
});

describe('CD-206 ต้นทุนคู่ค้า', () => {
  it('วันที่ล่าสุดชนะ; วันเดียวกันราคาพิเศษก่อนใบสั่งซื้อ; สกุลเงินต้องตรง', () => {
    const today = '2026-10-02';
    expect(
      bestVendorCost(
        [
          row({ costDate: '2026-08-01', unitCost: 1900 }),
          row({ vendorCode: 'V2', costDate: '2026-09-15', unitCost: 2100 }),
          row({ vendorCode: 'V3', costDate: '2026-09-20', currency: 'USD' }),
        ],
        'THB',
        today,
      )?.unitCost,
    ).toBe(2100);
    expect(
      bestVendorCost(
        [
          row({ costDate: '2026-09-15', unitCost: 2100 }),
          row({
            source: 'special_price',
            docNo: null,
            costDate: '2026-09-15',
            unitCost: 1950,
          }),
        ],
        'THB',
        today,
      )?.unitCost,
    ).toBe(1950);
  });

  it('ราคาพิเศษที่หมดอายุแล้ว และต้นทุนวันที่ในอนาคต ไม่นับ', () => {
    expect(
      bestVendorCost(
        [
          row({
            source: 'special_price',
            validTo: '2026-09-30',
            costDate: '2026-09-01',
          }),
          row({ costDate: '2026-10-05' }),
        ],
        'THB',
        '2026-10-02',
      ),
    ).toBeNull();
  });

  it('เก่ากว่าเกณฑ์ = เตือน', () => {
    expect(ageInDays('2026-07-04', '2026-10-02')).toBe(90);
    expect(costIsStale('2026-07-04', 90, '2026-10-02')).toBe(false);
    expect(costIsStale('2026-07-03', 90, '2026-10-02')).toBe(true);
  });

  it('วันนี้ตามเวลาไทย และที่มาของต้นทุน', () => {
    expect(thaiToday(new Date('2026-10-01T18:00:00Z'))).toBe('2026-10-02');
    expect(vendorCostSource(row({}))).toBe('SAP: ใบสั่งซื้อ 1001 · ผู้ขาย 1');
    expect(
      vendorCostSource(row({ source: 'special_price', docNo: null })),
    ).toBe('SAP: ราคาพิเศษผู้ขาย · ผู้ขาย 1');
  });
});
