/**
 * Fills in the HR fields the previous system held, for people who already
 * have an account here.
 *
 *   DRY_RUN=1 USERS_IMPORT_ALLOW=1 yarn data:import-users
 *   USERS_IMPORT_ALLOW=1 yarn data:import-users
 *   USERS_IMPORT_ALLOW=1 SYNC_KEYCLOAK=1 yarn data:import-users
 *
 * Source: `source/users_202609160951.csv`, an export of the old user table.
 * Rows are matched on `username` and **no account is ever created** — 29 of
 * the 102 rows name people this system has never seen, and inventing profiles
 * for them would put users in the directory who cannot sign in and whom no
 * approval chain can route to.
 *
 * What it writes: `employeeId`, `extension`, `startWork`, `phone`, and — under
 * the rules below — `email`. What it refuses to touch: `displayName` (ours
 * carries the Thai courtesy title, the export does not), `position` (ours is a
 * job title, the export's `positionId` is a number), `status`, `orgUnitId` and
 * `supervisorUserId` (org placement is an admin's decision, D-08).
 *
 * **Email is the careful part.** Three rules, each of which exists because the
 * export violates it somewhere:
 *
 *   1. An address that differs only in capitalisation is not a change. The
 *      export upper-cases the first letter of eight addresses;
 *      `findActiveByEmail` compares exactly, so applying them would make
 *      `X-Acting-User: duangjaik@osd.co.th` — the address the chatbot has
 *      always used — stop resolving.
 *   2. An address that appears on two rows is applied to neither. In this
 *      export `yuwadip` carries `duangkamolm@osd.co.th`, which belongs to a
 *      different person. A rule, not a name-check, so the next bad export is
 *      caught too.
 *   3. An address already held by a different account here is skipped and
 *      reported, because `User.email` is unique and one bad row must not abort
 *      the other seventy-two.
 *
 * With `SYNC_KEYCLOAK=1` it then pushes this database's addresses **into** the
 * realm, which is the opposite direction to the login-time sync and is
 * deliberate: 66 of the 90 accounts have no email in Keycloak at all, and one
 * (`nakhonj`) has a misspelt domain that would overwrite the correct local
 * value the moment that person next signs in.
 *
 * Nothing that cannot be applied is dropped quietly — every skipped row is
 * counted and named in the summary.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  connectAdmin,
  findAccount,
  readRealmSettings,
  updateAccountEmail,
} from './keycloak-admin';

const prisma = new PrismaClient();

const CSV_PATH = resolve(__dirname, '../../../source/users_202609160951.csv');

/** The columns this import reads. The export carries 28; the rest are noise. */
const COLUMNS = [
  'username',
  'email',
  'emp_id',
  'extension',
  'start_work',
  'phone_number',
] as const;

type Column = (typeof COLUMNS)[number];
type Row = Record<Column, string | null>;

interface Skip {
  readonly username: string;
  readonly reason: string;
}

/**
 * A parser rather than a dependency.
 *
 * Verified against this export: 102 rows, 28 columns, and not one embedded
 * comma, quote or newline. `request-log-source.ts` records the standing
 * decision that adding a parsing library here is a person's call, not a
 * script's — so this stays a split until an export arrives that needs more,
 * at which point the row-length check below is what will say so out loud.
 */
function parseCsv(text: string): Row[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const header = splitLine(lines[0]);
  const width = header.length;

  const index = {} as Record<Column, number>;
  for (const column of COLUMNS) {
    const at = header.indexOf(column);
    if (at === -1) throw new Error(`The export has no "${column}" column.`);
    index[column] = at;
  }

  return lines.slice(1).map((line, offset) => {
    const cells = splitLine(line);
    if (cells.length !== width) {
      throw new Error(
        `Row ${offset + 2} has ${cells.length} cells, expected ${width}. ` +
          'The export may now contain quoted commas — this parser cannot read that.',
      );
    }

    const row = {} as Row;
    for (const column of COLUMNS) row[column] = clean(cells[index[column]]);
    return row;
  });
}

function splitLine(line: string): string[] {
  return line
    .replace(/\r$/, '')
    .split(',')
    .map((cell) => cell.replace(/^"(.*)"$/, '$1'));
}

/** `-` is how the old system wrote "nothing", and it is not a phone number. */
function clean(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' || trimmed === '-' ? null : trimmed;
}

