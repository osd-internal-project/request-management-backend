/**
 * Empty one company's org chart, leaving every person unassigned.
 *
 *   ORG_CLEAR_ALLOW=1 yarn org:clear OSD [--keep=alice,bob]
 *
 * OSD's chart was imported from the HR register (`import-osd-catalog.ts`) and
 * has to be rebuilt from scratch. Doing that by hand from screen A3 is not
 * practical — the real chart is forty-odd units — and there is no delete route
 * in the API on purpose, so this writes Prisma directly.
 *
 * **What it deliberately does not do.**
 *
 * The company's root unit stays, and so does every account named by `--keep`
 * (plus `uatadmin`, always). Without that the whole company would be locked
 * out, not merely unassigned: `pendingOrgAssignment` is `orgUnitId === null`
 * (`principal.service.ts`), and the landing page renders `PendingAssignment`
 * instead of itself for anyone carrying that flag. An administrator who cannot
 * open the app cannot rebuild the chart either.
 *
 * `Request.requesterOrgUnitId` is left alone. It records where a request sat
 * when it was raised; clearing it would rewrite history rather than the chart.
 *
 * **Known consequence, accepted.** With nobody holding a supervisor, any
 * request type whose published approval matrix resolves a rung through the org
 * chart cannot be submitted — `assertStepOneResolvable` answers
 * `ORG_SUPERVISOR_MISSING`. Types with no published matrix, and ladders whose
 * rungs name people outright (`resolve: 'user'`), are unaffected.
 *
 * To rebuild OSD's chart afterwards:
 *
 *   OSD_IMPORT_ALLOW=1 yarn data:import-catalog
 *
 * Idempotent — safe to re-run.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

/** Never unassigned: this account has to stay able to open the admin screens. */
const ALWAYS_KEEP = 'uatadmin';

interface Options {
  companyCode: string;
  keep: string[];
}

function assertNonProduction(companyCode: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run in production. This deletes an entire org chart.',
    );
  }

  if (process.env.ORG_CLEAR_ALLOW !== '1') {
    throw new Error(
      'Refusing to run without ORG_CLEAR_ALLOW=1.\n' +
        'This deletes every org unit of a company and unassigns its people. Re-run as:\n' +
        `  ORG_CLEAR_ALLOW=1 yarn org:clear ${companyCode || '<COMPANY_CODE>'}`,
    );
  }
}

