import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { keyringFromEnv } from '@request-management/share';
import {
  configProblems,
  matchesSearch,
  openSecret,
  sealSecret,
  sealedUnderActive,
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
    const k1 = keyringFromEnv({ CONFIG_SECRET_KEY: 'k1' });
    const a = sealSecret('P@ssw0rd', k1);
    const b = sealSecret('P@ssw0rd', k1);
    expect(a).not.toBe(b);
    expect(a).not.toContain('P@ssw0rd');
    expect(a.startsWith('v2:k1:')).toBe(true);
    expect(openSecret(a, k1)).toBe('P@ssw0rd');
    expect(
      openSecret(a, keyringFromEnv({ CONFIG_SECRET_KEY: 'k2' })),
    ).toBeNull();
    expect(openSecret('garbage', k1)).toBeNull();
  });

  it('P8 — a value sealed before key ids (v1) still opens with the old key', () => {
    const legacy = createLegacySeal('P@ssw0rd', 'old-secret');
    expect(
      openSecret(legacy, keyringFromEnv({ CONFIG_SECRET_KEY: 'old-secret' })),
    ).toBe('P@ssw0rd');
  });

  it('P8 — rotating: the new key seals, the retired kid still opens until resealed', () => {
    const before = keyringFromEnv({ CONFIG_SECRET_KEY: 'old-secret' });
    const sealedOld = sealSecret('v', before);
    const after = keyringFromEnv({
      CONFIG_SECRET_KEYS: 'k2:new-secret,k1:old-secret',
      CONFIG_SECRET_ACTIVE: 'k2',
    });
    expect(openSecret(sealedOld, after)).toBe('v');
    expect(sealedUnderActive(sealedOld, after)).toBe(false);
    const resealed = sealSecret('v', after);
    expect(resealed.startsWith('v2:k2:')).toBe(true);
    expect(sealedUnderActive(resealed, after)).toBe(true);
    // k1 gone from the ring: what it sealed no longer opens.
    expect(
      openSecret(
        sealedOld,
        keyringFromEnv({ CONFIG_SECRET_KEYS: 'k2:new-secret' }),
      ),
    ).toBeNull();
  });

  it('P8 — production refuses to start without a key', () => {
    expect(() => keyringFromEnv({ NODE_ENV: 'production' })).toThrow(
      /CONFIG_SECRET_KEY/,
    );
    expect(keyringFromEnv({ NODE_ENV: 'test' }).active).toBe('dev');
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

/** The pre-P8 format (`iv.tag.body`, no key id), written the way the old code did. */
function createLegacySeal(value: string, secret: string): string {
  const key = createHash('sha256').update(`project-config:${secret}`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body]
    .map((p) => p.toString('base64url'))
    .join('.');
}
