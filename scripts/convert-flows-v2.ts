import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PrismaService } from '@request-management/share';
import { PublishFlowDto } from '../services/core-service/src/requests/dto/request.dto';
import { RequestFlowAdminService } from '../services/core-service/src/requests/request-flow-admin.service';
import {
  bootRequestsContext,
  describeError,
  isApply,
  maskedDatabaseTarget,
  scriptPrincipal,
} from './request-type-script-context';

/**
 * Publishes the suggested v2 flow for each active type × company not yet on v2. Dry-run unless `--apply`.
 */
async function main() {
  const apply = isApply(process.argv.slice(2));
  console.log(`DB: ${maskedDatabaseTarget()} | mode: ${apply ? 'APPLY' : 'dry-run'}`);

  const app = await bootRequestsContext();
  try {
    const prisma = app.get(PrismaService);
    const flows = app.get(RequestFlowAdminService);
    const actor = await scriptPrincipal(app, 'flows-convert-v2');

    const pairs = await prisma.requestTypeCompany.findMany({
      where: { active: true, requestType: { active: true } },
      select: {
        companyId: true,
        company: { select: { code: true } },
        requestType: { select: { id: true, code: true } },
      },
      orderBy: [{ requestType: { code: 'asc' } }, { companyId: 'asc' }],
    });

    const counts = { converted: 0, skipped: 0, failed: 0 };
    for (const pair of pairs) {
      const label = `${pair.requestType.code} @ ${pair.company.code}`;
      const latest = await prisma.requestFlowVersion.findFirst({
        where: { companyId: pair.companyId, requestTypeId: pair.requestType.id },
        orderBy: { version: 'desc' },
        select: { version: true, schemaVersion: true },
      });
      const current = latest ? `v${latest.schemaVersion} #${latest.version}` : 'legacy';

      if (latest?.schemaVersion === 2) {
        counts.skipped += 1;
        console.log(`SKIP     ${label} (${current})`);
        continue;
      }

      try {
        const suggested = await flows.suggested(pair.requestType.code, actor, pair.companyId);
        const dto = plainToInstance(PublishFlowDto, { ...suggested, company_id: pair.companyId });
        const errors = await validate(dto, { whitelist: true });
        if (errors.length) throw new Error(`DTO invalid: ${errors.map(String).join('; ')}`);

        const steps = dto.steps.map((step) => step.code).join(' → ');
        if (apply) {
          const published = await flows.publish(pair.requestType.code, dto, actor);
          console.log(`CONVERT  ${label} (${current} → v2 #${published?.version}) ${steps}`);
        } else {
          console.log(`WOULD    ${label} (${current} → v2) ${steps}`);
        }
        counts.converted += 1;
      } catch (error) {
        counts.failed += 1;
        console.log(`FAIL     ${label}: ${describeError(error)}`);
      }
    }

    console.log(
      `\n${apply ? 'converted' : 'would convert'} ${counts.converted} / skipped ${counts.skipped} / failed ${counts.failed}`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
