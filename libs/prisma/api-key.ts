/**
 * Issue and revoke the API keys an integration authenticates with (AUTH-06).
 *
 *   APIKEY_ISSUE_ALLOW=1 yarn apikey:issue "Aiyara chatbot (prod)" [--days 365]
 *   yarn apikey:issue "เว็บไซต์ osd.co.th" --company <id> --source website \
 *     --scope integration.crm.lead.create
 *   yarn apikey:revoke <prefix>
 *   yarn apikey:list
 *
 * **หนึ่ง key ต่อหนึ่งช่องทาง** (14 ก.ย. 2569) — `--company`, `--source` และ
 * `--scope` ทำให้ผู้เรียกไม่ต้องส่งอะไรนอกจากตัว key: บริษัทและช่องทางอยู่บน
 * กุญแจ ไม่ใช่บน header กับ body ที่กรอกผิดได้. เว้นทั้งสามไว้ = key แบบเดิม
 * (ผู้เรียกส่ง `X-Company-Id` เอง, สิทธิ์เต็มชุดของ integration client).
 *
 * **ทางหลักย้ายไปหน้าจอแล้ว** (14 ก.ย. 2569) — ผู้ดูแลระบบ → "API Key ช่องทาง
 * ภายนอก" (`admin.integration.manage`). เหตุผลเดิมที่ว่า "ออกไม่บ่อยเลยเป็น
 * สคริปต์พอ" หมดอายุไปพร้อมกับกฎหนึ่งกุญแจต่อหนึ่งช่องทาง: การออกกุญแจกลาย
 * เป็นงานประจำของคนดูแล CRM ไม่ใช่ของคนที่ ssh เข้าเครื่องได้ และการต้องรอ dev
 * มารันคำสั่งให้ จบลงด้วยการใช้กุญแจใบเดิมซ้ำทุกช่องทาง ซึ่งแย่กว่าปัญหาเดิม.
 *
 * ข้อกังวลอีกข้อ — ค่าเต็มต้องถึงมือคนเดียว ไม่ใช่ไปนอนใน proxy log — ยังจริงอยู่
 * และถูกกันไว้ที่หน้าจอนั้นแทน (คืนค่าครั้งเดียว ไม่มี endpoint อ่านกลับ ไม่ลง
 * audit). ดู `ApiKeyAdminService`.
 *
 * สคริปต์นี้ยังอยู่สำหรับสิ่งที่หน้าจอตั้งใจทำไม่ได้: กุญแจที่ **ไม่ผูกบริษัท**
 * (แชตบอตที่ทำงานข้ามบริษัทด้วยใบเดียว) และงานกู้สถานการณ์ตอนหน้าจอเข้าไม่ได้.
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

interface IssueOptions {
  days?: number;
  companyId?: string;
  sourceCode?: string;
  scopes: string[];
}

async function issue(name: string, options: IssueOptions): Promise<void> {
  assertMayIssue();

  if (!name.trim()) {
    throw new Error(
      'A name is required: yarn apikey:issue "Aiyara chatbot (prod)"',
    );
  }

  /*
    ตรวจว่าบริษัทมีจริงตั้งแต่ตอนออกกุญแจ. กุญแจที่ผูกกับ id ที่พิมพ์ตกไปหนึ่ง
    ตัวจะผ่านทุกด่านแล้วไปตายเงียบ ๆ ตอนคำขอจริงของช่องทางนั้น — ซึ่งคือหลัง
    ส่งกุญแจให้พาร์ตเนอร์ไปแล้ว.
  */
  if (options.companyId) {
    const company = await prisma.company.findUnique({
      where: { id: options.companyId },
      select: { id: true, name: true },
    });

    if (!company) {
      throw new Error(`No company with id "${options.companyId}".`);
    }
  }

  /*
    ตรวจชื่อสิทธิ์กับตาราง `permissions` ซึ่ง sync มาจาก catalog ใน libs/share
    ตอน boot — ไม่ import catalog ตรง ๆ เพราะสคริปต์นี้ตั้งใจไม่พึ่ง path alias
    ของ workspace (รันด้วย ts-node เปล่า ๆ ได้ทุกเครื่อง).

    ที่ต้องตรวจเพราะ `scopes` เป็น intersect: พิมพ์ผิดหนึ่งตัวอักษรไม่ได้ error
    ที่ไหนเลย — ได้กุญแจที่ตัดสิทธิ์เหลือศูนย์ แล้วไปรู้ตอนช่องทางนั้นยิงจริง
    และได้ 403 โดยไม่มีอะไรบอกว่าเพราะอะไร.
  */
  if (options.scopes.length) {
    const known = await prisma.permission.findMany({
      where: { code: { in: options.scopes } },
      select: { code: true },
    });
    const missing = options.scopes.filter(
      (scope) => !known.some((row) => row.code === scope),
    );

    if (missing.length) {
      throw new Error(
        `ไม่รู้จักสิทธิ์: ${missing.join(', ')}\n` +
          '  ดูรายการที่มีได้จากตาราง permissions ' +
          '(sync จาก libs/share/src/policy/permissions.ts ตอน boot)',
      );
    }
  }

  const { key, prefix, keyHash } = mint();
  const expiresAt =
    options.days === undefined
      ? null
      : new Date(Date.now() + options.days * 86_400_000);

  await prisma.apiKey.create({
    data: {
      name,
      prefix,
      keyHash,
      expiresAt,
      companyId: options.companyId ?? null,
      sourceCode: options.sourceCode ?? null,
      scopes: options.scopes,
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
    `  company: ${options.companyId ?? '— (ผู้เรียกต้องส่ง X-Company-Id เอง)'}`,
  );
  console.log(
    `  source:  ${options.sourceCode ?? '— (ต้องส่ง source_code มาใน body)'}`,
  );
  console.log(
    `  scopes:  ${options.scopes.length ? options.scopes.join(', ') : '— (เต็มชุดของ integration client)'}`,
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
        `${(key.sourceCode ?? '—').padEnd(16)}  ` +
        `last used ${key.lastUsedAt?.toISOString() ?? '—'}  ${key.name}`,
    );
  }
}