/**
 * Reads `2019-05-21 00:00:00.000` as that calendar day, not as a local time.
 *
 * The trailing `Z` is load-bearing. Without it Node parses the string in the
 * machine's zone, so on a laptop in Asia/Bangkok a start date of 21 May is
 * stored as `2019-05-20T17:00:00Z` and reads back as the 20th — a silent
 * off-by-one that follows the timezone of whoever ran the import. Only the
 * date carries meaning here, so it is pinned to midnight UTC and stays put.
 */
function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to rewrite user profiles in production.');
  }

  if (process.env.USERS_IMPORT_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without USERS_IMPORT_ALLOW=1.\n' +
        'This rewrites profile fields for real employees. Re-run as:\n' +
        '  USERS_IMPORT_ALLOW=1 yarn data:import-users',
    );
  }

  const dryRun = process.env.DRY_RUN === '1';
  const syncKeycloak = process.env.SYNC_KEYCLOAK === '1';

  // Two databases carry this schema — a development one and the labs VM's —
  // and they are told apart only by host. Printing it is cheaper than
  // discovering afterwards that the wrong one was rewritten.
  console.log(`database : ${hostOfDatabaseUrl()}`);
  console.log(
    `mode     : ${dryRun ? 'DRY RUN — nothing is written' : 'APPLY'}`,
  );
  console.log(
    `keycloak : ${syncKeycloak ? 'will sync emails' : 'not touched'}`,
  );
  console.log(`source   : ${CSV_PATH}\n`);

  const rows = parseCsv(readFileSync(CSV_PATH, 'utf-8'));
  const users = await prisma.user.findMany({
    select: {
      id: true,
      username: true,
      email: true,
      employeeId: true,
      extension: true,
      startWork: true,
      phone: true,
    },
  });

  const byUsername = new Map(users.map((user) => [user.username, user]));
  const emailOwner = new Map(
    users.flatMap((user) =>
      user.email ? [[user.email.toLowerCase(), user.username]] : [],
    ),
  );

  // Rule 2, applied before anything is written: an address on two rows is
  // evidence the export is wrong about at least one of them.
  const seen = new Map<string, number>();
  for (const row of rows) {
    if (!row.email) continue;
    const key = row.email.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const duplicated = new Set(
    [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([email]) => email),
  );

  const skipped: Skip[] = [];
  const emailSkips: Skip[] = [];
  const changes: Prisma.UserUpdateArgs[] = [];
  const counts = {
    employeeId: 0,
    extension: 0,
    startWork: 0,
    phone: 0,
    email: 0,
  };

  for (const row of rows) {
    const username = row.username;
    if (!username) continue;

    const user = byUsername.get(username);
    if (!user) {
      skipped.push({ username, reason: 'no account in this database' });
      continue;
    }

    const data: Prisma.UserUpdateInput = {};

    const employeeId = row.emp_id;
    if (employeeId && employeeId !== user.employeeId) {
      data.employeeId = employeeId;
      counts.employeeId += 1;
    }

    const extension = row.extension;
    if (extension && extension !== user.extension) {
      data.extension = extension;
      counts.extension += 1;
    }

    const phone = row.phone_number;
    if (phone && phone !== user.phone) {
      data.phone = phone;
      counts.phone += 1;
    }

    const startWork = parseDate(row.start_work);
    if (row.start_work && !startWork) {
      skipped.push({
        username,
        reason: `unreadable start_work "${row.start_work}"`,
      });
    } else if (
      startWork &&
      startWork.getTime() !== (user.startWork?.getTime() ?? NaN)
    ) {
      data.startWork = startWork;
      counts.startWork += 1;
    }

    const email = emailDecision(row.email, user.email, username, {
      duplicated,
      emailOwner,
      emailSkips,
    });
    if (email) {
      data.email = email;
      counts.email += 1;
    }

    if (Object.keys(data).length > 0) {
      changes.push({ where: { username }, data });
    }
  }

  report('rows the database does not have', skipped);
  report('email left alone', emailSkips);

  if (!dryRun && changes.length > 0) {
    await prisma.$transaction(
      changes.map((change) => prisma.user.update(change)),
    );
    await prisma.auditLog.create({
      data: {
        eventType: 'user.imported',
        actorUsername: 'data:import-users (cli)',
        resourceType: 'user',
        resourceId: 'users-csv',
        after: {
          source: 'users_202609160951.csv',
          rows: rows.length,
          updated: changes.length,
          fields: counts,
        } as Prisma.InputJsonValue,
      },
    });
  }

  printSummary({
    rows: rows.length,
    matched: rows.length - skipped.length,
    changes: changes.length,
    counts,
  });

  if (syncKeycloak) await syncEmailsToKeycloak(dryRun);
}

