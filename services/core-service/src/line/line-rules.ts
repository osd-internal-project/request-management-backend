import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a user has between pressing "ผูก LINE" and coming back. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface LinkState {
  userId: string;
  companyId: string;
}

export type StateResult =
  | ({ ok: true } & LinkState)
  | { ok: false; reason: 'STATE_INVALID' | 'STATE_EXPIRED' };

interface StateBody {
  u: string;
  c: string;
  n: string;
  e: number;
}

function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** The OAuth `state`: who is linking which company, signed so the public callback can trust it. */
export function signState(
  link: LinkState,
  secret: string,
  now = Date.now(),
): string {
  const body: StateBody = {
    u: link.userId,
    c: link.companyId,
    n: randomBytes(8).toString('base64url'),
    e: now + STATE_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${encoded}.${mac(encoded, secret)}`;
}

export function readState(
  state: string,
  secret: string,
  now = Date.now(),
): StateResult {
  const [encoded, signature, extra] = state.split('.');
  if (!encoded || !signature || extra !== undefined) {
    return { ok: false, reason: 'STATE_INVALID' };
  }
  const expected = Buffer.from(mac(encoded, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'STATE_INVALID' };
  }
  let body: Partial<StateBody>;
  try {
    body = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as Partial<StateBody>;
  } catch {
    return { ok: false, reason: 'STATE_INVALID' };
  }
  if (
    typeof body.u !== 'string' ||
    typeof body.c !== 'string' ||
    typeof body.e !== 'number'
  ) {
    return { ok: false, reason: 'STATE_INVALID' };
  }
  if (body.e < now) return { ok: false, reason: 'STATE_EXPIRED' };
  return { ok: true, userId: body.u, companyId: body.c };
}

export function callbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/public/line/callback`;
}

/** LINE Login authorize URL; `bot_prompt=aggressive` asks to add the company's OA on the same screen. */
export function authorizeUrl(input: {
  channelId: string;
  redirectUri: string;
  state: string;
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: input.channelId,
    redirect_uri: input.redirectUri,
    state: input.state,
    scope: 'openid profile',
    bot_prompt: 'aggressive',
  });
  return `https://access.line.me/oauth2/v2.1/authorize?${query.toString()}`;
}
