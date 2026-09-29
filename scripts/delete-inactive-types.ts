import { PrismaService } from '@request-management/share';
import { RequestsService } from '../services/core-service/src/requests/requests.service';
import {
  bootRequestsContext,
  describeError,
  isApply,
  maskedDatabaseTarget,
  scriptPrincipal,
} from './request-type-script-context';

/**
 * Deletes every request type with `active = false` through `deleteType`, whose
 * `REQ_TYPE_IN_USE` guard skips types still referenced. Dry-run unless `--apply`.
 */
async function main() {
  const apply = isApply(process.argv.slice(2));
  console.log(`DB: ${maskedDatabaseTarget()} | mode: ${apply ? 'APPLY' : 'dry-run'}`);

  const app = await bootRequestsContext();
  try {
    const prisma = app.get(PrismaService);
    const requests = app.get(RequestsService);
    const actor = await scriptPrincipal(app, 'types-delete-inactive');

    const types = await prisma.requestType.findMany({
      where: { active: false },
      select: {
        code: true,
        name: true,
        _count: { select: { requests: true, flowVersions: true } },
      },
      orderBy: { code: 'asc' },
    });

    const counts = { deleted: 0, skipped: 0 };
    for (const type of types) {
      const label = `${type.code} ${type.name}`;
      // deleteType does not check flow versions; the FK is RESTRICT, so skip them here.
      if (type._count.flowVersions) {
        counts.skipped += 1;
        console.log(`SKIP     ${label}: flow versions ${type._count.flowVersions}`);
        continue;
      }
      if (!apply) {
        if (type._count.requests) {
          counts.skipped += 1;
          console.log(`SKIP     ${label}: requests ${type._count.requests}`);
        } else {
          counts.deleted += 1;
          console.log(`WOULD    ${label}`);
        }
        continue;
      }

      try {
        await requests.deleteType(type.code, actor);
        counts.deleted += 1;
        console.log(`DELETE   ${label}`);
      } catch (error) {
        counts.skipped += 1;
        console.log(`SKIP     ${label}: ${describeError(error)}`);
      }
    }

    console.log(
      `\ninactive ${types.length} / ${apply ? 'deleted' : 'would delete'} ${counts.deleted} / skipped ${counts.skipped}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
