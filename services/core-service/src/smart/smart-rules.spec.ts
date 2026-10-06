import {
  axisFor,
  cleanProspect,
  isDue,
  normalizePhone,
  normalizeTaxId,
} from './smart-rules';

describe('CD-289 AI SMART rules', () => {
  it('a tax id is 13 digits, separators dropped', () => {
    expect(normalizeTaxId('0-1055-51234-56-7')).toBe('0105551234567');
    expect(normalizeTaxId('12345')).toBeNull();
    expect(normalizeTaxId(null)).toBeNull();
  });

  it('a phone is dialable digits, +66 becomes 0', () => {
    expect(normalizePhone('+66 81-234-5678')).toBe('0812345678');
    expect(normalizePhone('02 123 4567')).toBe('021234567');
    expect(normalizePhone('1234')).toBeNull();
  });

  it('the axis: the row’s, else the source’s, else government by name, else getter', () => {
    expect(axisFor('บริษัท ก จำกัด', 'partner', 'getter')).toBe('partner');
    expect(axisFor('บริษัท ก จำกัด', 'nonsense', 'keeper')).toBe('keeper');
    expect(axisFor('กรมสรรพากร', null, null)).toBe('government');
    expect(axisFor('เทศบาลนครเชียงใหม่', undefined, null)).toBe('government');
    expect(axisFor('บริษัท ก จำกัด', null, null)).toBe('getter');
  });

  it('a row needs a name and something to tell it apart', () => {
    expect(cleanProspect({ taxId: '0105551234567' }, null)).toEqual({
      ok: false,
      reason: 'ไม่มีชื่อธุรกิจ',
    });
    expect(cleanProspect({ name: 'บริษัท ก' }, null)).toMatchObject({
      ok: false,
    });
    const kept = cleanProspect(
      {
        name: '  บริษัท   ก  จำกัด ',
        taxId: '0105551234567',
        email: 'NOT-AN-EMAIL',
        registeredCapital: '5000000',
      },
      'getter',
    );
    expect(kept.ok).toBe(true);
    expect(kept.ok && kept.row).toMatchObject({
      name: 'บริษัท ก จำกัด',
      externalRef: '0105551234567',
      email: null,
      registeredCapital: 5000000,
      salesAxis: 'getter',
    });
  });

  it('a scheduled source is due once its interval has passed', () => {
    const now = new Date('2026-10-06T12:00:00Z');
    const base = { kind: 'dbd', active: true, intervalHours: 24 };
    expect(isDue({ ...base, lastRunAt: null }, now)).toBe(true);
    expect(
      isDue({ ...base, lastRunAt: new Date('2026-10-06T00:00:00Z') }, now),
    ).toBe(false);
    expect(
      isDue({ ...base, lastRunAt: new Date('2026-10-05T11:00:00Z') }, now),
    ).toBe(true);
    expect(isDue({ ...base, kind: 'push', lastRunAt: null }, now)).toBe(false);
    expect(isDue({ ...base, active: false, lastRunAt: null }, now)).toBe(false);
  });
});
