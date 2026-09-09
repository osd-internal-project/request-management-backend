import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@request-management/share';

export function formatDealCode(docPrefix: string, seq: number): string {
  return `DL-${docPrefix}-${String(seq).padStart(6, '0')}`;
}

/**
 * Issues the deal code at create — the same atomic
 * INSERT … ON CONFLICT … RETURNING guarantee as `CustomerCodeService`,
 * because requests reference deals by this code (`ref_type=deal`).
 */
@Injectable()
export class DealCodeService {
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
      INSERT INTO "deal_code_counters" ("id", "companyId", "lastSeq", "updatedAt")
      VALUES (gen_random_uuid(), ${companyId}, 1, NOW())
      ON CONFLICT ("companyId")
      DO UPDATE SET "lastSeq" = "deal_code_counters"."lastSeq" + 1, "updatedAt" = NOW()
      RETURNING "lastSeq"
    `;

    return formatDealCode(company?.docPrefix ?? 'CTD', rows[0].lastSeq);
  }
}
