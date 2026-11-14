/**
 * P4 — fills `requests.requesterOrgUnitId` where it is null or names a unit that no longer
 * exists, from the requester's current unit in the same company. Such a request is reachable
 * only by the people named on it: a head, a role level or a scope grant cannot see it.
 *
 * Dry-run unless `--apply`. Each change writes an audit row holding the old value, so it can be
 * undone; a row already fixed is skipped, so running it twice changes nothing.
 *
 * `DATABASE_URL=… npx ts-node --compiler-options '{"module":"commonjs"}' libs/prisma/backfill-request-units.ts [--apply]`
 */
import { PrismaClient } from '@prisma/client';

const ACTOR = 'requests:backfill-units (cli)';

interface Candidate {
  id: string;
  companyId: string;
  requestNo: string | null;
  oldUnit: string | null;
  newUnit: string;
}

/** Host, port and database only — never the password. */
function describeDatabase(url: string | undefined): string {
  if (!url) return '(DATABASE_URL not set)';
  const at = url.lastIndexOf('@');
  return at === -1 ? '(unparseable DATABASE_URL)' : url.slice(at + 1).split('?')[0];
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`database: ${describeDatabase(process.env.DATABASE_URL)} · mode: ${apply ? 'APPLY' : 'dry-run'}`);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<Candidate[]>`
      SELECT r.id, r."companyId", r."requestNo",
             r."requesterOrgUnitId" AS "oldUnit", u."orgUnitId" AS "newUnit"
      FROM requests r
      JOIN users u ON u.id = r."requesterId"
      JOIN org_units nu ON nu.id = u."orgUnitId" AND nu."companyId" = r."companyId"
      LEFT JOIN org_units ou ON ou.id = r."requesterOrgUnitId"
      WHERE r."requesterOrgUnitId" IS NULL OR ou.id IS NULL
      ORDER BY r."companyId", r."createdAt"`;

    const byCompany = new Map<string, { nulls: number; orphans: number }>();
    for (const row of rows) {
      const tally = byCompany.get(row.companyId) ?? { nulls: 0, orphans: 0 };
      if (row.oldUnit === null) tally.nulls += 1;
      else tally.orphans += 1;
      byCompany.set(row.companyId, tally);
    }
    console.log(`candidates: ${rows.length}`);
    for (const [companyId, tally] of byCompany) {
      console.log(`  ${companyId}  null ${tally.nulls} · deleted unit ${tally.orphans}`);
    }
    for (const row of rows.slice(0, 10)) {
      console.log(`  e.g. ${row.requestNo ?? row.id}: ${row.oldUnit ?? 'null'} → ${row.newUnit}`);
    }

    if (!apply) {
      console.log('dry-run: nothing written. Re-run with --apply to write.');
      return;
    }

    let written = 0;
    for (const row of rows) {
      await prisma.$transaction(async (tx) => {
        // Guarded on the old value: a request fixed since the SELECT is left alone.
        const changed = await tx.request.updateMany({
          where: { id: row.id, companyId: row.companyId, requesterOrgUnitId: row.oldUnit },
          data: { requesterOrgUnitId: row.newUnit },
        });
        if (changed.count === 0) return;
        await tx.auditLog.create({
          data: {
            eventType: 'request.requester_unit.backfilled',
            companyId: row.companyId,
            actorUsername: ACTOR,
            resourceType: 'request',
            resourceId: row.id,
            before: { requesterOrgUnitId: row.oldUnit },
            after: { requesterOrgUnitId: row.newUnit },
          },
        });
        written += 1;
      });
    }
    console.log(`written: ${written} of ${rows.length}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
