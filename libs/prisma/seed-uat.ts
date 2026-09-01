/**
 * Create the UAT-only `uat_superadmin` role and grant it to one account.
 *
 *   UAT_SEED_ALLOW=1 yarn uat:seed [username]      # default: uatadmin
 *
 * The role holds **every** permission in the catalog and scope `company` on
 * every resource, so a single UAT account can open every screen and see every
 * row **of the company it is currently looking at** — the header switcher moves
 * between companies. See `SCOPE_LEVEL` below for why it is not `all`.
 *
 * That combination is a deliberate, declared breach of §5.4: the guardrail in
 * `assertSeparationOfDuties` refuses a role that holds `admin.*` together with
 * `approval.decide` or `request.sensitive.read`. It is contained rather than
 * excused —
 *
 *   - the guardrail itself is untouched, so no API path can produce this role,
 *     and re-saving it from the Roles screen answers 422 (that is intended)
 *   - this script writes Prisma directly and refuses to run in production
 *   - the role must not exist in a production database
 *
 * See open question L in docs/open-questions.md.
 *
 * Idempotent — safe to re-run.
 */
import { PrismaClient, Prisma, ScopeLevel } from '@prisma/client';

const prisma = new PrismaClient();

const ROLE_CODE = 'uat_superadmin';
const DEFAULT_USERNAME = 'uatadmin';

/** Resources §6.1 scopes. */
const SCOPED_RESOURCES = ['request', 'approval_case', 'user'] as const;

/**
 * `company`, not `all` (28 Aug 2026).
 *
 * `all` was the one level that did not pin a query to a company, so every list
 * this account opened mixed rows from every company at once and the company
 * switcher in the header did nothing. `company` makes the switcher the way to
 * move between them, which is what the screen already implies.
 *
 * **Inert since 31 Aug 2026.** The scope levels were withdrawn; what this
 * account actually reads now comes from the `request.read.all` permission,
 * which it holds because this script grants every permission in the catalog.
 * The rows are still written so the (hidden) Scope Rules screen has data if it
 * is ever brought back.
 */
const SCOPE_LEVEL: ScopeLevel = 'company';

/**
 * AUTH-06 scopes a service account per client and gives it its permissions
 * directly; granting these to a human role would let a person call the
 * integration endpoints as if they were an external system.
 */
const EXCLUDED_PREFIX = 'integration.';

function assertNonProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `${ROLE_CODE} must never exist in production — it breaks the §5.4 ` +
        'separation-of-duties guardrail by design. Refusing to run.',
    );
  }

  if (process.env.UAT_SEED_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without UAT_SEED_ALLOW=1.\n' +
        `This creates a role holding every permission at scope "all". Re-run as:\n` +
        '  UAT_SEED_ALLOW=1 yarn uat:seed',
    );
  }
}

/**
 * Every permission code, read from the database rather than a fourth copy of
 * the catalog. The `permissions` table syncs from `libs/share` at service boot,
 * which makes it the one list that cannot drift from what endpoints declare.
 */
async function permissionCodes(): Promise<string[]> {
  const rows = await prisma.permission.findMany({ select: { code: true } });
  const codes = rows
    .map((row) => row.code)
    .filter((code) => !code.startsWith(EXCLUDED_PREFIX));

  if (!codes.length) {
    throw new Error(
      'The permissions table is empty. Run `yarn prisma:seed` and start\n' +
        'user-service once so the catalog syncs, then re-run this.',
    );
  }

  return codes;
}

async function seedRole(
  companyId: string,
  codes: readonly string[],
): Promise<string> {
  const role = await prisma.role.upsert({
    where: { companyId_code: { companyId, code: ROLE_CODE } },
    update: {
      name: 'ผู้ดูแล UAT (ทุกสิทธิ์)',
      description:
        'บทบาทสำหรับทดสอบ UAT เท่านั้น — ถือทุกสิทธิ์และเห็นทุกข้อมูล ห้ามมีใน production',
      isSystem: true,
    },
    create: {
      companyId,
      code: ROLE_CODE,
      name: 'ผู้ดูแล UAT (ทุกสิทธิ์)',
      description:
        'บทบาทสำหรับทดสอบ UAT เท่านั้น — ถือทุกสิทธิ์และเห็นทุกข้อมูล ห้ามมีใน production',
      isSystem: true,
    },
  });

  // Replaced rather than merged, the same way `seedRoles` does it, so a
  // permission removed from the catalog does not linger on this role.
  await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
  await prisma.rolePermission.createMany({
    data: codes.map((permissionCode) => ({ roleId: role.id, permissionCode })),
    skipDuplicates: true,
  });

  for (const resource of SCOPED_RESOURCES) {
    await prisma.scopeRule.upsert({
      where: { roleId_resource: { roleId: role.id, resource } },
      update: { scope: SCOPE_LEVEL },
      create: { roleId: role.id, resource, scope: SCOPE_LEVEL },
    });
  }

  return role.id;
}

async function main(username: string): Promise<void> {
  assertNonProduction();

  const codes = await permissionCodes();
  const companies = await prisma.company.findMany({
    where: { active: true },
    orderBy: { code: 'asc' },
  });

  if (!companies.length) {
    throw new Error('No active companies. Run `yarn prisma:seed` first.');
  }

  const user = await prisma.user.findUnique({ where: { username } });

  if (!user) {
    throw new Error(
      `No local profile for "${username}".\n` +
        'They must sign in once first — profiles are created from the token on\n' +
        'first login (AUTH-04). Alternatively run `yarn uat:users`, which\n' +
        'provisions the UAT accounts in Keycloak and writes their profiles.',
    );
  }

  const granted: string[] = [];

  for (const company of companies) {
    const roleId = await seedRole(company.id, codes);

    await prisma.userRole.upsert({
      where: {
        userId_roleId_companyId: {
          userId: user.id,
          roleId,
          companyId: company.id,
        },
      },
      update: {},
      // MANUAL, not KEYCLOAK_MAPPING: `replaceMappedRoles` rewrites only mapped
      // grants on every login, so a mapped grant here would vanish at the next
      // sign-in.
      create: {
        userId: user.id,
        roleId,
        companyId: company.id,
        source: 'MANUAL',
      },
    });

    // The user must be a member of a company to have an active one to resolve
    // roles against; without this the principal comes back "pending".
    await prisma.userCompany.upsert({
      where: { userId_companyId: { userId: user.id, companyId: company.id } },
      update: {},
      create: {
        userId: user.id,
        companyId: company.id,
        isPrimary: company.id === companies[0].id,
      },
    });

    granted.push(company.code);
  }

  await prisma.auditLog.create({
    data: {
      eventType: 'role.granted',
      companyId: companies[0].id,
      actorUsername: 'uat:seed (cli)',
      resourceType: 'user',
      resourceId: user.id,
      after: {
        username,
        role: ROLE_CODE,
        companies: granted,
        permissions: codes.length,
        note: 'UAT only — declared §5.4 exception, see open question L',
      } as Prisma.InputJsonValue,
    },
  });

  console.log(`  role ${ROLE_CODE}: ${codes.length} permissions, scope ${SCOPE_LEVEL}`);
  console.log(`  ${username} → ${ROLE_CODE} in ${granted.join(', ')}`);
  console.log('  reminder: this role breaks §5.4 on purpose. Not for production.');
}

main(process.argv[2] ?? DEFAULT_USERNAME)
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