/**
 * Whether this row's address should be written, and why not when it should not.
 *
 * Returns the address to write, or `null` — recording the reason so the
 * summary can name every address it declined to touch.
 */
function emailDecision(
  incoming: string | null,
  current: string | null,
  username: string,
  context: {
    duplicated: Set<string>;
    emailOwner: Map<string, string>;
    emailSkips: Skip[];
  },
): string | null {
  if (!incoming) return null;

  const key = incoming.toLowerCase();

  if (context.duplicated.has(key)) {
    context.emailSkips.push({
      username,
      reason: `"${incoming}" appears on more than one row of the export`,
    });
    return null;
  }

  // Rule 1. Not "no change worth making" — a change that would actively break
  // the chatbot's existing lookups, which compare the address exactly.
  if (current && current.toLowerCase() === key) return null;

  const owner = context.emailOwner.get(key);
  if (owner && owner !== username) {
    context.emailSkips.push({
      username,
      reason: `"${incoming}" already belongs to ${owner}`,
    });
    return null;
  }

  return incoming;
}

/**
 * Pushes local addresses into the realm, which is the opposite of the usual
 * direction and is why it is opt-in.
 *
 * At login Keycloak's claim overwrites the local row. That is correct when the
 * realm knows the address and wrong when it does not — and it does not, for
 * most people here. Filling the realm makes the two agree, which turns the
 * login-time overwrite from a hazard into a no-op.
 */
async function syncEmailsToKeycloak(dryRun: boolean): Promise<void> {
  const env = readRealmSettings(
    'USERS_IMPORT_ALLOW',
    'USERS_IMPORT_ALLOW=1 SYNC_KEYCLOAK=1 yarn data:import-users',
  );
  const keycloak = await connectAdmin(env);

  const users = await prisma.user.findMany({
    where: { email: { not: null } },
    select: { username: true, email: true },
    orderBy: { username: 'asc' },
  });

  let filled = 0;
  let corrected = 0;
  let unchanged = 0;
  const failures: Skip[] = [];

  console.log('\nKeycloak');
  for (const user of users) {
    const email = user.email as string;
    try {
      const account = await findAccount(keycloak, user.username);
      if (!account) {
        failures.push({ username: user.username, reason: 'no realm account' });
        continue;
      }

      if (account.email === email) {
        unchanged += 1;
        continue;
      }

      // Overwriting a non-empty address is the one case a person must see, so
      // it is named rather than folded into a count.
      if (account.email) {
        console.log(
          `  ${user.username.padEnd(16)} ${account.email} → ${email}  (realm value replaced)`,
        );
        corrected += 1;
      } else {
        filled += 1;
      }

      if (!dryRun) await updateAccountEmail(keycloak, account.id, email);
    } catch (error) {
      failures.push({
        username: user.username,
        reason: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }

  console.log(`  ${'filled (realm was empty)'.padEnd(30)} ${filled}`);
  console.log(`  ${'corrected (realm differed)'.padEnd(30)} ${corrected}`);
  console.log(`  ${'already matching'.padEnd(30)} ${unchanged}`);
  report('realm accounts not updated', failures);
}

function report(title: string, entries: readonly Skip[]): void {
  if (entries.length === 0) return;
  console.log(`\n${title} (${entries.length})`);
  for (const entry of entries) {
    console.log(`  ${entry.username.padEnd(16)} ${entry.reason}`);
  }
}

function printSummary(summary: {
  rows: number;
  matched: number;
  changes: number;
  counts: Record<string, number>;
}): void {
  console.log('\nDatabase');
  console.log(`  ${'rows in the export'.padEnd(30)} ${summary.rows}`);
  console.log(`  ${'matched an account'.padEnd(30)} ${summary.matched}`);
  console.log(
    `  ${'rows with something to write'.padEnd(30)} ${summary.changes}`,
  );
  for (const [field, count] of Object.entries(summary.counts)) {
    console.log(`  ${`  ${field}`.padEnd(30)} ${count}`);
  }
}

/** The host only — the connection string carries a password. */
function hostOfDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? '';
  const match = /@([^:/@]+:\d+\/[^?]+)/.exec(url);
  return match ? match[1] : '(DATABASE_URL not set)';
}

main()
  .then(() => console.log('\nDone.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
