import { Injectable } from '@nestjs/common';
import {
  SolutionClarificationRepository,
  SolutionDemoRepository,
  SolutionRiskRepository,
  SolutionFileRepository,
  SolutionRequirementRepository,
  SolutionVersionRepository,
} from '../presales/solution.repositories';
import {
  readCriteria,
  riskLevel,
  riskScore,
  type RiskState,
  readAssumptions,
  readDeliverables,
  readLines,
} from '../presales/solution-rules';

export interface TechnicalCandidate {
  /** The deal has Pre-Sales work, so a handover must carry it. */
  hasSolution: boolean;
  /** Its most recently approved version — what a handover sends now. */
  version: { id: string; versionNo: number; title: string } | null;
}

/**
 * CD-144 — ส่งมอบงานเทคนิค: the technical package a sales handover (CD-84)
 * carries to the project team — the deal's approved Solution version, read
 * whole: summary, design, scope, deliverables with their acceptance
 * criteria, assumptions, the requirement analysis and the design files.
 *
 * Read here, beside the handover, rather than through `SolutionsService`:
 * Pre-Sales builds on CRM, so CRM reaching back into the presales module
 * would be a cycle — these are its repositories and pure readers only. The
 * receiving team needs no presales permission; the handover's own visibility
 * is what lets them read it.
 *
 * A locked version never changes, so pointing at it is as good as a copy.
 */
@Injectable()
export class HandoverTechnicalService {
  constructor(
    private readonly versions: SolutionVersionRepository,
    private readonly requirements: SolutionRequirementRepository,
    private readonly files: SolutionFileRepository,
    private readonly clarifications: SolutionClarificationRepository,
    private readonly risks: SolutionRiskRepository,
    private readonly demos: SolutionDemoRepository,
  ) {}

  async candidate(opportunityId: string): Promise<TechnicalCandidate> {
    const [any, approved] = await Promise.all([
      this.versions.findFirst({
        where: { solution: { opportunityId } },
        select: { id: true },
      }),
      this.versions.findFirst({
        where: { solution: { opportunityId }, approvalStatus: 'approved' },
        orderBy: { approvedAt: 'desc' },
        select: {
          id: true,
          versionNo: true,
          solution: { select: { title: true } },
        },
      }) as Promise<{
        id: string;
        versionNo: number;
        solution: { title: string };
      } | null>,
    ]);
    return {
      hasSolution: Boolean(any),
      version: approved
        ? {
            id: approved.id,
            versionNo: approved.versionNo,
            title: approved.solution.title,
          }
        : null,
    };
  }

  /** The package as the project team reads it, or null. */
  async packageOf(versionId: string | null) {
    if (!versionId) return null;
    const version = (await this.versions.findFirst({
      where: { id: versionId },
      include: { solution: { select: { id: true, title: true } } },
    })) as {
      id: string;
      solutionId: string;
      versionNo: number;
      summary: string;
      design: string;
      assumptions: unknown;
      inScope: unknown;
      outOfScope: unknown;
      deliverables: unknown;
      feasibility: string;
      feasibilityNote: string;
      approvedAt: Date | null;
      solution: { id: string; title: string };
    } | null;
    if (!version) return null;
    const [requirements, files, clarifications, risks, demos] =
      await Promise.all([
        this.requirements.findMany({
          where: { solutionId: version.solutionId, deletedAt: null },
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            kind: true,
            text: true,
            assessment: true,
            note: true,
            customerAnswer: true,
          },
        }),
        this.files.findMany({
          where: { versionId: version.id, deletedAt: null },
          orderBy: { uploadedAt: 'asc' },
          select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
        }),
        // CD-140 — the technical Q&A with the customer.
        this.clarifications.findMany({
          where: { solutionId: version.solutionId, deletedAt: null },
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            question: true,
            answer: true,
            respondent: true,
            answeredOn: true,
            affectsScope: true,
          },
        }),
        // CD-141 — the project's risks, from the pre-sale.
        this.risks.findMany({
          where: { solutionId: version.solutionId, deletedAt: null },
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            title: true,
            description: true,
            likelihood: true,
            impact: true,
            owner: true,
            mitigation: true,
            status: true,
          },
        }) as Promise<(RiskState & { seq: number; title: string })[]>,
        // CD-139 — the demos and what they showed.
        this.demos.findMany({
          where: { solutionId: version.solutionId, deletedAt: null },
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            kind: true,
            title: true,
            status: true,
            scheduledOn: true,
            criteria: true,
            outcome: true,
            findings: {
              where: { deletedAt: null },
              orderBy: { seq: 'asc' },
              select: {
                text: true,
                requiresChange: true,
                resolvedVersionNo: true,
              },
            },
          },
        }) as unknown as Promise<
          {
            seq: number;
            kind: string;
            title: string;
            status: string;
            scheduledOn: Date | null;
            criteria: unknown;
            outcome: string;
            findings: {
              text: string;
              requiresChange: boolean;
              resolvedVersionNo: number | null;
            }[];
          }[]
        >,
      ]);
    return {
      solutionId: version.solution.id,
      title: version.solution.title,
      versionId: version.id,
      versionNo: version.versionNo,
      approvedAt: version.approvedAt,
      summary: version.summary,
      design: version.design,
      // CD-133 — the verdict the project inherits, with its conditions.
      feasibility: version.feasibility,
      feasibilityNote: version.feasibilityNote,
      inScope: readLines(version.inScope),
      outOfScope: readLines(version.outOfScope),
      deliverables: readDeliverables(version.deliverables),
      assumptions: readAssumptions(version.assumptions),
      requirements,
      clarifications,
      risks: risks
        .map((risk) => ({
          ...risk,
          score: riskScore(risk),
          level: riskLevel(riskScore(risk)),
        }))
        .sort((a, b) => b.score - a.score || a.seq - b.seq),
      demos: demos.map((demo) => ({
        ...demo,
        criteria: readCriteria(demo.criteria),
      })),
      files,
    };
  }

  /** One design file of the attached version — the caller has checked the handover. */
  async fileOf(versionId: string | null, fileId: string) {
    if (!versionId) return null;
    return (await this.files.findFirst({
      where: { id: fileId, versionId, deletedAt: null },
      select: { fileName: true, mimeType: true, storageKey: true },
    })) as { fileName: string; mimeType: string; storageKey: string } | null;
  }
}
