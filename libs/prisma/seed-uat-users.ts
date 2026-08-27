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

const prisma = new PrismaClient();

/** The company whose org tree `seed.ts` populates. */
const COMPANY_CODE = 'OSD';

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

interface Env {
  readonly baseUrl: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly password: string;
}

function readEnv(): Env {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to create test accounts in production.');
  }
  if (process.env.UAT_SEED_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without UAT_SEED_ALLOW=1.\n' +
        'This creates real, sign-in-able accounts in the shared realm. Re-run as:\n' +
        '  UAT_SEED_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn uat:users',
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

async function adminToken(env: Env): Promise<string> {
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

interface KeycloakContext {
  readonly base: string;
  readonly headers: Record<string, string>;
  readonly password: string;
}

/** Finds the account, creating it only when the realm does not have it. */
async function ensureKeycloakUser(
  keycloak: KeycloakContext,
  user: UatUser,
): Promise<{ id: string; created: boolean }> {
  const existing = await findByUsername(keycloak, user.username);
  if (existing) return { id: existing, created: false };

  const response = await fetch(`${keycloak.base}/users`, {
    method: 'POST',
    headers: keycloak.headers,
    body: JSON.stringify({
      username: user.username,
      email: `${user.username}@uat.local`,
      firstName: user.firstName,
      lastName: user.lastName,
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
      `Could not create "${user.username}" (HTTP ${response.status}). ` +
        'The service account needs the realm-management role manage-users.',
    );
  }

  const id = await findByUsername(keycloak, user.username);
  if (!id) {
    throw new Error(
      `Created "${user.username}" but could not read it back from the realm.`,
    );
  }

  return { id, created: response.ok };
}

async function findByUsername(
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

async function grantRealmRole(
  keycloak: KeycloakContext,
  userId: string,
  roleName: string,
): Promise<void> {
  const response = await fetch(`${keycloak.base}/roles/${encodeURIComponent(roleName)}`, {
    headers: keycloak.headers,
  });

  if (!response.ok) {
    throw new Error(
      `Realm role "${roleName}" does not exist. Run \`yarn keycloak:provision\` first.`,
    );
  }

  const role = (await response.json()) as { id: string; name: string };

  const granted = await fetch(`${keycloak.base}/users/${userId}/role-mappings/realm`, {
    method: 'POST',
    headers: keycloak.headers,
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });

  if (!granted.ok && granted.status !== 409) {
    throw new Error(
      `Could not grant "${roleName}" to ${userId} (HTTP ${granted.status}).`,
    );
  }
}

/**
 * Writes the local profile and its company membership.
 *
 * Matched on `keycloakId` rather than username, because that is the identity
 * the token carries and what `PrincipalService.provision` will match on at
 * first sign-in — matching on username instead would create a second row.
 */
async function upsertProfile(
  user: UatUser,
  keycloakId: string,
  companyId: string,
  orgUnitId: string,
): Promise<string> {
  const profile = await prisma.user.upsert({
    where: { keycloakId },
    update: {
      username: user.username,
      displayName: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      keycloakRoles: [user.role],
      primaryCompanyId: companyId,
      orgUnitId,
    },
    create: {
      keycloakId,
      username: user.username,
      email: `${user.username}@uat.local`,
      displayName: user.displayName,
      firstName: user.firstName,
      lastName: user.lastName,
      keycloakRoles: [user.role],
      primaryCompanyId: companyId,
      orgUnitId,
    },
  });

  await prisma.userCompany.upsert({
    where: { userId_companyId: { userId: profile.id, companyId } },
    update: { isPrimary: true },
    create: { userId: profile.id, companyId, isPrimary: true },
  });

  return profile.id;
}

/**
 * Grants the system role matching the realm role.
 *
 * `MANUAL` so the placement works before the first sign-in — and survives it.
 * `replaceMappedRoles` rewrites only `KEYCLOAK_MAPPING` rows on every login, so
 * the mapped copy it adds later sits alongside this one harmlessly.
 */
async function grantSystemRole(
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

async function main(): Promise<void> {
  const env = readEnv();
  console.log(`Provisioning UAT accounts in realm "${env.realm}"…`);

  const token = await adminToken(env);
  const keycloak: KeycloakContext = {
    base: `${env.baseUrl}/admin/realms/${env.realm}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    password: env.password,
  };

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

    const account = await ensureKeycloakUser(keycloak, user);
    await grantRealmRole(keycloak, account.id, user.role);

    const profileId = await upsertProfile(
      user,
      account.id,
      company.id,
      orgUnitId,
    );
    await grantSystemRole(profileId, company.id, user.role);

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
