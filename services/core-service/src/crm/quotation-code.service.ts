import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

export function formatQuotationNo(docPrefix: string, seq: number): string {
  return `QT-${docPrefix}-${String(seq).padStart(6, '0')}`;
}

/**
 * Issues the quotation number for a new quotation (version 1) — same atomic
 * INSERT … ON CONFLICT … RETURNING as `SaleOrderCodeService`. A revision keeps
 * its number and takes the next `version`; only a new quotation consumes one.
 */
@Injectable()
export class QuotationCodeService {
  async issue(
    companyId: string,
    prisma: Prisma.TransactionClient,
  ): Promise<string> {
    const company = await prisma.company.findUnique({
      where: { id: companyId },
      select: { docPrefix: true },
    });

    const rows = await prisma.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO "quotation_code_counters" ("id", "companyId", "lastSeq", "updatedAt")
      VALUES (gen_random_uuid(), ${companyId}, 1, NOW())
      ON CONFLICT ("companyId")
      DO UPDATE SET "lastSeq" = "quotation_code_counters"."lastSeq" + 1, "updatedAt" = NOW()
      RETURNING "lastSeq"
    `;

    return formatQuotationNo(company?.docPrefix ?? 'CTD', rows[0].lastSeq);
  }
}
