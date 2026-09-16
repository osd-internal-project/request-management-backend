/**
 * Provision the Keycloak realm roles this system expects, and map them to its
 * own roles.
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
 * Scope note: this touches realm **roles** only. The org tree lives in this
 * database (D-08), so Keycloak groups are deliberately neither read nor
 * written — including the existing `บริษัท OSD` group, whose fate is an open
 * question.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Matches the §5.2 seed roles in seed.ts, by code. */
const REALM_ROLES: { name: string; description: string }[] = [
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

/**
 * AUTH-06 scopes a service account **per client**, and a service account has
 * no company membership to resolve roles against — so its Keycloak roles are
 * its permissions directly. These are named after the permission they grant.
 *
 * Granted to this client's own service account, which is what lets an
 * integration raise a request or an approval case and nothing else.
 */
const INTEGRATION_ROLES = [
  {
    name: 'integration.request.create',
    description: 'ระบบภายนอกยื่นคำขอ (REQ-10)',
  },
  {
    name: 'integration.approval.create',
    description: 'ระบบภายนอกเปิดเคสอนุมัติ (APV-07)',
  },
  {
    name: 'integration.crm.lead.read',
    description: 'workflow engine อ่านข้อเท็จจริงของ Lead (lwf-0001)',
  },
  {
    name: 'integration.crm.lead.stage',
    description: 'workflow engine บันทึกขั้นที่ตัดสินใจแล้วกลับมาที่ Lead',
  },
  {
    name: 'integration.crm.lead.create',
    description: 'ช่องทางภายนอกยิง Lead เข้ากองกลาง (เว็บฟอร์ม / LINE OA)',
  },
  {
    name: 'integration.crm.customer.read',
    description: 'ระบบภายนอกอ่านทะเบียนลูกค้าผ่าน external-service',
  },
  {
    name: 'integration.crm.customer.manage',
    description: 'ระบบภายนอกแก้ทะเบียนลูกค้าผ่าน external-service',
  },
  {
    name: 'integration.crm.sales.read',
    description: 'ระบบภายนอกอ่าน Lead / Opportunity / ใบเสนอราคา',
  },
  {
    name: 'integration.crm.sales.manage',
    description: 'ระบบภายนอกแก้ Lead / Opportunity / ใบเสนอราคา',
  },
  {
    name: 'integration.crm.admin.manage',
    description: 'ระบบภายนอกอ่าน/แก้หน้าตั้งค่า CRM',
  },
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

async function createRealmRoles(env: Env, token: string): Promise<void> {
  const base = `${env.baseUrl}/admin/realms/${env.realm}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  const existingResponse = await fetch(`${base}/roles`, { headers });

  if (existingResponse.status === 403) {
    throw new Error(
      'The service account authenticated but the Admin API refused it (403).\n' +
        'Grant it these realm-management roles: view-users, query-users,\n' +
        'query-groups, manage-users, view-realm, manage-realm,\n' +
        'query-clients, view-clients.',
    );
  }
  if (!existingResponse.ok) {
    throw new Error(`Could not list realm roles (HTTP ${existingResponse.status}).`);
  }

  const existing = (await existingResponse.json()) as { name: string }[];
  const have = new Set(existing.map((role) => role.name));

  // The §5.2 system roles and the two §8.1 approval offices, plus the
  // integration scopes AUTH-06 grants to the service account rather than to
  // any person.
  const wanted = [...REALM_ROLES, ...INTEGRATION_ROLES];

  let created = 0;
  for (const role of wanted) {
    if (have.has(role.name)) continue;

    const response = await fetch(`${base}/roles`, {
      method: 'POST',
      headers,
      body: JSON.stringify(role),
    });

    // 409 means someone created it between the list and now — still fine.
    if (!response.ok && response.status !== 409) {
      throw new Error(
        `Could not create realm role "${role.name}" (HTTP ${response.status}).`,
      );
    }
    created += 1;
  }

  console.log(
    `  realm roles: ${created} created, ${wanted.length - created} already present`,
  );

  await grantIntegrationRoles(env, token, headers, base);
}

/**
 * Gives this client's own service account the integration permissions.
 *
 * Without it the integration endpoints answer 403 for the only kind of caller
 * they accept — which looks like a broken deployment rather than a missing
 * grant.
 */
async function grantIntegrationRoles(
  env: Env,
  token: string,
  headers: Record<string, string>,
  base: string,
): Promise<void> {
  const clientResponse = await fetch(
    `${base}/clients?clientId=${encodeURIComponent(env.clientId)}`,
    { headers },
  );
  if (!clientResponse.ok) {
    throw new Error(
      `Could not look up client "${env.clientId}" (HTTP ${clientResponse.status}).`,
    );
  }

  const clients = (await clientResponse.json()) as { id: string }[];

  if (!clients.length) {
    // An empty list here usually means missing `query-clients`/`view-clients`
    // rather than a missing client — the Admin API filters rather than 403s,
    // which is why this says both.
    throw new Error(
      `Client "${env.clientId}" not visible to the service account.\n` +
        'Either KEYCLOAK_CLIENT_ID is wrong, or the service account is missing\n' +
        'the realm-management roles query-clients and view-clients.',
    );
  }

  const saResponse = await fetch(
    `${base}/clients/${clients[0].id}/service-account-user`,
    { headers },
  );
  if (!saResponse.ok) {
    console.log('  integration roles: no service account on this client');
    return;
  }
  const serviceAccount = (await saResponse.json()) as { id: string };

  const rolesResponse = await fetch(`${base}/roles`, { headers });
  const allRoles = (await rolesResponse.json()) as {
    id: string;
    name: string;
  }[];
  const grant = allRoles.filter((role) =>
    INTEGRATION_ROLES.some((wanted) => wanted.name === role.name),
  );

  const response = await fetch(
    `${base}/users/${serviceAccount.id}/role-mappings/realm`,
    { method: 'POST', headers, body: JSON.stringify(grant) },
  );

  if (!response.ok && response.status !== 409) {
    throw new Error(
      `Could not grant integration roles to the service account (HTTP ${response.status}).`,
    );
  }

  console.log(
    `  integration roles: granted to service-account-${env.clientId}`,
  );
}

/**
 * Map each realm role to the system role of the same code, per company.
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
    for (const realmRole of REALM_ROLES) {
      const role = await prisma.role.findUnique({
        where: { companyId_code: { companyId: company.id, code: realmRole.name } },
      });

      if (!role) {
        missing.push(`${realmRole.name}@${company.code}`);
        continue;
      }

      await prisma.keycloakRoleMapping.upsert({
        where: {
          keycloakRole_roleId_companyId: {
            keycloakRole: realmRole.name,
            roleId: role.id,
            companyId: company.id,
          },
        },
        update: {},
        create: {
          keycloakRole: realmRole.name,
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
  await createRealmRoles(env, token);
  await mapRolesToSystemRoles();

  console.log('Done. A user holding a realm role now resolves to it on login.');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
