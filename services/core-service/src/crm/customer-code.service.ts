import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import type { Prisma } from '@prisma/client';

/** `CUS-OSD-000001` — prefix, company doc prefix, zero-padded sequence. */
export function formatCustomerCode(
  prefix: string,
  docPrefix: string,
  seq: number,
  padding: number,
): string {
  return `${prefix}-${docPrefix}-${String(seq).padStart(padding, '0')}`;
}

/**
 * CM-02 — issues the customer code at create.
 *
 * The same guarantee, made the same way, as `DocNumberService`: the counter
 * is bumped by a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
 * statement, so 20 concurrent creates get 20 distinct consecutive numbers
 * (the CM-02 AC) — the database serialises them, not application code.
 *
 * Two deliberate differences from document numbers:
 *   - **no monthly reset** — a customer code is permanent identity that Odoo
 *     and 7 accounting systems key on (D-30), so the counter is one row per
 *     company, ever increasing;
 *   - **this system is the issuer** (PO decision #1, 8 ก.ย. 2569) — the code
 *     is sent TO Odoo at create, and what Odoo answers (partner id) lands in
 *     `customer_external_codes`, never in this column.
 */
@Injectable()
export class CustomerCodeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserves the next code for this company. Must run inside the same
   * transaction as the customer insert — a code handed out for a create that
   * then fails would leave a permanent gap that looks like a deleted customer.
   */
  async issue(
    companyId: string,
    prisma: Prisma.TransactionClient,
  ): Promise<string> {
    const [company, config] = await Promise.all([
      prisma.company.findUnique({
        where: { id: companyId },
        select: { docPrefix: true },
      }),
      prisma.crmCompanyConfig.findUnique({ where: { companyId } }),
    ]);

    const seq = await this.nextSequence(prisma, companyId);

    return formatCustomerCode(
      config?.codePrefix ?? 'CUS',
      company?.docPrefix ?? 'CTD',
      seq,
      config?.codePadding ?? 6,
    );
  }

  private async nextSequence(
    prisma: Prisma.TransactionClient,
    companyId: string,
  ): Promise<number> {
    const rows = await prisma.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO customer_code_counters
        (id, "companyId", "lastSeq", "updatedAt")
      VALUES
        (gen_random_uuid(), ${companyId}, 1, now())
      ON CONFLICT ("companyId")
      DO UPDATE SET
        "lastSeq" = customer_code_counters."lastSeq" + 1,
        "updatedAt" = now()
      RETURNING "lastSeq"
    `;

    return rows[0].lastSeq;
  }
}
