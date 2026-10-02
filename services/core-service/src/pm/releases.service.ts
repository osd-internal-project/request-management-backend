import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { OPEN_DEFECT } from './defect-rules';
import {
  DeployReleaseDto,
  SaveEnvironmentDto,
  SaveReleaseDto,
} from './dto/project.dto';
import {
  ProjectDefectRepository,
  ProjectDeploymentRepository,
  ProjectEnvironmentRepository,
  ProjectReleaseRepository,
  ProjectUatFindingRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import {
  currentOf,
  deployProblems,
  environmentProblems,
  MAX_RELEASE_TEXT,
  releaseProblems,
} from './release-rules';

interface EnvRow {
  id: string;
  kind: string;
  name: string;
  url: string | null;
  note: string | null;
}

interface DeployRow {
  id: string;
  releaseId: string;
  environmentId: string;
  deployedAt: Date;
  deployedBy: string;
  note: string | null;
  overrideReason: string | null;
}

interface ReleaseRow {
  id: string;
  version: string;
  notes: string | null;
  createdAt: Date;
  createdBy: string;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const KIND_ORDER = ['dev', 'uat', 'production'];

/**
 * CD-214 Release และ Environment — the versions of the software made for
 * the customer and where each runs: development, UAT, production. A release
 * goes to production only after it ran on UAT and with no blocker open
 * (a defect, CD-213, or a UAT point, CD-222), unless the manager overrides
 * it with the reason (a hotfix). What runs on production shows on the
 * customer's 360° page, so it is always known who uses which version.
 *
 * Who: whoever sees the project reads it; the manager sets up the
 * environments; the team records releases and deployments.
 */
@Injectable()
export class ReleasesService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly environments: ProjectEnvironmentRepository,
    private readonly releases: ProjectReleaseRepository,
    private readonly deployments: ProjectDeploymentRepository,
    private readonly defects: ProjectDefectRepository,
    private readonly uatFindings: ProjectUatFindingRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [envs, releases, deployments, blockers] = await Promise.all([
      this.envRows(projectId),
      this.releases.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
      }) as Promise<ReleaseRow[]>,
      this.deployRows(projectId),
      this.blockers(projectId),
    ]);
    const names = await this.displayNames(
      deployments.map((row) => row.deployedBy),
    );
    const current = currentOf(deployments);
    const version = new Map(releases.map((row) => [row.id, row.version]));
    const envName = new Map(envs.map((row) => [row.id, row]));
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      blockers,
      environments: envs.map((env) => {
        const now = current.get(env.id);
        return {
          ...env,
          current: now
            ? {
                version: version.get(now.releaseId) ?? '',
                deployedAt: now.deployedAt.toISOString(),
                deployedByName: names.get(now.deployedBy) ?? null,
              }
            : null,
        };
      }),
      releases: releases.map((release) => ({
        id: release.id,
        version: release.version,
        notes: release.notes,
        createdAt: release.createdAt.toISOString(),
        // where it runs now
        runningOn: envs
          .filter((env) => current.get(env.id)?.releaseId === release.id)
          .map((env) => env.name),
        deployments: deployments
          .filter((row) => row.releaseId === release.id)
          .sort((a, b) => b.deployedAt.getTime() - a.deployedAt.getTime())
          .map((row) => ({
            id: row.id,
            environment: envName.get(row.environmentId)?.name ?? '',
            kind: envName.get(row.environmentId)?.kind ?? '',
            deployedAt: row.deployedAt.toISOString(),
            deployedByName: names.get(row.deployedBy) ?? null,
            note: row.note,
            overrideReason: row.overrideReason,
          })),
      })),
    };
  }

  /** CD-214 — what each of a customer's projects runs on production. */
  async forCustomer(customerId: string, actor: Principal) {
    const projects = await this.projects.visible(actor, { customerId });
    if (!projects.length) return [];
    const ids = projects.map((row) => row.id);
    const [envs, deployments] = await Promise.all([
      this.environments.findMany({
        where: { projectId: { in: ids }, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          projectId: true,
          kind: true,
          name: true,
          url: true,
        },
      }) as Promise<(EnvRow & { projectId: string })[]>,
      this.deployments.findMany({
        where: { environment: { projectId: { in: ids }, deletedAt: null } },
        select: {
          environmentId: true,
          deployedAt: true,
          release: { select: { version: true } },
        },
      }) as unknown as Promise<
        {
          environmentId: string;
          deployedAt: Date;
          release: { version: string };
        }[]
      >,
    ]);
    const current = currentOf(deployments);
    return projects
      .map((project) => ({
        projectId: project.id,
        projectNo: project.projectNo,
        name: project.name,
        status: project.status,
        environments: envs
          .filter((env) => env.projectId === project.id)
          .sort(
            (a, b) => KIND_ORDER.indexOf(b.kind) - KIND_ORDER.indexOf(a.kind),
          )
          .map((env) => {
            const now = current.get(env.id);
            return {
              name: env.name,
              kind: env.kind,
              url: env.url,
              version: now?.release.version ?? null,
              deployedAt: now?.deployedAt.toISOString() ?? null,
            };
          }),
      }))
      .filter((row) => row.environments.length);
  }

  async saveEnvironment(
    projectId: string,
    envId: string | null,
    dto: SaveEnvironmentDto,
    actor: Principal,
  ) {
    const access = await this.manager(projectId, actor);
    const current = envId ? await this.requireEnv(projectId, envId) : null;
    const input = {
      kind: dto.kind ?? current?.kind ?? '',
      name: (dto.name ?? current?.name ?? '').trim(),
      url:
        dto.url === undefined ? (current?.url ?? null) : dto.url.trim() || null,
      note:
        dto.note === undefined
          ? (current?.note ?? null)
          : dto.note.trim().slice(0, MAX_RELEASE_TEXT) || null,
    };
    const problems = environmentProblems(input);
    const clash = await this.environments.findFirst({
      where: {
        projectId,
        deletedAt: null,
        name: { equals: input.name, mode: 'insensitive' },
        ...(envId ? { id: { not: envId } } : {}),
      },
      select: { id: true },
    });
    if (clash) problems.push('มี environment ชื่อนี้แล้ว');
    this.fail(problems, 'environment');
    await this.transactions.execute(async (prisma) => {
      const row = current
        ? await prisma.projectEnvironment.update({
            where: { id: current.id },
            data: { ...input, updatedBy: actor.userId },
          })
        : await prisma.projectEnvironment.create({
            data: {
              companyId: access.project.companyId,
              projectId,
              ...input,
              createdBy: actor.userId,
            },
          });
      await this.audit.record(
        {
          eventType: current
            ? 'pm.environment.updated'
            : 'pm.environment.added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { environmentId: row.id, ...input },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Off the list; what was deployed there stays in the history. */
  async removeEnvironment(projectId: string, envId: string, actor: Principal) {
    const access = await this.manager(projectId, actor);
    const current = await this.requireEnv(projectId, envId);
    await this.transactions.execute(async (prisma) => {
      await prisma.projectEnvironment.update({
        where: { id: envId },
        data: { deletedAt: new Date(), updatedBy: actor.userId },
      });
      await this.audit.record(
        {
          eventType: 'pm.environment.removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { environmentId: envId, name: current.name },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async addRelease(projectId: string, dto: SaveReleaseDto, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const version = (dto.version ?? '').trim();
    const problems = releaseProblems(version);
    const taken = await this.releases.count({ where: { projectId, version } });
    if (taken) problems.push('มีเวอร์ชันนี้แล้ว');
    this.fail(problems, 'version');
    const notes = dto.notes?.trim().slice(0, MAX_RELEASE_TEXT) || null;
    await this.transactions.execute(async (prisma) => {
      const row = await prisma.projectRelease.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          version,
          notes,
          createdBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.release.added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { releaseId: row.id, version },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async deploy(
    projectId: string,
    releaseId: string,
    dto: DeployReleaseDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const release = (await this.releases.findFirst({
      where: { id: releaseId, projectId },
      select: { id: true, version: true },
    })) as { id: string; version: string } | null;
    if (!release) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันนี้');
    const env = await this.requireEnv(projectId, dto.environment_id);
    const [envs, earlier, blockers] = await Promise.all([
      this.envRows(projectId),
      this.deployments.findMany({
        where: { releaseId },
        select: { environmentId: true },
      }) as Promise<{ environmentId: string }[]>,
      env.kind === 'production' ? this.blockers(projectId) : 0,
    ]);
    const uat = new Set(
      envs.filter((row) => row.kind === 'uat').map((row) => row.id),
    );
    const deployedAt = dto.deployed_at ? new Date(dto.deployed_at) : now;
    const overrideReason = (dto.override_reason ?? '').trim();
    const problems = Number.isNaN(deployedAt.getTime())
      ? ['เวลาที่ deploy ไม่ถูกต้อง']
      : deployProblems({
          kind: env.kind,
          hasUat: uat.size > 0,
          onUat: earlier.some((row) => uat.has(row.environmentId)),
          blockers,
          overrideReason,
          canEdit: access.canEdit,
          deployedAt,
          now,
        });
    if (problems.some((reason) => reason.includes('เฉพาะผู้จัดการ'))) {
      throw new AppError('FORBIDDEN', problems[0]);
    }
    this.fail(problems, 'deploy');
    const note = dto.note?.trim().slice(0, MAX_RELEASE_TEXT) || null;
    await this.transactions.execute(async (prisma) => {
      const row = await prisma.projectDeployment.create({
        data: {
          companyId: access.project.companyId,
          releaseId,
          environmentId: env.id,
          deployedAt,
          deployedBy: actor.userId,
          note,
          overrideReason:
            env.kind === 'production' && overrideReason
              ? overrideReason.slice(0, MAX_RELEASE_TEXT)
              : null,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.release.deployed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            deploymentId: row.id,
            version: release.version,
            environment: env.name,
            kind: env.kind,
            overrideReason: row.overrideReason,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  /** Blockers still open: defects (CD-213) and UAT points (CD-222). */
  private async blockers(projectId: string) {
    const [defects, findings] = await Promise.all([
      this.defects.count({
        where: {
          projectId,
          severity: 'blocker',
          status: { in: [...OPEN_DEFECT] },
        },
      }),
      this.uatFindings.count({
        where: {
          projectId,
          severity: 'blocker',
          status: { in: ['open', 'fixed'] },
        },
      }),
    ]);
    return defects + findings;
  }

  private async envRows(projectId: string) {
    const rows = (await this.environments.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, name: true, url: true, note: true },
    })) as EnvRow[];
    return rows.sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
    );
  }

  private async deployRows(projectId: string) {
    return (await this.deployments.findMany({
      where: { release: { projectId } },
    })) as DeployRow[];
  }

  private async requireEnv(projectId: string, envId: string) {
    const row = (await this.environments.findFirst({
      where: { id: envId, projectId, deletedAt: null },
      select: { id: true, kind: true, name: true, url: true, note: true },
    })) as EnvRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบ environment นี้');
    return row;
  }

  private fail(problems: string[], field: string) {
    if (!problems.length) return;
    throw new AppError(
      'VALIDATION_FAILED',
      problems[0],
      problems.map((reason) => ({ field, reason })),
    );
  }

  private async manager(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'ตั้ง environment ได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    return access;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึก release ได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private mayWrite(access: Access, actor: Principal) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return (
      running &&
      (access.canEdit ||
        access.project.members.some((member) => member.userId === actor.userId))
    );
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