/**
 * `--flag value` pairs, with everything before the first flag as the name.
 *
 * Hand-rolled rather than a library because this script has no dependencies of
 * its own on purpose — it is run from a terminal against a production database,
 * and the list of things that can go wrong should stay short enough to read.
 *
 * `--scope` repeats (a key may hold several); the rest take the last value.
 */
function parseIssueArgs(argv: string[]): {
  name: string;
  values: { days?: string; company?: string; source?: string; scope?: string[] };
} {
  const values: {
    days?: string;
    company?: string;
    source?: string;
    scope?: string[];
  } = {};
  const words: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      // หลังเจอ flag แรกแล้ว คำลอย ๆ คือค่าที่หลงมา ไม่ใช่ส่วนหนึ่งของชื่อ
      if (Object.keys(values).length === 0) words.push(argument);
      continue;
    }

    const flag = argument.slice(2);
    const value = argv[index + 1];

    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${flag} ต้องตามด้วยค่า`);
    }
    index += 1;

    switch (flag) {
      case 'days':
      case 'company':
      case 'source':
        values[flag] = value;
        break;
      case 'scope':
        values.scope = [...(values.scope ?? []), value];
        break;
      default:
        throw new Error(`ไม่รู้จัก --${flag}`);
    }
  }

  return { name: words.join(' '), values };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case 'issue': {
      const { name, values } = parseIssueArgs(rest);

      const days = values.days === undefined ? undefined : Number(values.days);
      if (days !== undefined && (!Number.isInteger(days) || days < 1)) {
        throw new Error('--days must be a whole number of days, 1 or more.');
      }

      return issue(name, {
        days,
        companyId: values.company,
        sourceCode: values.source,
        // ซ้ำกันได้ไม่มีความหมาย และ order ไม่สำคัญ — เก็บเป็น set แล้วคลี่ออก
        scopes: [...new Set(values.scope ?? [])],
      });
    }
    case 'revoke':
      if (!rest[0]) throw new Error('Usage: yarn apikey:revoke <prefix>');
      return revoke(rest[0]);
    case 'list':
      return list();
    default:
      throw new Error(
        'Usage:\n' +
          '  yarn apikey:issue "<name>" [--days N] [--company <id>]\n' +
          '                             [--source <code>] [--scope <permission>]…\n' +
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
