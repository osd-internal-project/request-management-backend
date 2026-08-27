import { createHmac } from 'crypto';
import { embedDashboardUrl, signMetabaseToken } from './metabase-embed';

describe('CD-92: Metabase signed embedding', () => {
  const SECRET = 'test-secret';

  it('signs the exact payload shape Metabase expects', () => {
    const token = signMetabaseToken(SECRET, 42, 600);
    const [header, payload, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'HS256',
      typ: 'JWT',
    });

    // Typed rather than left as `any`: the assertions below read three
    // specific fields, and naming them here is what makes a change to the
    // token shape fail at compile time instead of silently passing.
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      resource: unknown;
      params: unknown;
      exp: number;
    };
    expect(body.resource).toEqual({ dashboard: 42 });
    expect(body.params).toEqual({});
    expect(body.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(body.exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 600);

    const expected = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
  });

  it('a different secret yields a different signature — no unsigned access', () => {
    const [h1, p1, s1] = signMetabaseToken(SECRET, 7).split('.');
    const s2 = createHmac('sha256', 'other-secret')
      .update(`${h1}.${p1}`)
      .digest('base64url');
    expect(s1).not.toBe(s2);
  });

  it('builds the /embed/dashboard URL without a double slash', () => {
    const url = embedDashboardUrl('http://bi.local:3300/', SECRET, 3);
    expect(url).toMatch(
      /^http:\/\/bi\.local:3300\/embed\/dashboard\/[\w-]+\.[\w-]+\.[\w-]+#/,
    );
  });
});
