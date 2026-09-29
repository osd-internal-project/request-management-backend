/**
 * Copies the old realm's people into the new one, adding only — never changing what is there.
 * `yarn kc:migrate [--dry-run|--apply|--check [username…]]`; old realm OLD_KEYCLOAK_*, new KEYCLOAK_*.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { connectAdmin, type KeycloakAdminContext } from './keycloak-admin';

/** Realm-level accounts left behind: UAT characters. */
const SKIP_PREFIX = 'uat.';
/** The one account renamed on the way, in both realms and in the app database. */
const RENAMES: Readonly<Record<string, string>> = { uatadmin: 'request-admin' };
/** Keycloak's own roles; every realm has its own copy already. */
const BUILT_IN_ROLES = ['offline_access', 'uma_authorization'];
const LDAP_PROVIDER = 'org.keycloak.storage.UserStorageProvider';
const LDAP_MAPPER = 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper';

interface KcUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  emailVerified?: boolean;
  federationLink?: string;
  attributes?: Record<string, string[]>;
}
interface KcRole {
  id: string;
  name: string;
  description?: string;
}
interface KcGroup {
  id: string;
  name: string;
}
interface KcComponent {
  id: string;
  name: string;
  providerId: string;
  providerType: string;
  parentId: string;
  config: Record<string, string[]>;
}

/** One old account and everything the new realm must give it. */
interface Person {
  readonly oldUsername: string;
  readonly username: string;
  readonly fromLdap: boolean;
  readonly user: KcUser;
  readonly roles: string[];
  readonly groups: string[];
}

type Mode = 'dry-run' | 'apply' | 'check';

async function api<T>(
  kc: KeycloakAdminContext,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${kc.base}${path}`, {
    ...init,
    headers: { ...kc.headers, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(
      `${init.method ?? 'GET'} ${path} → HTTP ${response.status} ${detail}`,
    );
  }
  const text = await response.text();
  // Keycloak admin API shapes, trusted as documented; nothing here re-validates them.
  return (text ? JSON.parse(text) : undefined) as T;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is not set (expected in ../.backend-env).`);
  return value;
}

function realmEnv(prefix: '' | 'OLD_') {
  return {
    baseUrl: requireEnv(`${prefix}KEYCLOAK_BASE_URL`).replace(/\/$/, ''),
    realm: requireEnv(`${prefix}KEYCLOAK_REALM`),
    clientId: requireEnv(`${prefix}KEYCLOAK_CLIENT_ID`),
    clientSecret: requireEnv(`${prefix}KEYCLOAK_CLIENT_SECRET`),
  };
}

async function findUser(
  kc: KeycloakAdminContext,
  username: string,
): Promise<KcUser | null> {
  const found = await api<KcUser[]>(
    kc,
    `/users?username=${encodeURIComponent(username)}&exact=true&briefRepresentation=false`,
  );
  return found.find((user) => user.username === username) ?? null;
}

/** The accounts in scope, with their realm roles and groups in the old realm. */
async function readOldPeople(old: KeycloakAdminContext): Promise<Person[]> {
  const users = await api<KcUser[]>(
    old,
    '/users?max=5000&briefRepresentation=false',
  );
  const people: Person[] = [];
  for (const user of users) {
    if (user.username.startsWith(SKIP_PREFIX)) continue;
    const roles = await api<KcRole[]>(
      old,
      `/users/${user.id}/role-mappings/realm`,
    );
    const groups = await api<KcGroup[]>(old, `/users/${user.id}/groups`);
    people.push({
      oldUsername: user.username,
      username: RENAMES[user.username] ?? user.username,
      fromLdap: Boolean(user.federationLink),
      user,
      roles: roles.map((role) => role.name).filter(isMigratableRole),
      groups: groups.map((group) => group.name),
    });
  }
  return people;
}

function isMigratableRole(name: string): boolean {
  return !BUILT_IN_ROLES.includes(name) && !name.startsWith('default-roles-');
}

interface Snapshot {
  readonly takenAt: string;
  readonly users: KcUser[];
  readonly roles: string[];
  readonly groups: string[];
  readonly providers: KcComponent[];
}

