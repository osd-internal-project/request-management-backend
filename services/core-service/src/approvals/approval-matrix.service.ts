import { Injectable } from '@nestjs/common';
import {
  AppError,
  auditActor,
  AuditWriter,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { ApprovalMatrix, Prisma } from '@prisma/client';
import { MatrixTier } from './approval-chain';
import { assertValidTiers } from './matrix-rules';
import { ApprovalMatrixRepository } from './approval-matrix.repository';
import { PublishMatrixDto } from './dto/approval.dto';

/**
 * APV-01 — the authority matrix.
 *
 * Versions are **immutable once published**. There is no update path here on
 * purpose: editing means publishing version N+1, which is what lets a case
 * already in flight keep the ceilings it was routed under (§7 — running work
 * keeps the rules it started under). Silently editing a live ladder would
 * re-judge decisions that were already made.
 */
@Injectable()
export class ApprovalMatrixService {
  constructor(
    private readonly matrices: ApprovalMatrixRepository,
    private readonly audit: AuditWriter,
  ) {}

  list(companyId: string, subjectType?: string): Promise<ApprovalMatrix[]> {
    return this.matrices.findForCompany(companyId, subjectType);
  }

  /** The ladder in force for a subject now, or a named failure. */
  async requireEffective(
    companyId: string,
    subjectType: string,
    at: Date,
    option?: { prisma: Prisma.TransactionClient },
  ): Promise<ApprovalMatrix> {
    const matrix = await this.matrices.findEffective(
      companyId,
      subjectType,
      at,
      option,
    );

    if (!matrix) {
      throw new AppError(
        'APV_MATRIX_NOT_FOUND',
        'ยังไม่ได้ตั้งค่าตารางอำนาจอนุมัติของบริษัทและประเภทงานนี้',
        [{ field: 'subject_type', reason: subjectType }],
      );
    }

    return matrix;
  }

  /**
   * Publishes the next version of a ladder.
   *
   * The tiers are validated before anything is written — see `matrix-rules.ts`
   * for why a malformed ladder must not be allowed to reach the table.
   */
  async publish(
    dto: PublishMatrixDto,
    actor: Principal,
  ): Promise<ApprovalMatrix> {
    const tiers = dto.tiers.map<MatrixTier>((tier) => ({
      upto: tier.upto ?? null,
      chain: tier.chain as MatrixTier['chain'],
    }));

    assertValidTiers(tiers);

    // The company comes from the body so one administrator can configure any
    // company they belong to from a single screen (§16 A1 draws a tab each) —
    // which is precisely why it has to be checked rather than trusted.
    const companyId = resolveTargetCompany(actor, dto.company_id);

    const version =
      (await this.matrices.latestVersion(companyId, dto.subject_type)) + 1;

    const published = await this.matrices.create({
      data: {
        companyId,
        subjectType: dto.subject_type,
        currency: dto.currency ?? 'THB',
        version,
        tiers: tiers as unknown as Prisma.InputJsonValue,
        effectiveFrom: dto.effective_from
          ? new Date(dto.effective_from)
          : new Date(),
        publishedAt: dto.publish === false ? null : new Date(),
        createdBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'approval.matrix.published',
      companyId,
      ...auditActor(actor),
      resourceType: 'approval_matrix',
      resourceId: published.id,
      after: {
        subjectType: dto.subject_type,
        version,
        tiers: tiers as unknown as Prisma.InputJsonValue,
      },
    });

    return published;
  }
}
