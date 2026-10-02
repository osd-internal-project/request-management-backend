import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  configProblems,
  MASK,
  matchesSearch,
  MAX_CONFIG_REASON,
  openSecret,
  sealSecret,
} from './config-rules';
import { SaveConfigItemDto } from './dto/project.dto';
import {
  ProjectConfigHistoryRepository,
  ProjectConfigItemRepository,
  ProjectEnvironmentRepository,
  ProjectInstallationRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

interface ItemRow {
  id: string;
  seq: number;
  system: string;
  installationId: string | null;
  environmentId: string | null;
  key: string;
  value: string | null;
  isSecret: boolean;
  secretSealed: string | null;
  note: string | null;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string | null;
}

interface HistoryRow {
  id: string;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  oldSealed: string | null;
  newSealed: string | null;
  reason: string | null;
  actorId: string;
  at: Date;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const ITEM_SELECT = {
  id: true,
  seq: true,
  system: true,
  installationId: true,
  environmentId: true,
  key: true,
  value: true,
  isSecret: true,
  secretSealed: true,
  note: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} as const;

/**
 * CD-217 ตั้งค่าระบบ — configuration kept as data that can be searched,
 * not only as attachments: system + key + value, on an installation point
 * (CD-216), a software environment (CD-214) or a named system. A secret is
 * stored encrypted and shown masked; the team may reveal one at a time and
 * every reveal is recorded. Every change keeps the old and the new value
 * (sealed for a secret) with its reason, and any of them can be restored.
 *
 * Who: whoever sees the project reads it (secrets masked); the team (the
 * manager and members) writes, reveals and restores while the project
 * runs; the writer of a value or the manager removes it.
 */
@Injectable()
export class ConfigsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly items: ProjectConfigItemRepository,
    private readonly history: ProjectConfigHistoryRepository,
    private readonly installations: ProjectInstallationRepository,
    private readonly environments: ProjectEnvironmentRepository,
    private readonly people: CompanyMemberRepository,
    private readonly config: ConfigService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal, q = '') {
    const access = await this.projects.access(projectId, actor);
    const [rows, points, envs] = await Promise.all([
      this.rows(projectId),
      this.pointRows(projectId),
      this.envRows(projectId),
    ]);
    const names = await this.displayNames(
      rows.map((row) => row.updatedBy ?? row.createdBy),
    );
    const point = new Map(points.map((row) => [row.id, row]));
    const env = new Map(envs.map((row) => [row.id, row]));
    return {
      canWrite: this.mayWrite(access, actor),
      canEdit: access.canEdit,
      installations: points.map((row) => ({
        id: row.id,
        label: this.pointLabel(row),
      })),
      environments: envs.map((row) => ({
        id: row.id,
        label: `${row.kind} · ${row.name}`,
      })),
      items: rows
        .filter((row) => matchesSearch(row, q))
        .map((row) => ({
          id: row.id,
          label: `C-${row.seq}`,
          system: row.system,
          installationId: row.installationId,
          installationLabel: row.installationId
            ? this.pointLabel(point.get(row.installationId))
            : null,
          environmentId: row.environmentId,
          environmentLabel: row.environmentId
            ? (env.get(row.environmentId)?.name ?? null)
            : null,
          key: row.key,
          value: row.isSecret ? MASK : row.value,
          isSecret: row.isSecret,
          note: row.note,
          updatedAt: row.updatedAt.toISOString(),
          updatedByName: names.get(row.updatedBy ?? row.createdBy) ?? null,
          mayRemove: access.canEdit || row.createdBy === actor.userId,
        })),
    };
  }

  /** CD-217 — across every project the person may see; secrets never match. */
  async search(actor: Principal, q: string) {
    const query = q.trim();
    if (query.length < 2) {
      throw new AppError('VALIDATION_FAILED', 'พิมพ์อย่างน้อย 2 ตัวอักษร', [
        { field: 'q', reason: 'min 2' },
      ]);
    }
    const projects = await this.projects.visible(actor, {});
    if (!projects.length) return [];
    const like = { contains: query, mode: 'insensitive' as const };
    const rows = (await this.items.findMany({
      where: {
        projectId: { in: projects.map((row) => row.id) },
        deletedAt: null,
        OR: [
          { system: like },
          { key: like },
          { note: like },
          { isSecret: false, value: like },
        ],
      },
      orderBy: [{ projectId: 'asc' }, { seq: 'asc' }],
      take: 200,
      select: { ...ITEM_SELECT, projectId: true },
    })) as (ItemRow & { projectId: string })[];
    const project = new Map(projects.map((row) => [row.id, row]));
    return rows.map((row) => ({
      projectId: row.projectId,
      projectNo: project.get(row.projectId)?.projectNo ?? '',
      projectName: project.get(row.projectId)?.name ?? '',
      label: `C-${row.seq}`,
      system: row.system,
      key: row.key,
      value: row.isSecret ? MASK : row.value,
      isSecret: row.isSecret,
    }));
  }

  async add(projectId: string, dto: SaveConfigItemDto, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const input = await this.input(projectId, dto, null);
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectConfigItem.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectConfigItem.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          ...input.fields,
          createdBy: actor.userId,
        },
        select: { id: true, seq: true },
      });
      await prisma.projectConfigHistory.create({
        data: {
          companyId: access.project.companyId,
          itemId: row.id,
          action: 'created',
          newValue: input.fields.value,
          newSealed: input.fields.secretSealed,
          reason: input.reason,
          actorId: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.config.added',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          // never the secret, not even sealed
          after: {
            itemId: row.id,
            label: `C-${row.seq}`,
            system: input.fields.system,
            key: input.fields.key,
            isSecret: input.fields.isSecret,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async update(
    projectId: string,
    itemId: string,
    dto: SaveConfigItemDto,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireItem(projectId, itemId);
    const input = await this.input(projectId, dto, current);
    await this.transactions.execute(async (prisma) => {
      await prisma.projectConfigItem.update({
        where: { id: itemId },
        data: { ...input.fields, updatedBy: actor.userId },
      });
      await prisma.projectConfigHistory.create({
        data: {
          companyId: access.project.companyId,
          itemId,
          action: 'updated',
          oldValue: current.value,
          oldSealed: current.secretSealed,
          newValue: input.fields.value,
          newSealed: input.fields.secretSealed,
          reason: input.reason,
          actorId: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.config.updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            itemId,
            key: input.fields.key,
            isSecret: input.fields.isSecret,
            reason: input.reason,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Back to the value a history entry set, with the reason. */
  async restore(
    projectId: string,
    itemId: string,
    historyId: string,
    reason: string,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireItem(projectId, itemId);
    const entry = (await this.history.findFirst({
      where: { id: historyId, itemId },
    })) as HistoryRow | null;
    if (!entry || (entry.newValue === null && entry.newSealed === null)) {
      throw new AppError('NOT_FOUND', 'ไม่พบค่าที่จะคืน');
    }
    const why = reason.trim().slice(0, MAX_CONFIG_REASON);
    if (!why) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่เปลี่ยน', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    const isSecret = entry.newSealed !== null;
    await this.transactions.execute(async (prisma) => {
      await prisma.projectConfigItem.update({
        where: { id: itemId },
        data: {
          isSecret,
          value: isSecret ? null : entry.newValue,
          secretSealed: entry.newSealed,
          updatedBy: actor.userId,
        },
      });
      await prisma.projectConfigHistory.create({
        data: {
          companyId: access.project.companyId,
          itemId,
          action: 'restored',
          oldValue: current.value,
          oldSealed: current.secretSealed,
          newValue: isSecret ? null : entry.newValue,
          newSealed: entry.newSealed,
          reason: why,
          actorId: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.config.restored',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { itemId, fromHistoryId: historyId, reason: why },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** Off the list (its writer or the manager); its history stays. */
  async remove(
    projectId: string,
    itemId: string,
    reason: string,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requireItem(projectId, itemId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'นำออกได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    const why = reason.trim().slice(0, MAX_CONFIG_REASON);
    if (!why) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่นำออก', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectConfigItem.update({
        where: { id: itemId },
        data: { deletedAt: new Date(), deletedBy: actor.userId },
      });
      await prisma.projectConfigHistory.create({
        data: {
          companyId: access.project.companyId,
          itemId,
          action: 'removed',
          oldValue: current.value,
          oldSealed: current.secretSealed,
          reason: why,
          actorId: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.config.removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { itemId, key: current.key, reason: why },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** A secret shown to the team, one at a time; every time is recorded. */
  async reveal(projectId: string, itemId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.onTeam(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'ดูค่าลับได้เฉพาะผู้จัดการโครงการและสมาชิกทีม',
      );
    }
    const item = await this.requireItem(projectId, itemId);
    if (!item.isSecret || !item.secretSealed) {
      throw new AppError('VALIDATION_FAILED', 'ค่านี้ไม่ใช่ค่าลับ');
    }
    const value = openSecret(item.secretSealed, this.secret());
    if (value === null) {
      throw new AppError(
        'CONFLICT',
        'ถอดรหัสค่านี้ไม่ได้ — กุญแจเข้ารหัส (CONFIG_SECRET_KEY) อาจถูกเปลี่ยน',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectConfigHistory.create({
        data: {
          companyId: access.project.companyId,
          itemId,
          action: 'revealed',
          actorId: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.config.revealed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { itemId, key: item.key },
        },
        { prisma },
      );
    });
    return { value };
  }

  /** A value's history; secrets masked. */
  async historyOf(projectId: string, itemId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    // a removed value's history is still read
    const item = (await this.items.findFirst({
      where: { id: itemId, projectId },
      select: { id: true },
    })) as { id: string } | null;
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบค่าตั้งค่า');
    const rows = (await this.history.findMany({
      where: { itemId },
      orderBy: { at: 'desc' },
    })) as HistoryRow[];
    const names = await this.displayNames(rows.map((row) => row.actorId));
    const shown = (value: string | null, sealed: string | null) =>
      sealed ? MASK : value;
    return {
      canRestore: this.mayWrite(access, actor),
      entries: rows.map((row) => ({
        id: row.id,
        action: row.action,
        oldValue: shown(row.oldValue, row.oldSealed),
        newValue: shown(row.newValue, row.newSealed),
        restorable:
          ['created', 'updated', 'restored'].includes(row.action) &&
          (row.newValue !== null || row.newSealed !== null),
        reason: row.reason,
        actorName: names.get(row.actorId) ?? null,
        at: row.at.toISOString(),
      })),
    };
  }

  // --- helpers -----------------------------------------------------------------------

  /** What to store, from what was sent over what is there. */
  private async input(
    projectId: string,
    dto: SaveConfigItemDto,
    current: ItemRow | null,
  ) {
    const system = (dto.system ?? current?.system ?? '').trim();
    const key = (dto.key ?? current?.key ?? '').trim();
    const isSecret = dto.is_secret ?? current?.isSecret ?? false;
    const given = dto.value;
    // a secret kept as it is: only when it was a secret already
    const keepSecret =
      isSecret && Boolean(current?.isSecret) && (given ?? '') === '';
    const value =
      given ??
      (current && !current.isSecret && !isSecret ? (current.value ?? '') : '');
    const installationId =
      dto.installation_id === undefined
        ? (current?.installationId ?? null)
        : dto.installation_id || null;
    const environmentId =
      dto.environment_id === undefined
        ? (current?.environmentId ?? null)
        : dto.environment_id || null;
    const reason = (dto.reason ?? '').trim().slice(0, MAX_CONFIG_REASON);
    const problems = configProblems({
      system,
      key,
      value,
      isSecret,
      keepSecret,
      reason,
      needsReason: current !== null,
    });
    if (installationId && environmentId) {
      problems.push('ผูกได้ทีละอย่าง: จุดติดตั้ง หรือ environment');
    }
    if (installationId) {
      const found = await this.installations.count({
        where: { id: installationId, projectId, deletedAt: null },
      });
      if (!found) problems.push('ไม่พบจุดติดตั้งนี้ในโครงการ');
    }
    if (environmentId) {
      const found = await this.environments.count({
        where: { id: environmentId, projectId, deletedAt: null },
      });
      if (!found) problems.push('ไม่พบ environment นี้ในโครงการ');
    }
    if (system && key) {
      const clash = await this.items.count({
        where: {
          projectId,
          deletedAt: null,
          installationId,
          environmentId,
          system: { equals: system, mode: 'insensitive' },
          key: { equals: key, mode: 'insensitive' },
          ...(current ? { id: { not: current.id } } : {}),
        },
      });
      if (clash) problems.push('มีค่านี้ในระบบเดียวกันแล้ว');
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'config', reason })),
      );
    }
    let secretSealed: string | null = null;
    if (isSecret) {
      secretSealed = keepSecret
        ? current!.secretSealed
        : sealSecret(value, this.secret());
    }
    return {
      reason: reason || null,
      fields: {
        system,
        key,
        installationId,
        environmentId,
        isSecret,
        value: isSecret ? null : value,
        secretSealed,
        note:
          dto.note === undefined
            ? (current?.note ?? null)
            : dto.note.trim() || null,
      },
    };
  }

  private secret(): string {
    const secret = this.config.get<string>('projectConfig.secret');
    if (!secret) throw new Error('CONFIG_SECRET_KEY is not set');
    return secret;
  }

  private async rows(projectId: string) {
    return (await this.items.findMany({
      where: { projectId, deletedAt: null },
      orderBy: [{ system: 'asc' }, { seq: 'asc' }],
      select: ITEM_SELECT,
    })) as ItemRow[];
  }

  private async pointRows(projectId: string) {
    return (await this.installations.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, location: true, serialNo: true },
    })) as {
      id: string;
      seq: number;
      location: string;
      serialNo: string | null;
    }[];
  }

  private async envRows(projectId: string) {
    return (await this.environments.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, name: true },
    })) as { id: string; kind: string; name: string }[];
  }

  private pointLabel(
    row: { seq: number; location: string; serialNo: string | null } | undefined,
  ) {
    if (!row) return null;
    return [`P-${row.seq}`, row.location, row.serialNo]
      .filter(Boolean)
      .join(' · ');
  }

  private async requireItem(projectId: string, itemId: string) {
    const row = (await this.items.findFirst({
      where: { id: itemId, projectId, deletedAt: null },
      select: ITEM_SELECT,
    })) as ItemRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบค่าตั้งค่า');
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกค่าตั้งค่าได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private onTeam(access: Access, actor: Principal) {
    return (
      access.canEdit ||
      access.project.managerUserId === actor.userId ||
      access.project.members.some((member) => member.userId === actor.userId)
    );
  }

  private mayWrite(access: Access, actor: Principal) {
    const running =
      access.project.status === 'active' || access.project.status === 'on_hold';
    return running && this.onTeam(access, actor);
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
