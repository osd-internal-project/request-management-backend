import { registerAs } from '@nestjs/config';

export default registerAs('keycloak', () => {
  const baseUrl = process.env.KEYCLOAK_BASE_URL ?? 'http://192.168.31.51:8180';
  const realm = process.env.KEYCLOAK_REALM ?? 'enterprise-request';
  const issuer = `${baseUrl}/realms/${realm}`;

  return {
    baseUrl,
    realm,
    clientId: process.env.KEYCLOAK_CLIENT_ID ?? 'request-form',
    clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? '',

    /**
     * Base of the Keycloak Admin REST API for this realm.
     *
     * The same confidential client is used for admin calls: it already has
     * service accounts enabled, so there is one client and one secret rather
     * than a second identity to keep in sync. Its service account needs the
     * `realm-management` roles `view-users`, `query-users`, `query-groups`,
     * `manage-users`, and `view-realm` — without them the Admin API answers
     * 403 while still issuing a perfectly valid token.
     */
    adminBaseUrl: `${baseUrl}/admin/realms/${realm}`,

    /**
     * Where Keycloak sends the browser back after login. Must be registered
     * as a valid redirect URI on the client, or Keycloak refuses the
     * authorization request outright (spec open question C).
     */
    redirectUri:
      process.env.KEYCLOAK_REDIRECT_URI ??
      'http://localhost:3000/api/auth/callback',
    /**
     * The frontend root, and deliberately nothing more.
     *
     * This used to be `/login?signed_out=1`, carrying a flag that stopped the
     * old login page bouncing a just-logged-out user back into a still-live
     * SSO session. That page no longer exists — the frontend has no login
     * screen at all — and the flag has nothing to stop: by the time the browser
     * arrives here Keycloak has already ended the session, so the frontend
     * sends it straight back to a real login prompt.
     *
     * The realm client must accept this URI. A wildcard entry
     * (`http://localhost:3000/*`) covers it; an exact-match list needs the root
     * added, or `KEYCLOAK_POST_LOGOUT_REDIRECT_URI` set.
     */
    postLogoutRedirectUri:
      process.env.KEYCLOAK_POST_LOGOUT_REDIRECT_URI ??
      'http://localhost:3000/',

    issuer,
    authorizeUrl: `${issuer}/protocol/openid-connect/auth`,
    tokenUrl: `${issuer}/protocol/openid-connect/token`,
    userInfoUrl: `${issuer}/protocol/openid-connect/userinfo`,
    logoutUrl: `${issuer}/protocol/openid-connect/logout`,
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
  };
});
