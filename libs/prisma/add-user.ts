/**
 * Add one person: a Keycloak account, their local profile, and their place in
 * the org chart.
 *
 *   ADD_USER_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn user:add \
 *     --email chetsadak@mbizconsultant.com \
 *     --unit OSD-OU0151 \
 *     --display "chetsadak" \
 *     [--company OSD] [--position "Software Developer"] [--roles employee,receiver]
 *
 * Idempotent — safe to re-run. An account that already exists is reused and
 * its password left alone.
 *
 * A script rather than a screen, and one person rather than a cohort: the
 * bulk importers (`import-osd-catalog.ts`, `seed-uat-users.ts`) each own a
 * *list* and rewrite it on every run, so adding a single joiner to either
 * would mean editing a file that describes a different job. This one takes the
 * person on the command line and touches nobody else.
 *
 * Identity stays Keycloak's (§03). What is written locally is the profile and
 * the org placement, which the org tree owns (D-08).
 */
import { PrismaClient } from '@prisma/client';
import {
  connect,
  ensureKeycloakUser,
  grantClientRole,
  grantSystemRole,
  readKeycloakEnv,
  upsertProfile,
  type KeycloakContext,
} from './keycloak-admin';

const prisma = new PrismaClient();

/** What every OSD employee carries; see the peers already in the chart. */
const DEFAULT_ROLES = ['employee', 'receiver'];
/** The `request-form` client role. One, because that is what maps to a system role (ROLE-03). */
const KEYCLOAK_ROLE = 'employee';

interface Options {
  readonly email: string;
  readonly unit: string;
  readonly company: string;
  readonly display?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly position?: string;
  readonly roles: readonly string[];
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--')) {
      throw new Error(
        `Unexpected argument "${argv[i]}". Flags look like --email x@y.z`,
      );
    }
    flags.set(argv[i].slice(2), argv[i + 1] ?? '');
  }

  const email = flags.get('email')?.trim();
  const unit = flags.get('unit')?.trim();

  if (!email || !unit) {
    throw new Error(
      'Usage:\n' +
        '  ADD_USER_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn user:add \\\n' +
        '    --email <address> --unit <org unit code> [--display "ชื่อ"] \\\n' +
        '    [--first ชื่อ] [--last สกุล] [--company OSD] \\\n' +
        '    [--position "Software Developer"] [--roles employee,receiver]',
    );
  }

  const roles = flags.get('roles');

  return {
    email,
    unit,
    company: flags.get('company')?.trim() || 'OSD',
    display: flags.get('display')?.trim(),
    firstName: flags.get('first')?.trim(),
    lastName: flags.get('last')?.trim(),
    position: flags.get('position')?.trim(),
    roles: roles
      ? roles
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : DEFAULT_ROLES,
  };
}

async function addUser(options: Options): Promise<void> {
  const env = readKeycloakEnv(
    'ADD_USER_ALLOW',
    'ADD_USER_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn user:add --email … --unit …',
  );

  const company = await prisma.company.findUnique({
    where: { code: options.company },
  });
  if (!company) throw new Error(`No company "${options.company}".`);

  /*
    By code, and only within this company. The OSD chart's codes are generated
    (`OSD-OU0151`), not the catalog's mnemonics — a lookup for "RND" finds
    nothing, because `RND` is that unit's *name*. Both are accepted here so the
    caller can use whichever they read off the screen.
  */
  const unit = await prisma.orgUnit.findFirst({
    where: {
      companyId: company.id,
      OR: [{ code: options.unit }, { name: options.unit }],
    },
  });

  if (!unit) {
    throw new Error(
      `No org unit "${options.unit}" in ${options.company}. ` +
        'Pass its code (e.g. OSD-OU0151) or its exact name.',
    );
  }

  // The local part, which is what every existing account uses as its username.
  const username = options.email.split('@')[0];
  const display = options.display ?? username;

  const keycloak = await connect(env);
  const account = await ensureKeycloakUser(keycloak, {
    username,
    email: options.email,
    firstName: options.firstName ?? display,
    lastName: options.lastName ?? '',
  });

  /*
    The realm may already know this person by name.

    Accounts get created ahead of the local profile — by an administrator, by
    an earlier import — and when they do, the realm holds the real first and
    last name while this script's fallback holds the username. Writing the
    fallback over it would replace "Chetsada Khwanthong" with "chetsadak" on
    every timeline entry they ever appear in. So a name that was not passed on
    the command line is read back from the account instead of assumed.
  */
  const known = account.created ? null : await readNames(keycloak, account.id);

  await grantClientRole(keycloak, account.id, KEYCLOAK_ROLE);

  const firstName = options.firstName ?? known?.firstName ?? display;
  const lastName = options.lastName ?? known?.lastName ?? '';
  const displayName =
    (options.display ?? [firstName, lastName].filter(Boolean).join(' ')) ||
    username;

  const userId = await upsertProfile(
    prisma,
    {
      username,
      displayName,
      firstName,
      lastName,
      email: options.email,
      orgUnitId: unit.id,
      position: options.position ?? unit.name,
      keycloakRoles: [KEYCLOAK_ROLE],
    },
    account.id,
    company.id,
  );

  for (const role of options.roles) {
    await grantSystemRole(prisma, userId, company.id, role);
  }

  console.log(`\n  ${displayName} <${options.email}>`);
  console.log(`  username:  ${username}`);
  console.log(`  company:   ${company.code}`);
  console.log(`  org unit:  ${unit.name} (${unit.code ?? unit.id})`);
  console.log(`  position:  ${options.position ?? unit.name}`);
  console.log(
    `  roles:     client=${KEYCLOAK_ROLE} · system=${options.roles.join(', ')}`,
  );
  console.log(
    `  keycloak:  ${account.created ? 'สร้างใหม่ — รหัสผ่านคือค่าใน UAT_DEFAULT_PASSWORD' : 'มีอยู่แล้ว รหัสผ่านเดิมไม่ถูกแตะ'}`,
  );

  if (known && !options.display) {
    console.log(
      `  ชื่อ:       เอามาจาก account เดิมใน Keycloak ไม่ใช่จาก username`,
    );
  }
  console.log(
    '\n  ต้อง login ผ่านหน้าเว็บหนึ่งครั้งก่อน สิทธิ์จึงจะถูก cache ' +
      'และ External API ถึงจะทำรายการแทนคนนี้ได้\n',
  );
}

/** The names the realm already holds, so an existing one is never overwritten. */
async function readNames(
  keycloak: KeycloakContext,
  id: string,
): Promise<{ firstName?: string; lastName?: string } | null> {
  const response = await fetch(`${keycloak.base}/users/${id}`, {
    headers: keycloak.headers,
  });

  if (!response.ok) return null;

  const account = (await response.json()) as {
    firstName?: string;
    lastName?: string;
  };

  return {
    firstName: account.firstName || undefined,
    lastName: account.lastName || undefined,
  };
}

addUser(parseArgs(process.argv.slice(2)))
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
