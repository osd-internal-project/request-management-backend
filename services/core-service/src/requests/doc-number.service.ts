import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import type { Prisma } from '@prisma/client';

/** The parts a pattern may reference. */
interface NumberParts {
  prefix: string;
  typeCode: string;
  yearMonth: number;
  seq: number;
  padding: number;
}

const DEFAULT_PATTERN = '{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}';
const DEFAULT_PADDING = 4;

/**
 * REQ-02 / D-02 / D-19 — issues the document number at submit.
 *
 * `OSD-DSC-202608-0042`: company prefix, type code, CE year+month, and a
 * sequence that **resets every month**, per company per type.
 *
 * The whole point of this class is the guarantee that two requests never get
 * the same number (NFR-03). A duplicate number is not a cosmetic bug — it is
 * two pieces of paper claiming to be the same approval, and it is discovered
 * weeks later by someone reconciling records.
 *
 * That is why the counter is bumped by a **single atomic statement** rather
 * than read-then-write: under concurrent submits, `SELECT` followed by
 * `UPDATE` hands the same value to both callers. `INSERT … ON CONFLICT DO
 * UPDATE … RETURNING` does the read, the increment and the write as one
 * indivisible operation, so the database itself serialises them.
 */
@Injectable()
export class DocNumberService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reserves the next number for this company and type.
   *
   * Must run inside the same transaction as the state change it belongs to:
   * a number handed out for a submit that then fails would leave a permanent
   * gap that looks like a deleted request.
   */
  async issue(
    companyId: string,
    typeCode: string,
    prisma: Prisma.TransactionClient,
    at = new Date(),
  ): Promise<string> {
    const yearMonth = toYearMonth(at);

    const [company, config] = await Promise.all([
      prisma.company.findUnique({
        where: { id: companyId },
        select: { docPrefix: true },
      }),
      prisma.docNumberConfig.findUnique({
        where: { companyId_typeCode: { companyId, typeCode } },
      }),
    ]);

    const seq = await this.nextSequence(prisma, companyId, typeCode, yearMonth);

    return format(config?.pattern ?? DEFAULT_PATTERN, {
      prefix: company?.docPrefix ?? 'REQ',
      typeCode,
      yearMonth,
      seq,
      padding: config?.seqPadding ?? DEFAULT_PADDING,
    });
  }

  /**
   * One statement: insert the month's counter or bump it, returning the value
   * this caller owns. Two concurrent submits get 1 and 2, never 1 and 1.
   */
  private async nextSequence(
    prisma: Prisma.TransactionClient,
    companyId: string,
    typeCode: string,
    yearMonth: number,
  ): Promise<number> {
    const rows = await prisma.$queryRaw<{ lastSeq: number }[]>`
      INSERT INTO doc_number_counters
        (id, "companyId", "typeCode", "yearMonth", "lastSeq", "updatedAt")
      VALUES
        (gen_random_uuid(), ${companyId}, ${typeCode}, ${yearMonth}, 1, now())
      ON CONFLICT ("companyId", "typeCode", "yearMonth")
      DO UPDATE SET
        "lastSeq" = doc_number_counters."lastSeq" + 1,
        "updatedAt" = now()
      RETURNING "lastSeq"
    `;

    return rows[0].lastSeq;
  }
}

/** `202608` — CE year and month, per D-02. */
export function toYearMonth(at: Date): number {
  return at.getUTCFullYear() * 100 + (at.getUTCMonth() + 1);
}

/** Fills a configured pattern. Unknown placeholders are left untouched. */
export function format(pattern: string, parts: NumberParts): string {
  return pattern
    .replace('{PREFIX}', parts.prefix)
    .replace('{TYPE}', parts.typeCode)
    .replace('{YYYYMM}', String(parts.yearMonth))
    .replace('{SEQ}', String(parts.seq).padStart(parts.padding, '0'));
}
