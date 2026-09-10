import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@request-management/share';

export function formatSaleOrderCode(docPrefix: string, seq: number): string {
  return `SO-${docPrefix}-${String(seq).padStart(6, '0')}`;
}

/**
 * Issues the sale-order number at open — same atomic
 * INSERT … ON CONFLICT … RETURNING as `OpportunityCodeService`, because Odoo
 * and the accounting side will key on this number (CD-77).
 */
@Injectable()
export class SaleOrderCodeService {
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
      INSERT INTO "sale_order_code_counters" ("id", "companyId", "lastSeq", "updatedAt")
      VALUES (gen_random_uuid(), ${companyId}, 1, NOW())
      ON CONFLICT ("companyId")
      DO UPDATE SET "lastSeq" = "sale_order_code_counters"."lastSeq" + 1, "updatedAt" = NOW()
      RETURNING "lastSeq"
    `;

    return formatSaleOrderCode(company?.docPrefix ?? 'CTD', rows[0].lastSeq);
  }
}
