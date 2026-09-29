import { createHmac } from 'crypto';

/**
 * Metabase static ("signed") embedding, CD-92.
 *
 * A dashboard marked embeddable renders at
 * `{site}/embed/dashboard/{jwt}#...` for anyone holding a JWT signed with the
 * instance's embedding secret. The app signs one only after PolicyGuard has
 * already said yes — so the ระบบ login/RBAC decides who sees BI, and nobody
 * gets a second Metabase login.
 *
 * The token is plain HS256 over the payload Metabase specifies; done with
 * node's crypto directly rather than a JWT dependency, because this is the
 * only place in the codebase that would use one.
 */

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

/**
 * `params` are the dashboard's locked parameters (CD-92: `company`). Metabase
 * applies them and hides them — the viewer cannot change a locked value, and
 * a token naming a parameter the dashboard does not lock is rejected.
 */
export function signMetabaseToken(
  secret: string,
  dashboardId: number,
  expiresInSeconds = 600,
  params: Record<string, string> = {},
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      resource: { dashboard: dashboardId },
      params,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function embedDashboardUrl(
  siteUrl: string,
  secret: string,
  dashboardId: number,
  params: Record<string, string> = {},
): string {
  const token = signMetabaseToken(secret, dashboardId, 600, params);
  return `${siteUrl.replace(/\/$/, '')}/embed/dashboard/${token}#bordered=false&titled=true`;
}
