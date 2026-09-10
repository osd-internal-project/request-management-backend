import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@request-management/share';

export function formatOpportunityCode(docPrefix: string, seq: number): string {
  return `OPP-${docPrefix}-${String(seq).padStart(6, '0')}`;
}

/**
 * Issues the opportunity code at create — the same atomic
 * INSERT … ON CONFLICT … RETURNING guarantee as `CustomerCodeService`,
 * because requests reference opportunities by this code (`ref_type=opportunity`).
 */
@Injectable()
export class OpportunityCodeService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    companyId: string,
    prisma: Prisma.TransactionClient,
  ): Promise<string> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { docPrefix: true },
    });

    const rows = await prisma.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO "opportunity_code_counters" ("id", "companyId", "lastSeq", "updatedAt")
      VALUES (gen_random_uuid(), ${companyId}, 1, NOW())
      ON CONFLICT ("companyId")
      DO UPDATE SET "lastSeq" = "opportunity_code_counters"."lastSeq" + 1, "updatedAt" = NOW()
      RETURNING "lastSeq"
    `;

    return formatOpportunityCode(company?.docPrefix ?? 'CTD', rows[0].lastSeq);
  }
}
