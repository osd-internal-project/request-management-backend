/**
 * Provision the UAT test accounts — one per role in the §5.2 table — so that
 * `docs/uat-scenarios.md` can actually be run end to end.
 *
 *   UAT_SEED_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn uat:users
 *
 * The set is built to exercise a whole request: an employee submits, their
 * supervisor approves step 1, CFO and CEO approve the tiers above T1 and T2,
 * and the Pricing team receives and closes the work. The org placements match
 * the tree `seed.ts` creates from mockup A3.
 *
 * Identities are created **in Keycloak**, which stays their owner — this
 * system still has no path that invents one, and still accepts no password of
 * its own. What is written here is the local profile and its org placement,
 * which the org tree owns (D-08).
 *
 * Idempotent — safe to re-run. An account that already exists is reused rather
 * than recreated, and its password is left alone.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import {
  connect,
  ensureKeycloakUser,
  grantRealmRole,
  grantSystemRole,
  readKeycloakEnv,
  upsertProfile,
  type KeycloakContext,
} from './keycloak-admin';

const prisma = new PrismaClient();

/**
 * The company whose org tree `seed.ts` populates.
 *
 * `OSD_DEMO`, not `OSD`: these seven accounts are invented characters from
 * mockup §16 and belong beside the invented org tree, not in the real
 * company's directory.
 */
const COMPANY_CODE = 'OSD_DEMO';

interface UatUser {
  readonly username: string;
  readonly displayName: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Org unit code from `seedOrgTree` — mockup A3. */
  readonly orgUnitCode: string;
  /** Username of their supervisor; `null` at the top of the chart. */
  readonly supervisor: string | null;
  /** Realm role, which maps to the system role of the same code (ROLE-03). */
  readonly role: string;
  /** True where this person heads the unit, e.g. a team lead over their team. */
  readonly managesUnit?: boolean;
  readonly purpose: string;
}

const UAT_USERS: readonly UatUser[] = [
  {
    username: 'uat.somchai',
    displayName: 'สมชาย ก. (UAT)',
    firstName: 'สมชาย',
    lastName: 'ก.',
    orgUnitCode: 'GETTER1',
    supervisor: 'uat.somying',
    role: 'employee',
    purpose: 'ยื่นคำขอส่วนลด — ผู้ขอต้นทาง',
  },
  {
    username: 'uat.somying',
    displayName: 'สมหญิง จ. (UAT)',
    firstName: 'สมหญิง',
    lastName: 'จ.',
    orgUnitCode: 'GETTER1',
    supervisor: 'uat.wichai',
    role: 'team_lead',
    managesUnit: true,
    purpose: 'อนุมัติชั้นที่ 1 — หัวหน้าของผู้ขอ',
  },
  {
    username: 'uat.wichai',
    displayName: 'วิชัย ส. (UAT)',
    firstName: 'วิชัย',
    lastName: 'ส.',
    orgUnitCode: 'SALES',
    supervisor: 'uat.cfo',
    role: 'department_manager',
    managesUnit: true,
    purpose: 'ผู้จัดการฝ่ายขาย — ทดสอบ scope ระดับฝ่าย',
  },
  {
    username: 'uat.pricing',
    displayName: 'ปรีชา พ. (UAT)',
    firstName: 'ปรีชา',
    lastName: 'พ.',
    orgUnitCode: 'PRICING',
    supervisor: 'uat.wichai',
    role: 'receiver',
    managesUnit: true,
    purpose: 'ทีมปลายทาง — ตีกลับและปิดงาน (REQ-08)',
  },
  {
    username: 'uat.cfo',
    displayName: 'ศิริพร ค. (UAT)',
    firstName: 'ศิริพร',
    lastName: 'ค.',
    orgUnitCode: 'FIN',
    supervisor: 'uat.ceo',
    role: 'cfo',
    managesUnit: true,
    purpose: 'อนุมัติชั้นที่ 2 — วงเงินเกินเพดานระดับ 1',
  },
  {
    username: 'uat.ceo',
    displayName: 'ธนา ซ. (UAT)',
    firstName: 'ธนา',
    lastName: 'ซ.',
    orgUnitCode: 'ROOT',
    supervisor: null,
    role: 'ceo',
    managesUnit: true,
    purpose: 'อนุมัติชั้นที่ 3 — วงเงินเกินเพดานระดับ 2',
  },
  {
    username: 'uat.auditor',
    displayName: 'อรุณี ต. (UAT)',
    firstName: 'อรุณี',
    lastName: 'ต.',
    orgUnitCode: 'ROOT',
    supervisor: 'uat.ceo',
    role: 'auditor',
    purpose: 'อ่านอย่างเดียวข้ามบริษัท + audit log',
  },
];

