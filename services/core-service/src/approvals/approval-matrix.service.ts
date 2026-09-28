import { Injectable } from '@nestjs/common';
import {
  AppError,
  auditActor,
  AuditWriter,
  resolveTargetCompany,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { Prisma } from '@prisma/client';
import type { ApprovalMatrix } from '@prisma/client';
import { assertValidLevels, unknownConditionFields } from './matrix-rules';
import { ApprovalMatrixRepository } from './approval-matrix.repository';
import { AccessService, type MatrixLevel } from '../access/access.service';
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
    await this.assertConditionFieldsExist(levels, dto.subject_type, companyId);

    // Validated by `assertValidLevels` above; `condition.value` is `unknown` only in type.
    const levelsJson = levels as unknown as Prisma.InputJsonValue;

    const data = {
      companyId,
      subjectType: dto.subject_type,
      currency: dto.currency ?? 'THB',
      tiers: tiers as unknown as Prisma.InputJsonValue,
      levels: levelsJson,
      effectiveFrom: dto.effective_from
        ? new Date(dto.effective_from)
        : new Date(),
      publishedAt: dto.publish === false ? null : new Date(),
      createdBy: actor.userId,
    };

    const published = await this.createNextVersion(data);
    const version = published.version;

    await this.audit.record({
      eventType: 'approval.matrix.published',
      companyId,
      ...auditActor(actor),
      resourceType: 'approval_matrix',
      resourceId: published.id,
      after: {
        subjectType: dto.subject_type,
        version,
        levels: levelsJson,
      },
    });

    return published;
  }

  /** A condition on a field the request form never asks for would silently skip its level. */
  private async assertConditionFieldsExist(
    levels: readonly MatrixLevel[],
    subjectType: string,
    companyId: string,
  ): Promise<void> {
    const typeCode = /^request:([^:]+)/.exec(subjectType)?.[1];
    if (!typeCode || !levels.some((level) => level.condition)) return;

    const unknown = unknownConditionFields(
      levels,
      await this.matrices.formFieldsOfType(typeCode, companyId),
    );
    if (unknown.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เงื่อนไขอ้างถึงช่องที่ไม่มีในฟอร์มของประเภทนี้',
        unknown.map((field) => ({
          field: 'levels.condition.field',
          reason: field,
        })),
      );
    }
  }

  /** version N+1; two admins publishing at once collide on the unique key, so recount once. */
  private async createNextVersion(
    data: Omit<Prisma.ApprovalMatrixUncheckedCreateInput, 'version'>,
  ): Promise<ApprovalMatrix> {
    for (let attempt = 0; ; attempt += 1) {
      const version =
        (await this.matrices.latestVersion(data.companyId, data.subjectType)) +
        1;
      try {
        return await this.matrices.create({ data: { ...data, version } });
      } catch (error) {
        const collided =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002';
        if (!collided || attempt >= 1) throw error;
      }
    }
  }
}
