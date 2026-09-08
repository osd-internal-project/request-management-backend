import {
  isValidThaiTaxId,
  nameSimilarity,
  normalizeCustomerName,
} from './customer-name';

describe('CM-03 normalizeCustomerName', () => {
  it('strips Thai legal forms wherever they sit', () => {
    expect(normalizeCustomerName('บริษัท กขค เทรดดิ้ง จำกัด')).toBe(
      'กขคเทรดดิ้ง',
    );
    expect(normalizeCustomerName('บจก.กขค เทรดดิ้ง')).toBe('กขคเทรดดิ้ง');
    expect(normalizeCustomerName('บมจ. กขค เทรดดิ้ง')).toBe('กขคเทรดดิ้ง');
    expect(normalizeCustomerName('หจก. กขค เทรดดิ้ง')).toBe('กขคเทรดดิ้ง');
  });

  it('the long partnership form does not leave จำกัด behind', () => {
    expect(normalizeCustomerName('ห้างหุ้นส่วนจำกัด กขค')).toBe('กขค');
  });

  it('strips มหาชน closers', () => {
    expect(normalizeCustomerName('บริษัท กขค จำกัด (มหาชน)')).toBe('กขค');
  });

  it('strips English forms and case', () => {
    expect(normalizeCustomerName('ABC Trading Co., Ltd.')).toBe('abctrading');
    expect(normalizeCustomerName('ABC TRADING LIMITED')).toBe('abctrading');
  });

  it('removes spaces and punctuation so spacing cannot defeat the check', () => {
    expect(normalizeCustomerName('ก ข ค  เทรดดิ้ง')).toBe(
      normalizeCustomerName('กขคเทรดดิ้ง'),
    );
  });
});

describe('CM-03 nameSimilarity', () => {
  it('identical normalized names score 1', () => {
    expect(nameSimilarity('กขคเทรดดิ้ง', 'กขคเทรดดิ้ง')).toBe(1);
  });

  it('unrelated names score low', () => {
    expect(nameSimilarity('กขคเทรดดิ้ง', 'สยามอุตสาหกรรม')).toBeLessThan(0.2);
  });

  it('near-identical names score above the default 0.85 threshold', () => {
    const a = normalizeCustomerName('บริษัท กขค เทรดดิ้ง จำกัด');
    const b = normalizeCustomerName('บจก. กขค เทรดดิ้งส์');

    expect(nameSimilarity(a, b)).toBeGreaterThan(0.85);
  });

  it('is symmetric', () => {
    expect(nameSimilarity('abcdef', 'abcxyz')).toBe(
      nameSimilarity('abcxyz', 'abcdef'),
    );
  });

  it('handles empty and single-character inputs without dividing by zero', () => {
    expect(nameSimilarity('', '')).toBe(0);
    expect(nameSimilarity('ก', 'ก')).toBe(1);
    expect(nameSimilarity('ก', 'ข')).toBe(0);
  });
});

describe('CM-01 isValidThaiTaxId', () => {
  it('accepts a checksum-correct 13-digit id', () => {
    // 1234567890121: weighted sum 352, 352 mod 11 = 0, (11-0) mod 10 = 1.
    expect(isValidThaiTaxId('1234567890121')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidThaiTaxId('1234567890120')).toBe(false);
  });

  it('rejects non-13-digit shapes', () => {
    expect(isValidThaiTaxId('123456789012')).toBe(false);
    expect(isValidThaiTaxId('12345678901211')).toBe(false);
    expect(isValidThaiTaxId('123456789012a')).toBe(false);
    expect(isValidThaiTaxId('')).toBe(false);
  });
});