async function main(): Promise<void> {
  const env = readKeycloakEnv(
    'UAT_SEED_ALLOW',
    'UAT_SEED_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn uat:users',
  );
  console.log(`Provisioning UAT accounts in realm "${env.realm}"…`);

  const keycloak: KeycloakContext = await connect(env);

  const company = await prisma.company.findUnique({
    where: { code: COMPANY_CODE },
  });
  if (!company) {
    throw new Error(
      `No company "${COMPANY_CODE}". Run \`yarn prisma:seed\` first.`,
    );
  }

  const units = await prisma.orgUnit.findMany({
    where: { companyId: company.id },
    select: { id: true, code: true },
  });
  const unitByCode = new Map(units.map((unit) => [unit.code, unit.id]));

  const profileIds = new Map<string, string>();
  let created = 0;

  for (const user of UAT_USERS) {
    const orgUnitId = unitByCode.get(user.orgUnitCode);
    if (!orgUnitId) {
      throw new Error(
        `Org unit "${user.orgUnitCode}" is missing. Run \`yarn prisma:seed\` first.`,
      );
    }

    const account = await ensureKeycloakUser(keycloak, {
      username: user.username,
      email: `${user.username}@uat.local`,
      firstName: user.firstName,
      lastName: user.lastName,
    });
    await grantRealmRole(keycloak, account.id, user.role);

    const profileId = await upsertProfile(
      prisma,
      {
        username: user.username,
        displayName: user.displayName,
        firstName: user.firstName,
        lastName: user.lastName,
        email: `${user.username}@uat.local`,
        orgUnitId,
        keycloakRoles: [user.role],
      },
      account.id,
      company.id,
    );
    await grantSystemRole(prisma, profileId, company.id, user.role);

    profileIds.set(user.username, profileId);
    if (account.created) created += 1;

    console.log(
      `  ${user.username} · ${user.role} · ${user.orgUnitCode}` +
        (account.created ? ' (created)' : ' (already in realm)'),
    );
  }

  // Second pass: a supervisor may not have had a row yet on the first.
  for (const user of UAT_USERS) {
    const profileId = profileIds.get(user.username);
    if (!profileId) continue;

    const supervisorId = user.supervisor
      ? (profileIds.get(user.supervisor) ?? null)
      : null;

    await prisma.user.update({
      where: { id: profileId },
      data: { supervisorUserId: supervisorId },
    });

    if (user.managesUnit) {
      const orgUnitId = unitByCode.get(user.orgUnitCode);
      if (orgUnitId) {
        await prisma.orgUnit.update({
          where: { id: orgUnitId },
          data: { managerUserId: profileId },
        });
      }
    }
  }

  await prisma.auditLog.create({
    data: {
      eventType: 'user.provisioned',
      companyId: company.id,
      actorUsername: 'uat:users (cli)',
      resourceType: 'user',
      resourceId: 'uat-set',
      after: {
        usernames: UAT_USERS.map((user) => user.username),
        created,
        company: COMPANY_CODE,
      } as Prisma.InputJsonValue,
    },
  });

  printSummary();
}

function printSummary(): void {
  console.log('\nสรุปผู้ใช้ UAT');
  console.log('username        role                 สังกัด    หัวหน้า        หน้าที่ในการทดสอบ');

  for (const user of UAT_USERS) {
    console.log(
      `  ${user.username.padEnd(14)}${user.role.padEnd(21)}` +
        `${user.orgUnitCode.padEnd(10)}${(user.supervisor ?? '—').padEnd(15)}${user.purpose}`,
    );
  }

  console.log(
    '\nทุกบัญชีใช้รหัสผ่านจาก UAT_DEFAULT_PASSWORD และเข้าสู่ระบบได้ทันที',
  );
}

main()
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
