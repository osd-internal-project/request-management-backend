import {
  configProblems,
  matchesSearch,
  openSecret,
  sealSecret,
} from './config-rules';

describe('CD-217 configuration rules', () => {
  const base = {
    system: 'Core switch',
    key: 'mgmt_ip',
    value: '10.0.0.1',
    isSecret: false,
    keepSecret: false,
    reason: '',
    needsReason: false,
  };

  it('a value has a system, a key and a value; a change has a reason', () => {
    expect(configProblems(base)).toEqual([]);
    expect(
      configProblems({ ...base, system: ' ', key: '', value: '' }),
    ).toHaveLength(3);
    expect(configProblems({ ...base, needsReason: true })).toEqual([
      'ต้องระบุเหตุผลที่เปลี่ยน',
    ]);
    // a secret edited without a new value keeps the old one
    expect(
      configProblems({
        ...base,
        value: '',
        isSecret: true,
        keepSecret: true,
      }),
    ).toEqual([]);
  });

  it('a secret is sealed, differently each time, and opens only with its key', () => {
    const a = sealSecret('P@ssw0rd', 'k1');
    const b = sealSecret('P@ssw0rd', 'k1');
    expect(a).not.toBe(b);
    expect(a).not.toContain('P@ssw0rd');
    expect(openSecret(a, 'k1')).toBe('P@ssw0rd');
    expect(openSecret(a, 'k2')).toBeNull();
    expect(openSecret('garbage', 'k1')).toBeNull();
  });

  it('a search matches system, key, value and note — never a secret', () => {
    const row = {
      system: 'Core switch',
      key: 'mgmt_ip',
      value: '10.0.0.1',
      note: null,
    };
    expect(matchesSearch(row, '10.0.0')).toBe(true);
    expect(matchesSearch(row, 'CORE')).toBe(true);
    expect(matchesSearch(row, 'firewall')).toBe(false);
    expect(
      matchesSearch({ ...row, key: 'admin_password', value: null }, 'P@ss'),
    ).toBe(false);
  });
});