async function snapshot(kc: KeycloakAdminContext): Promise<Snapshot> {
  return {
    takenAt: new Date().toISOString(),
    users: await api<KcUser[]>(
      kc,
      '/users?max=100000&briefRepresentation=false',
    ),
    roles: (await api<KcRole[]>(kc, '/roles?max=1000')).map(
      (role) => role.name,
    ),
    groups: (await api<KcGroup[]>(kc, '/groups?max=1000')).map(
      (group) => group.name,
    ),
    providers: await api<KcComponent[]>(
      kc,
      `/components?type=${LDAP_PROVIDER}`,
    ),
  };
}

function saveSnapshot(label: string, data: unknown): string {
  const dir =
    process.env.KC_MIGRATE_SNAPSHOT_DIR ?? join(tmpdir(), 'kc-migrate');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** The new realm's provider for the same directory, if one already exists. */
function sameDirectory(
  oldLdap: KcComponent,
  providers: readonly KcComponent[],
): KcComponent | null {
  const key = (c: KcComponent) =>
    `${c.config.connectionUrl?.[0]}|${c.config.usersDn?.[0]}`.toLowerCase();
  return providers.find((provider) => key(provider) === key(oldLdap)) ?? null;
}

async function plan(old: KeycloakAdminContext, fresh: KeycloakAdminContext) {
  const people = await readOldPeople(old);
  const before = await snapshot(fresh);
  const existing = new Set(before.users.map((user) => user.username));
  const oldProviders = await api<KcComponent[]>(
    old,
    `/components?type=${LDAP_PROVIDER}`,
  );
  const neededRoles = [...new Set(people.flatMap((p) => p.roles))];
  const neededGroups = [...new Set(people.flatMap((p) => p.groups))];

  return {
    people,
    before,
    existing,
    oldLdap: oldProviders[0] ?? null,
    reusedLdap: oldProviders[0]
      ? sameDirectory(oldProviders[0], before.providers)
      : null,
    missingRoles: neededRoles.filter((name) => !before.roles.includes(name)),
    missingGroups: neededGroups.filter((name) => !before.groups.includes(name)),
    collisions: people
      .filter((p) => existing.has(p.username))
      .map((p) => p.username),
  };
}

type Plan = Awaited<ReturnType<typeof plan>>;

function printPlan(p: Plan): void {
  const local = p.people.filter((person) => !person.fromLdap);
  console.log(
    `Old accounts in scope: ${p.people.length} (LDAP ${p.people.length - local.length}, local ${local.length}; uat.* skipped)`,
  );
  console.log(`  local: ${local.map((person) => person.username).join(', ')}`);
  console.log(
    `New realm now: ${p.before.users.length} users, ${p.before.providers.length} user-storage provider(s)`,
  );
  console.log(`Roles to create: ${p.missingRoles.join(', ') || '(none)'}`);
  console.log(`Groups to create: ${p.missingGroups.join(', ') || '(none)'}`);
  console.log(
    p.reusedLdap
      ? `LDAP: new realm already federates this directory ("${p.reusedLdap.name}") — reused, not changed, not synced`
      : `LDAP: will create "${p.oldLdap?.name}" → ${p.oldLdap?.config.connectionUrl?.[0]} after a connection test`,
  );
  console.log(
    `Already in the new realm — will be left untouched: ${p.collisions.length}`,
  );
  for (const username of p.collisions) console.log(`  = ${username}`);
}

async function createRoles(
  fresh: KeycloakAdminContext,
  old: KeycloakAdminContext,
  names: readonly string[],
) {
  for (const name of names) {
    const source = await api<KcRole>(old, `/roles/${encodeURIComponent(name)}`);
    await api(fresh, '/roles', {
      method: 'POST',
      body: JSON.stringify({ name, description: source.description ?? '' }),
    });
    console.log(`  + role ${name}`);
  }
}

async function createGroups(
  fresh: KeycloakAdminContext,
  names: readonly string[],
) {
  for (const name of names) {
    await api(fresh, '/groups', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    console.log(`  + group ${name}`);
  }
}

/** Tests the bind first, so an unreachable directory leaves the new realm untouched. */
async function createLdap(
  fresh: KeycloakAdminContext,
  old: KeycloakAdminContext,
  oldLdap: KcComponent,
  realmId: string,
): Promise<string> {
  const bindCredential = requireEnv('NEW_LDAP_BIND_PASSWORD');
  const cfg = oldLdap.config;
  const first = (key: string) => cfg[key]?.[0] ?? '';
  await api(fresh, '/testLDAPConnection', {
    method: 'POST',
    body: JSON.stringify({
      action: 'testAuthentication',
      connectionUrl: first('connectionUrl'),
      authType: first('authType') || 'simple',
      bindDn: first('bindDn'),
      bindCredential,
      useTruststoreSpi: first('useTruststoreSpi') || 'always',
      connectionTimeout: first('connectionTimeout'),
      startTls: first('startTls'),
    }),
  });
  console.log(`  ✓ LDAP bind test passed (${first('connectionUrl')})`);

  await api(fresh, '/components', {
    method: 'POST',
    body: JSON.stringify({
      name: oldLdap.name,
      providerId: oldLdap.providerId,
      providerType: LDAP_PROVIDER,
      parentId: realmId,
      config: { ...cfg, bindCredential: [bindCredential] },
    }),
  });
  const created = (
    await api<KcComponent[]>(fresh, `/components?type=${LDAP_PROVIDER}`)
  ).find((c) => c.name === oldLdap.name);
  if (!created)
    throw new Error('LDAP provider was created but cannot be read back.');
  console.log(`  + LDAP provider ${oldLdap.name}`);

  await copyMissingMappers(fresh, old, oldLdap.id, created.id);
  return created.id;
}

/** Keycloak adds default mappers on create; only the old realm's extras are copied. */
async function copyMissingMappers(
  fresh: KeycloakAdminContext,
  old: KeycloakAdminContext,
  oldId: string,
  newId: string,
) {
  const have = new Set(
    (
      await api<KcComponent[]>(
        fresh,
        `/components?parent=${newId}&type=${LDAP_MAPPER}`,
      )
    ).map((m) => m.name),
  );
  for (const mapper of await api<KcComponent[]>(
    old,
    `/components?parent=${oldId}&type=${LDAP_MAPPER}`,
  )) {
    if (have.has(mapper.name)) continue;
    await api(fresh, '/components', {
      method: 'POST',
      body: JSON.stringify({ ...mapper, id: undefined, parentId: newId }),
    });
    console.log(`  + LDAP mapper ${mapper.name}`);
  }
}

async function createLocalUser(fresh: KeycloakAdminContext, person: Person) {
  const attributes = Object.fromEntries(
    Object.entries(person.user.attributes ?? {}).filter(
      ([key]) => !key.startsWith('LDAP_'),
    ),
  );
  await api(fresh, '/users', {
    method: 'POST',
    body: JSON.stringify({
      username: person.username,
      email: person.user.email,
      firstName: person.user.firstName,
      lastName: person.user.lastName,
      enabled: person.user.enabled,
      emailVerified: person.user.emailVerified ?? false,
      attributes,
      credentials: [
        {
          type: 'password',
          value: requireEnv('MIGRATION_TEMP_PASSWORD'),
          temporary: true,
        },
      ],
    }),
  });
  console.log(`  + user ${person.username} (local, temporary password)`);
}

/** Roles and groups for an account this run created or imported — never for one that was there. */
async function grantAccess(
  fresh: KeycloakAdminContext,
  person: Person,
  userId: string,
) {
  const roles = await Promise.all(
    person.roles.map((name) =>
      api<KcRole>(fresh, `/roles/${encodeURIComponent(name)}`),
    ),
  );
  if (roles.length) {
    await api(fresh, `/users/${userId}/role-mappings/realm`, {
      method: 'POST',
      body: JSON.stringify(roles.map(({ id, name }) => ({ id, name }))),
    });
  }
  const groups = await api<KcGroup[]>(fresh, '/groups?max=1000');
  for (const name of person.groups) {
    const group = groups.find((g) => g.name === name);
    if (group)
      await api(fresh, `/users/${userId}/groups/${group.id}`, {
        method: 'PUT',
      });
  }
}

/** The one change allowed in the old realm; refused realm settings are reported, not changed. */
async function renameInOldRealm(old: KeycloakAdminContext) {
  for (const [from, to] of Object.entries(RENAMES)) {
    const user = await findUser(old, from);
    if (!user) {
      console.log(`  old realm: "${from}" not found (already renamed?)`);
      continue;
    }
    try {
      await api(old, `/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...user, username: to }),
      });
      console.log(`  ~ old realm: ${from} → ${to}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`  ! old realm refused the rename: ${reason}`);
    }
  }
}

async function apply(
  p: Plan,
  old: KeycloakAdminContext,
  fresh: KeycloakAdminContext,
  realmId: string,
) {
  console.log(
    `Snapshot of the new realm before any change: ${saveSnapshot('before', p.before)}`,
  );
  if (p.oldLdap && !p.reusedLdap) {
    // First: an unreachable directory must stop the run before anything is added.
    const providerId = await createLdap(fresh, old, p.oldLdap, realmId);
    const result = await api<Record<string, number>>(
      fresh,
      `/user-storage/${providerId}/sync?action=triggerFullSync`,
      { method: 'POST' },
    );
    console.log(`  LDAP sync: ${JSON.stringify(result)}`);
  }
  await createRoles(fresh, old, p.missingRoles);
  await createGroups(fresh, p.missingGroups);

  for (const person of p.people) {
    if (p.existing.has(person.username)) continue;
    if (!person.fromLdap) await createLocalUser(fresh, person);
    const created = await findUser(fresh, person.username);
    if (!created) {
      console.log(
        `  ! ${person.username}: not in the new realm after sync/create`,
      );
      continue;
    }
    await grantAccess(fresh, person, created.id);
  }
  await renameInOldRealm(old);
}

/** Read-only: per username, is it there, enabled, with the old roles and groups? */
async function check(
  p: Plan,
  fresh: KeycloakAdminContext,
  only: readonly string[],
) {
  const people = only.length
    ? p.people.filter(
        (x) => only.includes(x.username) || only.includes(x.oldUsername),
      )
    : p.people;
  let missing = 0;
  for (const person of people) {
    const user = await findUser(fresh, person.username);
    if (!user) {
      missing += 1;
      console.log(`✗ ${person.username.padEnd(24)} MISSING`);
      continue;
    }
    const roles = (
      await api<KcRole[]>(fresh, `/users/${user.id}/role-mappings/realm`)
    ).map((r) => r.name);
    const groups = (
      await api<KcGroup[]>(fresh, `/users/${user.id}/groups`)
    ).map((g) => g.name);
    const lackRoles = person.roles.filter((r) => !roles.includes(r));
    const lackGroups = person.groups.filter((g) => !groups.includes(g));
    const ok =
      user.enabled === person.user.enabled &&
      !lackRoles.length &&
      !lackGroups.length;
    const note = p.existing.has(person.username)
      ? ' (was already there — untouched)'
      : '';
    console.log(
      `${ok ? '✓' : '!'} ${person.username.padEnd(24)} ${user.federationLink ? 'ldap ' : 'local'} enabled=${user.enabled}` +
        `${lackRoles.length ? ` missing roles: ${lackRoles.join(',')}` : ''}${lackGroups.length ? ` missing groups: ${lackGroups.join(',')}` : ''}${note}`,
    );
  }
  console.log(`\nChecked ${people.length}, missing ${missing}.`);
}

function modeOf(argv: readonly string[]): Mode {
  if (argv.includes('--apply')) return 'apply';
  if (argv.includes('--check')) return 'check';
  return 'dry-run';
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Refusing to run in production.');
  const argv = process.argv.slice(2);
  const mode = modeOf(argv);
  if (mode === 'apply' && process.env.KC_MIGRATE_ALLOW !== '1') {
    throw new Error('Refusing --apply without KC_MIGRATE_ALLOW=1.');
  }

  const oldEnv = realmEnv('OLD_');
  const newEnv = realmEnv('');
  console.log(
    `Old: ${oldEnv.baseUrl} realm ${oldEnv.realm} | New: ${newEnv.baseUrl} realm ${newEnv.realm} | mode ${mode}\n`,
  );
  const old = await connectAdmin(oldEnv);
  const fresh = await connectAdmin(newEnv);

  const p = await plan(old, fresh);
  if (mode === 'check')
    return check(
      p,
      fresh,
      argv.filter((arg) => !arg.startsWith('--')),
    );
  printPlan(p);
  if (mode === 'dry-run') return;

  const realm = await api<{ id: string }>(fresh, '');
  await apply(p, old, fresh, realm.id);
  console.log(
    `Snapshot of the new realm after: ${saveSnapshot('after', await snapshot(fresh))}`,
  );
}

main()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
