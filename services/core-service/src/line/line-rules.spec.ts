import {
  STATE_TTL_MS,
  authorizeUrl,
  callbackUrl,
  readState,
  signState,
} from './line-rules';

const SECRET = 'test-line-state';
const LINK = { userId: 'user-1', companyId: 'company-1' };

describe('LINE link state', () => {
  it('reads back who is linking which company', () => {
    const state = signState(LINK, SECRET, 1_000);
    expect(readState(state, SECRET, 1_000)).toEqual({ ok: true, ...LINK });
  });

  it('refuses a state signed with another secret', () => {
    const state = signState(LINK, 'other', 1_000);
    expect(readState(state, SECRET, 1_000)).toEqual({
      ok: false,
      reason: 'STATE_INVALID',
    });
  });

  it('refuses a state whose body was changed', () => {
    const [, signature] = signState(LINK, SECRET, 1_000).split('.');
    const forged = Buffer.from(
      JSON.stringify({ u: 'attacker', c: 'company-1', n: 'x', e: 99_999_999 }),
    ).toString('base64url');
    expect(readState(`${forged}.${signature}`, SECRET, 1_000)).toEqual({
      ok: false,
      reason: 'STATE_INVALID',
    });
  });

  it('refuses garbage', () => {
    for (const state of ['', 'abc', 'a.b.c', '.']) {
      expect(readState(state, SECRET).ok).toBe(false);
    }
  });

  it('expires after ten minutes', () => {
    const state = signState(LINK, SECRET, 1_000);
    expect(readState(state, SECRET, 1_000 + STATE_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'STATE_EXPIRED',
    });
  });
});

describe('LINE authorize URL', () => {
  it('carries the channel, callback, state and the OA add-friend prompt', () => {
    const url = new URL(
      authorizeUrl({
        channelId: '2001234567',
        redirectUri: callbackUrl('https://ctd.osd.co.th/'),
        state: 's.t',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://access.line.me/oauth2/v2.1/authorize',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: '2001234567',
      redirect_uri: 'https://ctd.osd.co.th/api/public/line/callback',
      state: 's.t',
      scope: 'openid profile',
      bot_prompt: 'aggressive',
    });
  });
});
