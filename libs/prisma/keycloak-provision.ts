/**
 * Provision the `request-form` client roles this system expects, and map them
 * to its own roles. Client roles, not realm roles: the realm is shared.
 *
 *   yarn keycloak:provision
 *
 * ROLE-03 says a user's primary role comes from Keycloak, and the mapping table
 * turns that into permissions and data scope here. Both halves start empty, so
 * until this runs a user who is not a bootstrapped admin logs in and resolves
 * to **no roles at all**.
 *
 * Idempotent — safe to run per environment and re-run after a realm change.
 *
 * Scope note: this touches client **roles** only. The org tree lives in this
 * database (D-08), so Keycloak groups are deliberately neither read nor
 * written — including the existing `บริษัท OSD` group, whose fate is an open
 * question.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Matches the §5.2 seed roles in seed.ts, by code. */
const CLIENT_ROLES: { name: string; description: string }[] = [
  { name: 'employee', description: 'พนักงาน — ยื่นคำขอและดูของตัวเอง' },
  { name: 'team_lead', description: 'หัวหน้าทีม — อนุมัติชั้นแรก' },
  { name: 'department_manager', description: 'ผู้จัดการฝ่าย' },
  { name: 'executive', description: 'ผู้บริหาร' },
  { name: 'cfo', description: 'CFO — อนุมัติชั้นที่ 2 (§8.1)' },
  { name: 'ceo', description: 'CEO — อนุมัติชั้นที่ 3 (§8.1)' },
  // §5.2 seeds `receiver` as a system role but this list omitted it, so the
  // destination team resolved to no roles on login and REQ-08 had no holder.
  { name: 'receiver', description: 'ทีมผู้รับคำขอ — ตีกลับและปิดงาน' },
  { name: 'admin', description: 'ผู้ดูแลระบบ' },
  { name: 'auditor', description: 'ผู้ตรวจสอบ — อ่านอย่างเดียว' },
];

interface Env {
  baseUrl: string;
  realm: string;
  clientId: string;
  clientSecret: string;
}

function readEnv(): Env {
  const baseUrl = process.env.KEYCLOAK_BASE_URL;
  const realm = process.env.KEYCLOAK_REALM;
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;

  if (!baseUrl || !realm || !clientId || !clientSecret) {
    throw new Error(
      'Missing Keycloak settings. KEYCLOAK_BASE_URL, KEYCLOAK_REALM,\n' +
        'KEYCLOAK_CLIENT_ID and KEYCLOAK_CLIENT_SECRET must all be set in .env.',
    );
  }

  return { baseUrl, realm, clientId, clientSecret };
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

async function clientRolesUrl(
  env: Env,
  headers: Record<string, string>,
): Promise<string> {
  const base = `${env.baseUrl}/admin/realms/${env.realm}`;
  const response = await fetch(
    `${base}/clients?clientId=${encodeURIComponent(env.clientId)}`,
    { headers },
  );
  if (response.status === 403) {
    throw new Error(
      'The service account authenticated but the Admin API refused it (403).\n' +
        'Grant it these realm-management roles: view-users, query-users,\n' +
        'query-groups, manage-users, view-realm, manage-realm,\n' +
        'query-clients, view-clients.',
    );
  }
  if (!response.ok) {
    throw new Error(`Could not look up client "${env.clientId}" (HTTP ${response.status}).`);
  }
  const clients = (await response.json()) as { id: string; clientId: string }[];
  const client = clients.find((c) => c.clientId === env.clientId);
  if (!client) throw new Error(`Client "${env.clientId}" not found in realm "${env.realm}".`);
  return `${base}/clients/${client.id}/roles`;
}

async function createClientRoles(env: Env, token: string): Promise<void> {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const rolesUrl = await clientRolesUrl(env, headers);

  const existingResponse = await fetch(rolesUrl, { headers });

  if (!existingResponse.ok) {
    throw new Error(`Could not list client roles (HTTP ${existingResponse.status}).`);
  }

  const existing = (await existingResponse.json()) as { name: string }[];
  const have = new Set(existing.map((role) => role.name));

  /*
    §5.2 system roles และตำแหน่งอนุมัติสอง office ตาม §8.1 — ของคนล้วน.

    ไม่มี realm role ของ integration อีกแล้ว: สิทธิ์ของเครื่องอ่านจาก `ApiKey.scopes`
    ใน DB (ดู `RemotePrincipalGuard.permissionsOfKey`) ไม่ใช่จากชื่อ realm role
    การเก็บ permission เป็น role คือสิ่งที่ทำให้กุญแจที่ถือสิทธิ์อยู่แท้ ๆ โดนปฏิเสธ
    เพราะไม่มีใครไปสร้าง role ชื่อนั้นใน realm ให้.
  */
  const wanted = CLIENT_ROLES;

  let created = 0;
  for (const role of wanted) {
    if (have.has(role.name)) continue;

    const response = await fetch(rolesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(role),
    });

    // 409 means someone created it between the list and now — still fine.
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `Could not create client role "${role.name}" (HTTP ${response.status}).`,
      );
    }
    created += 1;
  }

  console.log(
    `  client roles: ${created} created, ${wanted.length - created} already present`,
  );
}

/**
 * Map each client role to the system role of the same code, per company.
 *
 * Per company because ROLE-04 makes role bindings company-scoped: the same
 * Keycloak role has to resolve separately in each company, or a manager in one
 * would silently become a manager in all of them.
 */
async function mapRolesToSystemRoles(): Promise<void> {
  const companies = await prisma.company.findMany({ where: { active: true } });

  if (!companies.length) {
    throw new Error('No active companies. Run `yarn prisma:seed` first.');
  }

  let mapped = 0;
  let missing: string[] = [];

  for (const company of companies) {
    for (const clientRole of CLIENT_ROLES) {
      const role = await prisma.role.findUnique({
        where: { companyId_code: { companyId: company.id, code: clientRole.name } },
      });

      if (!role) {
        missing.push(`${clientRole.name}@${company.code}`);
        continue;
      }

      await prisma.keycloakRoleMapping.upsert({
        where: {
          keycloakRole_roleId_companyId: {
            keycloakRole: clientRole.name,
            roleId: role.id,
            companyId: company.id,
          },
        },
        update: {},
        create: {
          keycloakRole: clientRole.name,
          roleId: role.id,
          companyId: company.id,
          createdBy: 'keycloak:provision',
        },
      });
      mapped += 1;
    }
  }

  console.log(
    `  mappings: ${mapped} across ${companies.map((c) => c.code).join(', ')}`,
  );

  if (missing.length) {
    console.log(
      `  note: no system role for ${missing.join(', ')} — run \`yarn prisma:seed\``,
    );
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  console.log(`Provisioning realm "${env.realm}"…`);

  const token = await adminToken(env);
  await createClientRoles(env, token);
  await mapRolesToSystemRoles();

  console.log('Done. A user holding a client role now resolves to it on login.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
