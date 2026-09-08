/**
 * Issue and revoke the API keys an integration authenticates with (AUTH-06).
 *
 *   APIKEY_ISSUE_ALLOW=1 yarn apikey:issue "Aiyara chatbot (prod)" [--days 365]
 *   yarn apikey:revoke <prefix>
 *   yarn apikey:list
 *
 * A script rather than an admin screen because issuing one is rare, and
 * because the plaintext must reach exactly one person: a screen would put it
 * in a browser, a proxy log and a screenshot on the way there.
 *
 * **The key is printed once and cannot be recovered.** Only its sha256 is
 * stored, which is what makes a leak of the table harmless — and what makes
 * "I lost it" mean "issue a new one and revoke the old", not "look it up".
 */
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';

const prisma = new PrismaClient();

/** Must match `API_KEY_PREFIX` in `services/core-service/src/principal`. */
const KEY_PREFIX = 'rfk_';
/** How much of the key is stored in the clear, to name one without quoting it. */
const DISPLAY_LENGTH = 12;

function mint(): { key: string; prefix: string; keyHash: string } {
  // 32 bytes of CSPRNG output — the same generator the PKCE verifier uses.
  const key = KEY_PREFIX + randomBytes(32).toString('base64url');

  return {
    key,
    prefix: key.slice(0, DISPLAY_LENGTH),
    keyHash: createHash('sha256').update(key).digest('hex'),
  };
}

/**
 * Refuses to mint in production without an explicit opt-in.
 *
 * Same guard as `seed-uat.ts`: the failure this prevents is a script run
 * against the wrong `DATABASE_URL`, and a credential is the worst thing to
 * create by accident.
 */
function assertMayIssue(): void {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.APIKEY_ISSUE_ALLOW !== '1'
  ) {
    throw new Error(
      'Refusing to issue in production without APIKEY_ISSUE_ALLOW=1.\n' +
        '  APIKEY_ISSUE_ALLOW=1 yarn apikey:issue "<name>"',
    );
  }
}

async function issue(name: string, days?: number): Promise<void> {
  assertMayIssue();

  if (!name.trim()) {
    throw new Error(
      'A name is required: yarn apikey:issue "Aiyara chatbot (prod)"',
    );
  }

  const { key, prefix, keyHash } = mint();
  const expiresAt =
    days === undefined ? null : new Date(Date.now() + days * 86_400_000);

  await prisma.apiKey.create({
    data: {
      name,
      prefix,
      keyHash,
      expiresAt,
      createdBy: process.env.USER ?? 'cli',
    },
  });

  console.log(`\n  ${name}`);
  console.log(
    `  prefix:  ${prefix}   ← ใช้อ้างถึง key นี้เวลาคุยกันหรือเวลา revoke`,
  );
  console.log(
    `  expires: ${expiresAt ? expiresAt.toISOString() : 'never — เพิกถอนด้วย yarn apikey:revoke เท่านั้น'}`,
  );
  console.log(
    '\n  ── key (แสดงครั้งเดียว เก็บทันที) ──────────────────────────',
  );
  console.log(`  ${key}`);
  console.log(
    '  ───────────────────────────────────────────────────────────\n',
  );
  console.log('  ส่งให้ผู้ใช้ผ่านช่องทางที่ปลอดภัย และอย่า commit ลง repo\n');
}

async function revoke(prefix: string): Promise<void> {
  const key = await prisma.apiKey.findUnique({ where: { prefix } });

  if (!key) throw new Error(`No API key with prefix "${prefix}".`);
  if (key.revokedAt) {
    console.log(
      `  ${prefix} ถูกเพิกถอนไปแล้วเมื่อ ${key.revokedAt.toISOString()}`,
    );
    return;
  }

  await prisma.apiKey.update({
    where: { prefix },
    data: {
      active: false,
      revokedAt: new Date(),
      revokedBy: process.env.USER ?? 'cli',
    },
  });

  console.log(`  เพิกถอน ${prefix} (${key.name}) แล้ว`);
  // Immediate, and measured rather than assumed: the key is looked up in this
  // table on every request, before the 60-second principal cache is consulted,
  // so a revoked key is refused on the very next call. The cache only ever
  // holds the principal of a key that resolved successfully.
  console.log('  มีผลทันที — คำขอถัดไปที่ใช้ key นี้จะได้ 401\n');
}

async function list(): Promise<void> {
  const keys = await prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' } });

  if (!keys.length) {
    console.log('  ยังไม่มี API key');
    return;
  }

  for (const key of keys) {
    const state = key.revokedAt
      ? 'revoked'
      : !key.active
        ? 'inactive'
        : key.expiresAt && key.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : 'active';

    console.log(
      `  ${key.prefix}  ${state.padEnd(8)}  ` +
        `last used ${key.lastUsedAt?.toISOString() ?? '—'}  ${key.name}`,
    );
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'issue': {
      const flag = rest.indexOf('--days');
      const days = flag === -1 ? undefined : Number(rest[flag + 1]);
      if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
        throw new Error('--days must be a whole number of days, 1 or more.');
      }
      const name = (flag === -1 ? rest : rest.slice(0, flag)).join(' ');
      return issue(name, days);
    }
    case 'revoke':
      if (!rest[0]) throw new Error('Usage: yarn apikey:revoke <prefix>');
      return revoke(rest[0]);
    case 'list':
      return list();
    default:
      throw new Error(
        'Usage:\n' +
          '  yarn apikey:issue "<name>" [--days N]\n' +
          '  yarn apikey:revoke <prefix>\n' +
          '  yarn apikey:list',
      );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
