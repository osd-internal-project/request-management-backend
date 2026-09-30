import {
  cleanProfile,
  expiryCounts,
  expiryState,
  readBrands,
  readCertifications,
} from './partner-rules';

describe('partner rules (CD-142)', () => {
  it('cleanProfile drops blank rows, trims, accepts expires_on from the form', () => {
    const result = cleanProfile({
      summary: '  ติดตั้ง SD-WAN ได้ทั่วประเทศ ',
      brands: [
        { brand: ' Fortinet ', level: 'Gold', expires_on: '2027-03-31' },
        { brand: '', level: 'ว่าง' },
      ],
      certifications: [{ name: 'NSE 7', holders: 3 }, { name: '  ' }],
      contacts: [
        { name: 'คุณบี', role: 'ซัพพอร์ต', phone: '081', email: 'b@x.co' },
        { name: '' },
      ],
    });
    expect(result).toEqual({
      ok: true,
      summary: 'ติดตั้ง SD-WAN ได้ทั่วประเทศ',
      brands: [{ brand: 'Fortinet', level: 'Gold', expiresOn: '2027-03-31' }],
      certifications: [{ name: 'NSE 7', holders: 3, expiresOn: '' }],
      contacts: [
        { name: 'คุณบี', role: 'ซัพพอร์ต', phone: '081', email: 'b@x.co' },
      ],
    });
  });

  it('cleanProfile rejects a bad date or e-mail instead of dropping the row', () => {
    const result = cleanProfile({
      brands: [{ brand: 'Cisco', expires_on: '31/03/2027' }],
      contacts: [{ name: 'คุณซี', email: 'not-an-email' }],
    });
    expect(result).toEqual({
      ok: false,
      problems: [
        { field: 'brands[0].expires_on', reason: 'invalid_date' },
        { field: 'contacts[0].email', reason: 'invalid_email' },
      ],
    });
  });

  it('expiryState: none / expired / expiring within 60 days / valid', () => {
    expect(expiryState('', '2026-09-30')).toBe('none');
    expect(expiryState('2026-09-29', '2026-09-30')).toBe('expired');
    expect(expiryState('2026-09-30', '2026-09-30')).toBe('expiring');
    expect(expiryState('2026-11-29', '2026-09-30')).toBe('expiring');
    expect(expiryState('2026-11-30', '2026-09-30')).toBe('valid');
  });

  it('expiryCounts counts levels and certificates together', () => {
    expect(
      expiryCounts(
        {
          brands: [
            { brand: 'A', expiresOn: '2026-01-01' },
            { brand: 'B', expiresOn: '2026-10-15' },
          ],
          certifications: [{ name: 'C', expiresOn: '2030-01-01' }],
        },
        '2026-09-30',
      ),
    ).toEqual({ expired: 1, expiring: 1 });
  });

  it('reads stored JSON defensively', () => {
    expect(readBrands('x')).toEqual([]);
    expect(readBrands([null, { brand: 'A', expiresOn: 'bad' }])).toEqual([
      { brand: 'A', level: '', expiresOn: '' },
    ]);
    expect(readCertifications([{ name: 'N', holders: 0 }])).toEqual([
      { name: 'N', holders: 1, expiresOn: '' },
    ]);
  });
});
