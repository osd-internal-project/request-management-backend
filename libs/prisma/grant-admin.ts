/**
 * Bootstrap a user as an administrator of this system.
 *
 *   yarn admin:grant <username>
 *
 * This exists to break a chicken-and-egg: `admin.role.manage` is what lets you
 * grant roles, so the very first admin cannot be created through the admin UI.
 * Idempotent — safe to re-run.
 *
 * The user must have logged in at least once, because profiles are created
 * just-in-time from token claims on first login (AUTH-04). There is
 * deliberately no "create the user" path here: this system never invents
 * identities, Keycloak owns them.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const ADMIN_ROLE_CODE = 'admin';
/** The company whose org tree is seeded, and the unit to place the admin in. */
const PRIMARY_COMPANY_CODE = 'OSD';
const ROOT_ORG_UNIT_CODE = 'ROOT';

async function grantAdmin(username: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { username } });

  if (!user) {
    throw new Error(
      `No local profile for "${username}".\n` +
        `They must sign in once first — profiles are created from the token on\n` +
        `first login (AUTH-04). Log in at http://localhost:3000/login, then re-run this.`,
    );
  }

  const companies = await prisma.company.findMany({
    where: { active: true },
    orderBy: { code: 'asc' },
  });

  if (!companies.length) {
    throw new Error('No active companies. Run `yarn prisma:seed` first.');
  }

  const primary =
    companies.find((company) => company.code === PRIMARY_COMPANY_CODE) ??
    companies[0];

  const rootUnit = await prisma.orgUnit.findUnique({
    where: { companyId_code: { companyId: primary.id, code: ROOT_ORG_UNIT_CODE } },
  });

  await prisma.$transaction(async (tx) => {
    // 1. Company membership, primary on the seeded company.
    for (const company of companies) {
      await tx.userCompany.upsert({
        where: { userId_companyId: { userId: user.id, companyId: company.id } },
        update: { isPrimary: company.id === primary.id },
        create: {
          userId: user.id,
          companyId: company.id,
          isPrimary: company.id === primary.id,
        },
      });
    }

    // 2. Clear the "รอจัดสังกัด" state so they are not stuck behind AUTH-04.
    await tx.user.update({
      where: { id: user.id },
      data: {
        primaryCompanyId: primary.id,
        // Keep an existing placement if an admin already made one.
        orgUnitId: user.orgUnitId ?? rootUnit?.id ?? null,
      },
    });

    // 3. The admin role, per company (ROLE-04 — roles are never global).
    const granted: string[] = [];

    for (const company of companies) {
      const role = await tx.role.findUnique({
        where: { companyId_code: { companyId: company.id, code: ADMIN_ROLE_CODE } },
      });

      if (!role) continue;

      await tx.userRole.upsert({
        where: {
          userId_roleId_companyId: {
            userId: user.id,
            roleId: role.id,
            companyId: company.id,
          },
        },
        update: {},
        create: {
          userId: user.id,
          roleId: role.id,
          companyId: company.id,
          // MANUAL, not KEYCLOAK_MAPPING. `replaceMappedRoles` rewrites only
          // mapped grants on every login, so a mapped grant here would silently
          // disappear the next time this user signs in.
          source: 'MANUAL',
        },
      });

      granted.push(company.code);
    }

    if (!granted.length) {
      throw new Error(
        `No "${ADMIN_ROLE_CODE}" role exists in any company. Run \`yarn prisma:seed\` first.`,
      );
    }

    // 4. The first admin grant is itself auditable (ROLE-05).
    await tx.auditLog.create({
      data: {
        eventType: 'role.granted',
        companyId: primary.id,
        actorUsername: 'admin:grant (cli)',
        resourceType: 'user',
        resourceId: user.id,
        after: {
          username,
          role: ADMIN_ROLE_CODE,
          companies: granted,
        } as Prisma.InputJsonValue,
      },
    });

    console.log(`  ${username} → ${ADMIN_ROLE_CODE} in ${granted.join(', ')}`);
    console.log(`  primary company: ${primary.code}`);
    console.log(
      `  org unit: ${rootUnit ? rootUnit.name : '(none — seed the org tree)'}`,
    );
  });
}

const username = process.argv[2];

if (!username) {
  console.error('Usage: yarn admin:grant <username>');
  process.exit(1);
}

grantAdmin(username)
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
