import { Injectable } from '@nestjs/common';
import {
  AppError,
  auditActor,
  AuditWriter,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import type { ApprovalMatrix, Prisma } from '@prisma/client';
import { assertValidLevels } from './matrix-rules';
import { ApprovalMatrixRepository } from './approval-matrix.repository';
import { AccessService } from '../access/access.service';
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
    private readonly access: AccessService,
    private readonly audit: AuditWriter,
  ) {}

  list(companyId: string, subjectType?: string): Promise<ApprovalMatrix[]> {
    return this.matrices.findForCompany(companyId, subjectType);
  }

  /** Whether any version routes this subject at all — see the repository. */
  countForSubject(subjectType: string): Promise<number> {
    return this.matrices.countForSubject(subjectType);
  }

  /**
   * Is there a ladder in force for this subject?
   *
   * The question `requireEffective` cannot answer, because it throws. Some
   * request types are configured to have no approval at all, and for those the
   * absence is the answer rather than a failure.
   */
  async hasEffective(
    companyId: string,
    subjectType: string,
    at: Date,
  ): Promise<boolean> {
    return Boolean(
      await this.matrices.findEffective(companyId, subjectType, at),
    );
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
   * The levels are validated before anything is written — see
   * `matrix-rules.ts` for why a malformed ladder must not reach the table, and
   * for why it is levels rather than amount tiers since 31 Aug 2026.
   */
  async publish(
    dto: PublishMatrixDto,
    actor: Principal,
  ): Promise<ApprovalMatrix> {
    const levels = dto.levels as unknown;

    assertValidLevels(levels);

    /*
      `tiers` is NOT NULL and every reader published before today expects it,
      so a new version writes one open-ended entry alongside the real ladder.
      It carries no ceiling because there are no ceilings any more; it exists so
      an older reader sees a well-formed row rather than an empty one.
    */
    const tiers = [{ upto: null, chain: ['team_lead'] }];

    // The company comes from the body so one administrator can configure any
    // company they belong to from a single screen (§16 A1 draws a tab each) —
    // which is precisely why it has to be checked rather than trusted.
    const companyId = resolveTargetCompany(actor, dto.company_id);

    // Shape first, then targets: the second needs the company, and the company
    // is only trustworthy once `resolveTargetCompany` has checked it.
    await this.access.assertLevelTargetsExist(levels, companyId);

    const version =
      (await this.matrices.latestVersion(companyId, dto.subject_type)) + 1;

    const published = await this.matrices.create({
      data: {
        companyId,
        subjectType: dto.subject_type,
        currency: dto.currency ?? 'THB',
        version,
        tiers: tiers as unknown as Prisma.InputJsonValue,
        levels: levels as Prisma.InputJsonValue,
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
        levels: levels as Prisma.InputJsonValue,
      },
    });

    return published;
  }
}
