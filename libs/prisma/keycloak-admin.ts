/**
 * The one place a seeding script talks to the Keycloak Admin API.
 *
 * Extracted from `seed-uat-users.ts` when `import-osd-catalog.ts` needed the
 * same four calls. A second copy would have been a second place for the admin
 * token to leak from, which the working rules forbid: *"The Keycloak admin
 * token never leaves `KeycloakAdminService`"* holds for the running services,
 * and these scripts keep the same shape — one module, one token, no callers
 * outside it.
 *
 * These helpers create accounts that a person can sign in with. Every caller
 * must go through `readKeycloakEnv`, which refuses to run in production and
 * refuses to run without an explicit opt-in.
 */
import { PrismaClient } from '@prisma/client';

export interface KeycloakEnv {
  readonly baseUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly password: string;
}

export interface KeycloakContext {
  readonly base: string;
  readonly headers: Record<string, string>;
  readonly password: string;
}

/**
 * Reads the realm settings, refusing rather than guessing.
 *
 * `allowVar` is the caller's own opt-in flag, so that "yes, create UAT
 * characters" and "yes, create 73 real employees" stay separate decisions —
 * granting one must never quietly grant the other.
 */
export function readKeycloakEnv(allowVar: string, howToRun: string): KeycloakEnv {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to create accounts in production.');
  }

  if (process.env[allowVar] !== '1') {
    throw new Error(
      `Refusing to run without ${allowVar}=1.\n` +
        'This creates real, sign-in-able accounts in the shared realm. Re-run as:\n' +
        `  ${howToRun}`,
    );
  }

  const baseUrl = process.env.KEYCLOAK_BASE_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  const password = process.env.UAT_DEFAULT_PASSWORD;

  if (!baseUrl || !realm || !clientId || !clientSecret) {
    throw new Error(
      'Missing Keycloak settings. KEYCLOAK_BASE_URL, KEYCLOAK_REALM,\n' +
        'KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET must all be set in .env.',
    );
  }

  // No default in code: a password baked into the repository would be a
  // credential in version control, and these accounts can sign in.
  if (!password) {
    throw new Error(
      'UAT_DEFAULT_PASSWORD is required — set it on the command line rather\n' +
        'than in .env, and use something that is not a real corporate password.',
    );
  }

  return { baseUrl, realm, clientId, clientSecret, password };
}

export async function adminToken(env: KeycloakEnv): Promise<string> {
  const response = await fetch(
    `${env.baseUrl}/realms/${env.realm}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: env.clientId,
        client_secret: env.clientSecret,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Could not get a service-account token (HTTP ${response.status}).\n` +
        `Check that "${env.clientId}" has Client authentication and Service accounts enabled.`,
    );
  }

  const body = (await response.json()) as { access_token: string };
  return body.access_token;
}

export async function connect(env: KeycloakEnv): Promise<KeycloakContext> {
  const token = await adminToken(env);

  return {
    base: `${env.baseUrl}/admin/realms/${env.realm}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    password: env.password,
  };
}

export async function findByUsername(
  keycloak: KeycloakContext,
  username: string,
): Promise<string | null> {
  const response = await fetch(
    `${keycloak.base}/users?username=${encodeURIComponent(username)}&exact=true`,
    { headers: keycloak.headers },
  );

  if (!response.ok) {
    throw new Error(
      `Could not search the realm for "${username}" (HTTP ${response.status}).`,
    );
  }

  const found = (await response.json()) as { id: string }[];
  return found[0]?.id ?? null;
}

export interface NewAccount {
  readonly username: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * Finds the account, creating it only when the realm does not have it.
 *
 * An account that already exists is reused and **its password is left alone** —
 * re-running this must never reset a password somebody has already changed.
 */
export async function ensureKeycloakUser(
  keycloak: KeycloakContext,
  account: NewAccount,
): Promise<{ id: string; created: boolean }> {
  const existing = await findByUsername(keycloak, account.username);
  if (existing) return { id: existing, created: false };

  const response = await fetch(`${keycloak.base}/users`, {
    method: 'POST',
    headers: keycloak.headers,
    body: JSON.stringify({
      username: account.username,
      email: account.email,
      firstName: account.firstName,
      lastName: account.lastName,
      enabled: true,
      emailVerified: true,
      credentials: [
        // Not temporary: a forced password change at first sign-in would stop
        // a UAT script and a business user alike before they reach a screen.
        { type: 'password', value: keycloak.password, temporary: false },
      ],
    }),
  });

  // 409 means someone created it between the lookup and now — fall through to
  // the second lookup rather than failing the whole run.
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `Could not create "${account.username}" (HTTP ${response.status}). ` +
        'The service account needs the realm-management role manage-users.',
    );
  }

  const id = await findByUsername(keycloak, account.username);
  if (!id) {
    throw new Error(
      `Created "${account.username}" but could not read it back from the realm.`,
    );
  }

  return { id, created: response.ok };
}

export async function grantRealmRole(
  keycloak: KeycloakContext,
  userId: string,
  roleName: string,
): Promise<void> {
  const response = await fetch(
    `${keycloak.base}/roles/${encodeURIComponent(roleName)}`,
    { headers: keycloak.headers },
  );

  if (!response.ok) {
    throw new Error(
      `Realm role "${roleName}" does not exist. Run \`yarn keycloak:provision\` first.`,
    );
  }

  const role = (await response.json()) as { id: string; name: string };

  const granted = await fetch(
    `${keycloak.base}/users/${userId}/role-mappings/realm`,
    {
      method: 'POST',
      headers: keycloak.headers,
      body: JSON.stringify([{ id: role.id, name: role.name }]),
    },
  );

  if (!granted.ok && granted.status !== 409) {
    throw new Error(
      `Could not grant "${roleName}" to ${userId} (HTTP ${granted.status}).`,
    );
  }
}

