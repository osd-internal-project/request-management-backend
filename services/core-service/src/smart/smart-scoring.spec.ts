import { scoreProspect } from './smart-scoring';

const empty = {
  taxId: null,
  phone: null,
  email: null,
  website: null,
  industry: null,
  province: null,
  registeredCapital: null,
};

describe('CD-290 readiness score', () => {
  it('nothing known scores zero', () => {
    expect(scoreProspect(empty, {}, 'none')).toEqual({ score: 0, reasons: [] });
  });

  it('each rule adds its points and says why', () => {
    const result = scoreProspect(
      {
        ...empty,
        taxId: '0105551234567',
        phone: '021234567',
        registeredCapital: 20_000_000,
        industry: 'ผลิตชิ้นส่วนยานยนต์',
        province: 'ระยอง',
      },
      { keywords: ['ยานยนต์'], provinces: ['ชลบุรี', 'ระยอง'] },
      'none',
    );
    expect(result.score).toBe(80);
    expect(result.reasons.map((r) => r.points)).toEqual([20, 15, 15, 15, 15]);
  });

  it('an open Lead already in CRM pulls the score down; never below zero', () => {
    expect(
      scoreProspect({ ...empty, phone: '021234567' }, {}, 'lead').score,
    ).toBe(0);
  });

  it('an existing customer is flagged for Keeper without changing the number', () => {
    const result = scoreProspect(
      { ...empty, taxId: '0105551234567' },
      {},
      'customer',
    );
    expect(result.score).toBe(20);
    expect(result.reasons.at(-1)?.label).toContain('Keeper');
  });

  it('caps at 100', () => {
    const result = scoreProspect(
      {
        taxId: '0105551234567',
        phone: '021234567',
        email: 'a@b.co',
        website: 'https://b.co',
        industry: 'โรงงาน',
        province: 'ระยอง',
        registeredCapital: 100_000_000,
      },
      { keywords: ['โรงงาน'], provinces: ['ระยอง'] },
      'none',
    );
    expect(result.score).toBe(100);
  });
});