function parseArgs(argv: readonly string[]): Options {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const companyCode = positional[0];

  if (!companyCode) {
    throw new Error(
      'Company code is required — there is no default, on purpose.\n' +
        '  ORG_CLEAR_ALLOW=1 yarn org:clear OSD',
    );
  }

  const keepArg = argv.find((arg) => arg.startsWith('--keep='));
  const extra = (keepArg?.slice('--keep='.length) ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  return { companyCode, keep: [...new Set([ALWAYS_KEEP, ...extra])] };
}

/**
 * The unit everything else hangs off. Preferred by code, because that is what
 * both the seed and the OSD importer create; otherwise the only parentless
 * unit, and an ambiguous chart is refused rather than guessed at.
 */
async function findRoot(companyId: string) {
  const byCode = await prisma.orgUnit.findFirst({
    where: { companyId, code: 'ROOT' },
  });

  if (byCode) return byCode;

  const roots = await prisma.orgUnit.findMany({
    where: { companyId, parentId: null },
  });

  if (roots.length === 1) return roots[0];

  throw new Error(
    roots.length
      ? `Found ${roots.length} root units and no unit coded ROOT. Refusing to ` +
        'guess which one to keep — code one of them ROOT and re-run.'
      : 'This company has no org units at all; there is nothing to clear.',
  );
}

async function main(argv: readonly string[]): Promise<void> {
  const { companyCode, keep } = parseArgs(argv);
  assertNonProduction(companyCode);

  const company = await prisma.company.findUnique({
    where: { code: companyCode },
  });

  if (!company) {
    const known = await prisma.company.findMany({ select: { code: true } });
    throw new Error(
      `No company with code "${companyCode}". Known codes: ` +
        known.map((row) => row.code).join(', '),
    );
  }

  const root = await findRoot(company.id);

  /*
    Exactly the people sitting in *this* chart — not everyone with a membership
    row for the company.

    The distinction is not academic. `uatadmin` is a member of all four
    companies while sitting in OSD_DEMO's root; selecting on membership would
    have pulled it out of that chart and into this one, changing where an
    account lives in a company nobody asked to touch. Clearing OSD's chart has
    exactly one job: leave no user in an OSD unit.
  */
  const inThisChart: Prisma.UserWhereInput = {
    orgUnit: { companyId: company.id },
  };

  const report = await prisma.$transaction(
    async (tx) => {
      const kept = await tx.user.findMany({
        where: { AND: [inThisChart, { username: { in: keep } }] },
        select: { id: true, username: true },
      });

      const detached = await tx.user.updateMany({
        where: { AND: [inThisChart, { username: { notIn: keep } }] },
        data: { orgUnitId: null, supervisorUserId: null },
      });

      // Kept accounts move to the root rather than staying where they were:
      // the unit they sat in is about to be deleted.
      await tx.user.updateMany({
        where: { id: { in: kept.map((user) => user.id) } },
        data: { orgUnitId: root.id, supervisorUserId: null },
      });

      // A unit cannot be deleted while it names a manager who may themselves
      // be about to be detached, and the root keeps no lead either.
      await tx.orgUnit.updateMany({
        where: { companyId: company.id },
        data: { managerUserId: null },
      });

      const types = await tx.requestType.updateMany({
        where: {
          companies: { some: { companyId: company.id } },
          receiverOrgUnitId: { not: null },
        },
        data: { receiverOrgUnitId: null },
      });

      // Cascade takes these with the units; counted first so the report can
      // say so rather than letting dashboards lose their audience silently.
      const audiences = await tx.biDashboardAudience.count({
        where: { orgUnit: { companyId: company.id }, orgUnitId: { not: root.id } },
      });

      const units = await tx.orgUnit.deleteMany({
        where: { companyId: company.id, id: { not: root.id } },
      });

      // `org_closure` cascades away with the units. The root's own row is the
      // whole remaining closure, and `scopeSetsFor` reads it on every request.
      await tx.orgClosure.upsert({
        where: {
          ancestorId_descendantId: {
            ancestorId: root.id,
            descendantId: root.id,
          },
        },
        update: { depth: 0 },
        create: { ancestorId: root.id, descendantId: root.id, depth: 0 },
      });

      await tx.auditLog.create({
        data: {
          eventType: 'org.chart.cleared',
          companyId: company.id,
          actorUsername: 'org:clear (cli)',
          resourceType: 'company',
          resourceId: company.id,
          after: {
            unitsDeleted: units.count,
            usersDetached: detached.count,
            requestTypesCleared: types.count,
            dashboardAudiencesRemoved: audiences,
            keptInRoot: kept.map((user) => user.username),
            rootUnit: { id: root.id, code: root.code, name: root.name },
          } as Prisma.InputJsonValue,
        },
      });

      const stillPlacedAnywhere = await tx.user.count({
        where: { orgUnitId: { not: null }, status: 'ACTIVE' },
      });

      return {
        stillPlacedAnywhere,
        unitsDeleted: units.count,
        usersDetached: detached.count,
        requestTypesCleared: types.count,
        dashboardAudiencesRemoved: audiences,
        kept,
        root,
      };
    },
    { timeout: 60_000 },
  );

  console.log(`\nล้างผังทีมของบริษัท ${company.code}`);
  console.log(`  หน่วยงานที่ลบ              ${report.unitsDeleted}`);
  console.log(`  ผู้ใช้ที่ถอดสังกัด           ${report.usersDetached}`);
  console.log(`  ประเภทคำขอที่ล้างทีมผู้รับ    ${report.requestTypesCleared}`);
  console.log(`  audience ของ dashboard    ${report.dashboardAudiencesRemoved}`);
  console.log(
    `  หน่วยงานที่เหลือ            ${report.root.code} (${report.root.name})`,
  );
  console.log(
    `  บัญชีที่คงไว้ใน ${report.root.code}       ` +
      (report.kept.map((user) => user.username).join(', ') ||
        '— ไม่มีบัญชีใน keep-list อยู่ในผังนี้'),
  );
  console.log(`  ผู้ใช้ที่ยังมีสังกัด (ทั้งระบบ)  ${report.stillPlacedAnywhere}`);

  /*
    An admin account placed in another company's chart is unaffected and still
    opens the app — `pendingOrgAssignment` reads the user's org unit, not the
    company being looked at. It is only when nobody anywhere holds a unit that
    every screen turns into "รอจัดสังกัด".
  */
  if (!report.stillPlacedAnywhere) {
    console.warn(
      `\n  คำเตือน: ตอนนี้ไม่มีผู้ใช้คนใดในระบบมีสังกัดเลย\n` +
        '  ทุกบัญชีจะเห็นหน้า "รอจัดสังกัด" แทนหน้าแรก และไม่มีใครแก้ผังได้\n' +
        '  แก้ด้วย: yarn prisma:seed แล้ว UAT_SEED_ALLOW=1 yarn uat:seed',
    );
  }

  console.log(
    '\n  สร้างผังใหม่จากทะเบียนบุคลากร: OSD_IMPORT_ALLOW=1 yarn data:import-catalog',
  );
}

main(process.argv.slice(2))
  .then(() => console.log('Done.'))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
