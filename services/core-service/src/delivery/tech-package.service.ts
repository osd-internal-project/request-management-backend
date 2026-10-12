import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { AsBuiltService } from '../pm/as-built.service';
import {
  ProjectConfigItemRepository,
  ProjectIntegrationRepository,
  ProjectServiceBriefRepository,
} from '../pm/project.repositories';
import { ProjectsService } from '../pm/projects.service';
import { DeliveriesService } from './deliveries.service';
import { MAX_CAUTIONS, techPackageGaps } from './tech-package-rules';

interface IntegrationRow {
  seq: number;
  name: string;
  targetSystem: string;
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
}

interface BriefRow {
  cautions: string;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string | null;
}

/**
 * CD-227 ส่งมอบงานเทคนิคให้ทีมบริการ (CD-19 Engineer) — the engineers' part
 * of the handover to service (CD-255): the as-built documents with no
 * deviation left open (CD-226), the configuration recorded (CD-217), a
 * customer contact on every integration (CD-219), and the project team's
 * cautions. Until all of it is there the handover cannot be sent; once sent,
 * what it was goes into the handover's snapshot for the service team.
 *
 * Who: whoever sees the delivery reads it; the project's manager, the team
 * on the project, or `delivery.manage` / `pm.project.manage` write the
 * cautions.
 */
@Injectable()
export class TechPackageService {
  constructor(
    private readonly deliveries: DeliveriesService,
    private readonly projects: ProjectsService,
    private readonly asBuilt: AsBuiltService,
    private readonly configs: ProjectConfigItemRepository,
    private readonly integrations: ProjectIntegrationRepository,
    private readonly briefs: ProjectServiceBriefRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
  ) {}

  async view(actor: Principal, projectId: string) {
    const { project, canEdit } = await this.deliveries.access(actor, projectId);
    const pack = await this.packageOf(projectId, project.companyId);
    return {
      ...pack,
      canWrite: canEdit || (await this.onTeam(actor, projectId)),
    };
  }

  /** The package and what it lacks — for the send, and for the screen. */
  async packageOf(projectId: string, companyId: string) {
    const [asBuilt, configItems, systems, integrations, brief] =
      await Promise.all([
        this.asBuilt.state(projectId, companyId),
        this.configs.count({ where: { projectId, deletedAt: null } }),
        this.configs.findMany({
          where: { projectId, deletedAt: null },
          distinct: ['system'],
          select: { system: true },
        }) as Promise<{ system: string }[]>,
        this.integrations.findMany({
          where: { projectId, deletedAt: null },
          orderBy: { seq: 'asc' },
          select: {
            seq: true,
            name: true,
            targetSystem: true,
            contactId: true,
            contactName: true,
            contactPhone: true,
            contactEmail: true,
          },
        }) as Promise<IntegrationRow[]>,
        this.briefs.findFirst({
          where: { projectId },
          select: {
            cautions: true,
            updatedAt: true,
            createdBy: true,
            updatedBy: true,
          },
        }) as Promise<BriefRow | null>,
      ]);
    const links = integrations.map((row) => ({
      label: `I-${row.seq}`,
      name: row.name,
      targetSystem: row.targetSystem,
      hasContact: Boolean(
        row.contactId ||
        row.contactName?.trim() ||
        row.contactPhone?.trim() ||
        row.contactEmail?.trim(),
      ),
    }));
    const gaps = techPackageGaps({
      asBuilt,
      configItems,
      integrations: links,
      cautions: brief?.cautions ?? null,
    });
    const author = brief ? (brief.updatedBy ?? brief.createdBy) : null;
    const names = await this.displayNames([author]);
    return {
      complete: !gaps.length,
      gaps,
      asBuilt: {
        complete: asBuilt.complete,
        missingDocuments: asBuilt.missingDocuments,
        openDeviations: asBuilt.openDeviations,
      },
      configs: {
        count: configItems,
        systems: systems.map((row) => row.system),
      },
      integrations: links,
      cautions: brief
        ? {
            text: brief.cautions,
            updatedAt: brief.updatedAt,
            updatedByName: author ? (names.get(author) ?? null) : null,
          }
        : null,
    };
  }

  /** What the handover keeps of the package when it is sent. */
  async snapshotFor(projectId: string, companyId: string) {
    const pack = await this.packageOf(projectId, companyId);
    if (!pack.complete) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ข้อมูลเทคนิคยังไม่ครบ ส่งต่อไม่ได้: ${pack.gaps[0]}`,
        pack.gaps.map((reason) => ({ field: 'technical', reason })),
      );
    }
    return {
      configItems: pack.configs.count,
      systems: pack.configs.systems,
      integrations: pack.integrations.map(
        (row) => `${row.label} ${row.name} → ${row.targetSystem}`,
      ),
      cautions: pack.cautions?.text ?? '',
    };
  }

  async saveCautions(actor: Principal, projectId: string, text: string) {
    const { project, canEdit } = await this.deliveries.access(actor, projectId);
    if (!canEdit && !(await this.onTeam(actor, projectId))) {
      throw new AppError(
        'FORBIDDEN',
        'เขียนข้อควรระวังได้เฉพาะผู้จัดการและทีมโครงการ',
      );
    }
    const cautions = text.trim();
    if (!cautions) {
      throw new AppError('VALIDATION_FAILED', 'ต้องเขียนข้อควรระวัง', [
        { field: 'cautions', reason: 'required' },
      ]);
    }
    if (cautions.length > MAX_CAUTIONS) {
      throw new AppError('VALIDATION_FAILED', 'ข้อควรระวังยาวเกินไป', [
        { field: 'cautions', reason: 'too_long' },
      ]);
    }
    await this.briefs.upsert({
      where: { projectId },
      create: {
        companyId: project.companyId,
        projectId,
        cautions,
        createdBy: actor.userId,
      },
      update: { cautions, updatedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'delivery.tech_package.cautions_saved',
      companyId: project.companyId,
      ...auditActor(actor),
      resourceType: 'project',
      resourceId: projectId,
      after: { length: cautions.length },
    });
    return this.view(actor, projectId);
  }

  /** The project's manager or someone on its team. */
  private async onTeam(actor: Principal, projectId: string) {
    try {
      const { project, canEdit } = await this.projects.access(projectId, actor);
      return (
        canEdit ||
        project.managerUserId === actor.userId ||
        project.members.some((member) => member.userId === actor.userId)
      );
    } catch {
      return false;
    }
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
