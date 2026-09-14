import { Injectable } from '@nestjs/common';
import { PrismaService, TQueryClient } from '@request-management/share';
import { nameSimilarity, normalizeCustomerName } from './customer-name';

/** What the inline form check and the create guard both return. */
export interface DuplicateCheckResult {
  /** CM-03 hard block: same tax id + same branch code in this company. */
  readonly duplicate: SimilarCustomer | null;
  /**
   * Same tax id, different branch (redesign #2, 8 ก.ย. 2569): NOT a block —
   * the new row is a branch of this head office and will be linked to it.
   * The form shows this as information, and `create` writes `headOfficeId`.
   */
  readonly headOffice: SimilarCustomer | null;
  /** Similar-name warnings, most similar first. */
  readonly similar: readonly SimilarCustomer[];
  /** The threshold used, so the form can explain the warning. */
  readonly threshold: number;
}

export interface SimilarCustomer {
  readonly id: string;
  readonly customerCode: string;
  readonly nameTh: string;
  readonly nameEn: string | null;
  readonly taxId: string | null;
  readonly branchCode: string;
  readonly branchName: string | null;
  readonly status: string;
  readonly similarity: number;
}

const DEFAULT_THRESHOLD = 0.85;

/**
 * CM-03 — duplicate prevention, one implementation behind both the
 * `check-duplicate` endpoint the form calls inline and the guard `create`
 * runs before writing. Two answers, deliberately different in force:
 *
 *   - same เลขผู้เสียภาษี + same รหัสสาขา in the same company → **hard
 *     block**, pointing at the existing row;
 *   - same เลขผู้เสียภาษี, different branch → allowed: the result names the
 *     head office the new row will be linked to (redesign #2);
 *   - similar name after normalization → **warning**, which only a caller
 *     holding `crm.customer.dedup.override` may confirm past, with a reason,
 *     audited (PO decision #4).
 *
 * The similarity threshold is per-company configuration
 * (`CrmCompanyConfig.dedupThreshold`), tunable without a deploy.
 */
@Injectable()
export class CustomerDedupService {
  constructor(private readonly prisma: PrismaService) {}

  async check(
    input: {
      nameTh: string;
      nameEn?: string | null;
      taxId?: string | null;
      branchCode?: string | null;
      /** Excluded from matching — an update must not collide with itself. */
      excludeCustomerId?: string;
    },
    companyId: string,
    option?: { prisma?: TQueryClient },
  ): Promise<DuplicateCheckResult> {
    const client = option?.prisma ?? this.prisma;
    const notSelf = input.excludeCustomerId
      ? { id: { not: input.excludeCustomerId } }
      : {};

    const threshold = await this.thresholdOf(companyId, client);

    const duplicate = input.taxId
      ? await client.customer.findFirst({
          where: {
            companyId,
            taxId: input.taxId,
            branchCode: input.branchCode ?? '00000',
            // An alias row points at the survivor; the survivor is the match.
            mergedIntoCustomerId: null,
            ...notSelf,
          },
          select: MATCH_SELECT,
        })
      : null;

    const headOffice =
      input.taxId && !duplicate
        ? await this.headOfficeOf(input.taxId, companyId, client, {
            excludeCustomerId: input.excludeCustomerId,
          })
        : null;

    /*
      Candidates are every live name in the company, compared in memory.
      Fine at MVP scale (the cleansed legacy book is a few thousand rows);
      when the register outgrows this, the move is a pg_trgm index over
      `normalizedName`, not a wider fetch.
    */
    const candidates = await client.customer.findMany({
      where: { companyId, mergedIntoCustomerId: null, ...notSelf },
      select: { ...MATCH_SELECT, normalizedName: true },
    });

    const targets = [
      normalizeCustomerName(input.nameTh),
      ...(input.nameEn ? [normalizeCustomerName(input.nameEn)] : []),
    ];

    const similar = candidates
      .filter((candidate) => !input.taxId || candidate.taxId !== input.taxId)
      .map((candidate) => ({
        candidate,
        similarity: Math.max(
          ...targets.map((t) => nameSimilarity(t, candidate.normalizedName)),
          ...(candidate.nameEn
            ? targets.map((t) =>
                nameSimilarity(t, normalizeCustomerName(candidate.nameEn!)),
              )
            : []),
        ),
      }))
      .filter(
        ({ candidate, similarity }) =>
          similarity >= threshold && candidate.id !== duplicate?.id,
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(({ candidate, similarity }) => toSimilar(candidate, similarity));

    return {
      duplicate: duplicate ? toSimilar(duplicate, 1) : null,
      headOffice,
      similar,
      threshold,
    };
  }

  /**
   * The row a new branch links to (redesign #2): among live rows sharing the
   * tax id, prefer an existing head (no `headOfficeId`) with สำนักงานใหญ่
   * code, then any head, then the oldest row — and follow a branch row up to
   * its head so chains never form.
   */
  async headOfficeOf(
    taxId: string,
    companyId: string,
    client?: TQueryClient,
    option?: { excludeCustomerId?: string },
  ): Promise<SimilarCustomer | null> {
    const rows = await (client ?? this.prisma).customer.findMany({
      where: {
        companyId,
        taxId,
        mergedIntoCustomerId: null,
        ...(option?.excludeCustomerId
          ? { id: { not: option.excludeCustomerId } }
          : {}),
      },
      select: { ...MATCH_SELECT, headOfficeId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!rows.length) return null;

    const heads = rows.filter((row) => !row.headOfficeId);
    const head =
      heads.find((row) => row.branchCode === '00000') ?? heads[0] ?? rows[0];
    return toSimilar(head, 1);
  }

  private async thresholdOf(
    companyId: string,
    client: TQueryClient,
  ): Promise<number> {
    const config = await client.crmCompanyConfig.findUnique({
      where: { companyId },
      select: { dedupThreshold: true },
    });

    return config?.dedupThreshold ?? DEFAULT_THRESHOLD;
  }
}

const MATCH_SELECT = {
  id: true,
  customerCode: true,
  nameTh: true,
  nameEn: true,
  taxId: true,
  branchCode: true,
  branchName: true,
  status: true,
} as const;

function toSimilar(
  row: {
    id: string;
    customerCode: string;
    nameTh: string;
    nameEn: string | null;
    taxId: string | null;
    branchCode: string;
    branchName: string | null;
    status: string;
  },
  similarity: number,
): SimilarCustomer {
  return {
    id: row.id,
    customerCode: row.customerCode,
    nameTh: row.nameTh,
    nameEn: row.nameEn,
    taxId: row.taxId,
    branchCode: row.branchCode,
    branchName: row.branchName,
    status: row.status,
    similarity: Number(similarity.toFixed(3)),
  };
}