export interface LocalProfile {
  readonly username: string;
  readonly displayName: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly orgUnitId: string | null;
  /** Job title as HR records it; null when the register has none. */
  readonly position?: string | null;
  readonly keycloakRoles: readonly string[];
}

/**
 * Writes the local profile and its company membership.
 *
 * Matched on `keycloakId` rather than username, because that is the identity
 * the token carries and what `PrincipalService.provision` will match on at
 * first sign-in — matching on username instead would create a second row.
 */
export async function upsertProfile(
  prisma: PrismaClient,
  profile: LocalProfile,
  keycloakId: string,
  companyId: string,
): Promise<string> {
  const saved = await prisma.user.upsert({
    where: { keycloakId },
    update: {
      username: profile.username,
      displayName: profile.displayName,
      firstName: profile.firstName,
      lastName: profile.lastName,
      orgUnitId: profile.orgUnitId,
      ...(profile.position === undefined ? {} : { position: profile.position }),
      keycloakRoles: [...profile.keycloakRoles],
      primaryCompanyId: companyId,
    },
    // `email` is set on create only. A re-run must not overwrite an address
    // the person has since corrected in the realm.
    create: {
      keycloakId,
      username: profile.username,
      email: profile.email,
      displayName: profile.displayName,
      firstName: profile.firstName,
      lastName: profile.lastName,
      orgUnitId: profile.orgUnitId,
      position: profile.position ?? null,
      keycloakRoles: [...profile.keycloakRoles],
      primaryCompanyId: companyId,
    },
  });

  // AUTH-05: a user needs a company membership to have an active company to
  // resolve at sign-in.
  await prisma.userCompany.upsert({
    where: { userId_companyId: { userId: saved.id, companyId } },
    update: { isPrimary: true },
    create: { userId: saved.id, companyId, isPrimary: true },
  });

  return saved.id;
}

/**
 * Grants the system role matching the realm role.
 *
 * `MANUAL` so the placement works before the first sign-in — and survives it.
 * `replaceMappedRoles` rewrites only `KEYCLOAK_MAPPING` rows on every login, so
 * the mapped copy it adds later sits alongside this one harmlessly.
 */
export async function grantSystemRole(
  prisma: PrismaClient,
  userId: string,
  companyId: string,
  roleCode: string,
): Promise<void> {
  const role = await prisma.role.findUnique({
    where: { companyId_code: { companyId, code: roleCode } },
  });

  if (!role) {
    throw new Error(
      `No "${roleCode}" role in this company. Run \`yarn prisma:seed\` first.`,
    );
  }

  await prisma.userRole.upsert({
    where: {
      userId_roleId_companyId: { userId, roleId: role.id, companyId },
    },
    update: {},
    create: { userId, roleId: role.id, companyId, source: 'MANUAL' },
  });
}
