/**
 * The verified API key's `scopes`, forwarded from core to user-service so a
 * machine's permissions have one source (`api_keys`) in every service.
 * user-service honours it only on the integration client's own token.
 */
export const API_KEY_SCOPES_HEADER = 'x-api-key-scopes';

export function encodeKeyScopes(scopes: readonly string[]): string {
  return [...new Set(scopes)].sort().join(',');
}

export function decodeKeyScopes(header: unknown): string[] {
  if (typeof header !== 'string' || !header) return [];
  return header
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean);
}
