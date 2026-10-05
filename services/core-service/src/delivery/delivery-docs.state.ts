import { Injectable } from '@nestjs/common';
import { PrismaService } from '@request-management/share';
import { readBoq } from '../presales/solution-rules';
import {
  documentsByType,
  nextPhase,
  packStatus,
  requiredFor,
} from './delivery-docs-rules';

/**
 * CD-251 — a phase's document pack, read straight from the database so the
 * project readiness check (PM, CD-225) can use it without importing the
 * delivery module (which imports PM): PmModule provides this class too.
 */
@Injectable()
export class DeliveryDocsState {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The readiness fact: the next phase's pack — null when no phase has a
   * delivery trip yet (the check is then not asked, like software docs).
   */
  async forProject(projectId: string, companyId: string) {
    const [milestones, trips] = await Promise.all([
      this.prisma.projectMilestone.findMany({
        where: { projectId },
        select: { id: true, seq: true, title: true, status: true },
      }),
      this.prisma.projectDelivery.findMany({
        where: { projectId, status: { not: 'cancelled' } },
        select: { milestoneId: true },
      }),
    ]);
    const phase = nextPhase(
      milestones,
      trips.map((t) => t.milestoneId),
    );
    if (!phase) return null;
    const pack = await this.pack(projectId, companyId, phase.id);
    return { milestone: phase, ...pack };
  }

  /** One phase: its work types, the documents they require, and what is in. */
  async pack(projectId: string, companyId: string, milestoneId: string) {
    const [project, lines, config, documents] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { baseline: true },
      }),
      this.prisma.projectDeliveryLine.findMany({
        where: {
          delivery: { projectId, milestoneId, status: { not: 'cancelled' } },
        },
        select: { boqIndex: true },
      }),
      this.prisma.crmCompanyConfig.findUnique({
        where: { companyId },
        select: { deliveryDocuments: true },
      }),
      this.prisma.projectDeliveryDocument.findMany({
        where: { projectId, milestoneId, deletedAt: null },
        orderBy: { uploadedAt: 'asc' },
      }),
    ]);
    const boq = readBoq((project?.baseline as { boq?: unknown } | null)?.boq);
    const workTypes = [
      ...new Set(
        lines
          .map((line) => boq[line.boqIndex]?.kind)
          .filter((kind): kind is NonNullable<typeof kind> => !!kind),
      ),
    ];
    const required = requiredFor(
      documentsByType(config?.deliveryDocuments ?? null),
      workTypes,
    );
    return { workTypes, ...packStatus(required, documents) };
  }
}
