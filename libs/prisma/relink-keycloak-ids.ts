/**
 * Points `users.keycloakId` at the new realm's accounts now, instead of waiting for each first login.
 * `DATABASE_URL=… yarn kc:relink [--apply]`; realm from KEYCLOAK_*. Matching rules: relink-match.ts.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import { connectAdmin, type KeycloakAdminContext } from './keycloak-admin';
import { matchAccounts, type RealmAccount, type Relink } from './relink-match';

const ACTOR = 'kc:relink (cli)';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
}

/** Host, port and database only — never the password. */
function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || '5432'}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function realmAccounts(
  kc: KeycloakAdminContext,
): Promise<RealmAccount[]> {
  const response = await fetch(
    `${kc.base}/users?max=100000&briefRepresentation=true`,
    { headers: kc.headers },
  );
  if (!response.ok) throw new Error(`GET /users → HTTP ${response.status}`);
  // Keycloak admin API shape, trusted as documented.
  return (await response.json()) as RealmAccount[];
}

function printReport(results: readonly Relink[]): void {
  const of = <K extends Relink['kind']>(kind: K) =>
    results.filter((r): r is Extract<Relink, { kind: K }> => r.kind === kind);

  for (const r of of('relink'))
    console.log(
      `  ~ ${r.user.username.padEnd(24)} by ${r.by.padEnd(8)} → ${r.username}${r.username !== r.user.username ? ' (username changes)' : ''}`,
    );
  for (const r of of('conflict'))
    console.log(`  ! ${r.user.username.padEnd(24)} conflict: ${r.reason}`);
  for (const r of of('missing'))
    console.log(`  ? ${r.user.username.padEnd(24)} not in the realm`);

  console.log(
    `\nrelink ${of('relink').length}, unchanged ${of('unchanged').length}, conflict ${of('conflict').length}, missing ${of('missing').length}`,
  );
}

async function apply(
  prisma: PrismaClient,
  results: readonly Relink[],
): Promise<void> {
  let done = 0;
  const failed: string[] = [];
  for (const r of results) {
    if (r.kind !== 'relink') continue;
    try {
      await prisma.$transaction(async (tx) => {
        const user = await tx.user.update({
          where: { id: r.user.id },
          data: { keycloakId: r.keycloakId, username: r.username },
        });
        await tx.auditLog.create({
          data: {
            eventType: 'identity.relinked',
            companyId: user.primaryCompanyId,
            actorUsername: ACTOR,
            resourceType: 'user',
            resourceId: user.id,
            before: {
              keycloakId: r.user.keycloakId,
              username: r.user.username,
            } as Prisma.InputJsonValue,
            after: {
              keycloakId: r.keycloakId,
              username: r.username,
              by: r.by,
            } as Prisma.InputJsonValue,
          },
        });
      });
      done += 1;
    } catch (error) {
      failed.push(r.user.username);
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`  ! ${r.user.username}: ${reason.split('\n')[0]}`);
    }
  }
  console.log(
    `Applied ${done}, failed ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`,
  );
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Refusing to run in production.');
  const applying = process.argv.includes('--apply');
  if (applying && process.env.KC_RELINK_ALLOW !== '1')
    throw new Error('Refusing --apply without KC_RELINK_ALLOW=1.');

  const env = {
    baseUrl: requireEnv('KEYCLOAK_BASE_URL').replace(/\/$/, ''),
    realm: requireEnv('KEYCLOAK_REALM'),
    clientId: requireEnv('KEYCLOAK_CLIENT_ID'),
    clientSecret: requireEnv('KEYCLOAK_CLIENT_SECRET'),
  };
  console.log(
    `Realm: ${env.baseUrl} ${env.realm} | Database: ${describeDatabase(requireEnv('DATABASE_URL'))} | mode ${applying ? 'apply' : 'dry-run'}\n`,
  );

  const accounts = await realmAccounts(await connectAdmin(env));
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, email: true, keycloakId: true },
      orderBy: { username: 'asc' },
    });
    const results = matchAccounts(users, accounts);
    printReport(results);
    if (applying) await apply(prisma, results);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
