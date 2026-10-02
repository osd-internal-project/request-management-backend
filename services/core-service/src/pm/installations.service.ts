import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { bangkokDay } from '../crm/kyc-rules';
import { safeFileName } from '../requests/attachments.service';
import { SaveInstallationDto } from './dto/project.dto';
import {
  boqChoices,
  boqMatch,
  MAX_INSTALL_TEXT,
  pointProblems,
} from './installation-rules';
import { MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectInstallationRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'];

interface PointRow {
  id: string;
  seq: number;
  location: string;
  boqIndex: number | null;
  serialNo: string | null;
  note: string | null;
  installedOn: Date | null;
  installedBy: string | null;
  beforeKey: string | null;
  beforeName: string | null;
  afterKey: string | null;
  afterName: string | null;
  createdBy: string;
}

interface UploadedPhoto {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

export interface PointPhotos {
  before?: UploadedPhoto[];
  after?: UploadedPhoto[];
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-216 ติดตั้ง — installation point by point: where, which BOQ line, the
 * unit's serial (typed in until SAP reads it, CD-28), photos before and
 * after. Installed units of each equipment line are counted against the
 * BOQ; a line that does not match needs an as-built deviation (CD-226)
 * pointing at it before the as-built is complete.
 *
 * Who: whoever sees the project reads it; the team records points; a point
 * is removed by whoever recorded it or the manager.
 */
@Injectable()
export class InstallationsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly points: ProjectInstallationRepository,
    private readonly people: CompanyMemberRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [baseline, rows] = await Promise.all([
      this.baseline(projectId),
      this.rows(projectId),
    ]);
    const choices = boqChoices(baseline);
    const names = await this.displayNames(
      rows.flatMap((row) => [row.installedBy, row.createdBy]),
    );
    return {
      canEdit: access.canEdit,
      canWrite: this.mayWrite(access, actor),
      boq: boqMatch(baseline, rows),
      choices,
      installed: rows.filter((row) => row.installedOn).length,
      points: rows.map((row) => ({
        id: row.id,
        label: `P-${row.seq}`,
        location: row.location,
        boqIndex: row.boqIndex,
        boqLabel:
          row.boqIndex === null ? null : (choices[row.boqIndex]?.label ?? null),
        serialNo: row.serialNo,
        note: row.note,
        installedOn: day(row.installedOn),
        installedByName: row.installedBy
          ? (names.get(row.installedBy) ?? null)
          : null,
        beforeName: row.beforeName,
        afterName: row.afterName,
        mayRemove:
          this.mayWrite(access, actor) &&
          (access.canEdit || row.createdBy === actor.userId),
      })),
    };
  }

  async add(
    projectId: string,
    dto: SaveInstallationDto,
    photos: PointPhotos,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    return this.save(access, null, dto, photos, actor, now);
  }

  async update(
    projectId: string,
    pointId: string,
    dto: SaveInstallationDto,
    photos: PointPhotos,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.requirePoint(projectId, pointId);
    return this.save(access, current, dto, photos, actor, now);
  }

  /** Off the list (its recorder or the manager); the serial is freed. */
  async remove(projectId: string, pointId: string, actor: Principal) {
    const access = await this.writer(projectId, actor);
    const current = await this.requirePoint(projectId, pointId);
    if (!access.canEdit && current.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'ลบได้เฉพาะผู้บันทึก หรือผู้จัดการโครงการ',
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.points.update(
        {
          where: { id: pointId },
          data: {
            deletedAt: new Date(),
            serialNo: null,
            note:
              [current.note, current.serialNo && `ถอดออก: ${current.serialNo}`]
                .filter(Boolean)
                .join(' · ') || null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.installation.removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: {
            pointId,
            label: `P-${current.seq}`,
            serialNo: current.serialNo,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  async photo(
    projectId: string,
    pointId: string,
    which: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const row = (await this.points.findFirst({
      where: { id: pointId, projectId, deletedAt: null },
      select: {
        beforeKey: true,
        beforeName: true,
        beforeMime: true,
        afterKey: true,
        afterName: true,
        afterMime: true,
      },
    })) as Record<string, string | null> | null;
    const side = which === 'before' ? 'before' : 'after';
    const key = row?.[`${side}Key`];
    if (!row || !key) throw new AppError('NOT_FOUND', 'ไม่พบรูป');
    return {
      stream: await this.storage.get(key),
      fileName: row[`${side}Name`] ?? `${side}.jpg`,
      mimeType: row[`${side}Mime`] ?? 'image/jpeg',
    };
  }

  // --- helpers -----------------------------------------------------------------------

  private async save(
    access: Access,
    current: PointRow | null,
    dto: SaveInstallationDto,
    photos: PointPhotos,
    actor: Principal,
    now: Date,
  ) {
    const projectId = access.project.id;
    const choices = boqChoices(await this.baseline(projectId));
    const before = photos.before?.[0];
    const after = photos.after?.[0];
    const boqIndex =
      dto.boq_index === undefined
        ? (current?.boqIndex ?? null)
        : dto.boq_index === '' || dto.boq_index === null
          ? null
          : Number(dto.boq_index);
    const input = {
      location: (dto.location ?? current?.location ?? '').trim(),
      boqIndex: Number.isInteger(boqIndex) ? boqIndex : null,
      serialNo:
        dto.serial_no === undefined
          ? (current?.serialNo ?? null)
          : dto.serial_no.trim().slice(0, 100) || null,
      note:
        dto.note === undefined
          ? (current?.note ?? null)
          : dto.note.trim().slice(0, MAX_INSTALL_TEXT) || null,
      installedOn:
        dto.installed_on === undefined
          ? day(current?.installedOn ?? null)
          : dto.installed_on.slice(0, 10) || null,
    };
    const problems = pointProblems({
      ...input,
      boqCount: choices.length,
      equipment:
        input.boqIndex !== null && Boolean(choices[input.boqIndex]?.equipment),
      hasAfter: Boolean(after) || Boolean(current?.afterKey),
      today: bangkokDay(now),
    });
    for (const file of [before, after]) {
      if (!file) continue;
      if (!PHOTO_TYPES.includes(file.mimetype)) {
        problems.push('รูปต้องเป็น JPG PNG HEIC หรือ WEBP');
      }
      if (file.size > MAX_EVIDENCE_BYTES) problems.push('รูปใหญ่เกิน 25 MB');
    }
    if (input.serialNo) {
      const taken = await this.points.findFirst({
        where: {
          projectId,
          serialNo: input.serialNo,
          ...(current ? { id: { not: current.id } } : {}),
        },
        select: { seq: true },
      });
      if (taken) {
        problems.push(
          `หมายเลขเครื่องนี้บันทึกไว้แล้วที่ P-${(taken as { seq: number }).seq}`,
        );
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'installation', reason })),
      );
    }
    const id = current?.id ?? randomUUID();
    const stored: {
      key: string;
      side: 'before' | 'after';
      file: UploadedPhoto;
    }[] = [];
    for (const [side, file] of [
      ['before', before],
      ['after', after],
    ] as const) {
      if (!file) continue;
      const key = `projects/${projectId}/installations/${id}/${randomUUID()}/${safeFileName(file.originalname)}`;
      await this.storage.put(key, file.buffer, {
        contentType: file.mimetype,
        size: file.size,
      });
      stored.push({ key, side, file });
    }
    const photoData = Object.fromEntries(
      stored.flatMap((item) => [
        [`${item.side}Key`, item.key],
        [`${item.side}Name`, safeFileName(item.file.originalname)],
        [`${item.side}Mime`, item.file.mimetype],
      ]),
    );
    const installedNow = Boolean(input.installedOn) && !current?.installedOn;
    const data = {
      ...input,
      installedOn: input.installedOn
        ? new Date(`${input.installedOn}T00:00:00Z`)
        : null,
      installedBy: input.installedOn
        ? installedNow
          ? actor.userId
          : (current?.installedBy ?? actor.userId)
        : null,
      ...photoData,
    };
    try {
      await this.transactions.execute(async (prisma) => {
        if (current) {
          await prisma.projectInstallation.update({
            where: { id },
            data: { ...data, updatedBy: actor.userId },
          });
        } else {
          const last = await prisma.projectInstallation.findFirst({
            where: { projectId },
            orderBy: { seq: 'desc' },
            select: { seq: true },
          });
          await prisma.projectInstallation.create({
            data: {
              id,
              companyId: access.project.companyId,
              projectId,
              seq: (last?.seq ?? 0) + 1,
              ...data,
              createdBy: actor.userId,
            },
          });
        }
        await this.audit.record(
          {
            eventType: current
              ? 'pm.installation.updated'
              : 'pm.installation.added',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              pointId: id,
              ...input,
              photos: stored.map((item) => item.side),
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      for (const item of stored) {
        await this.storage.remove(item.key).catch(() => undefined);
      }
      throw error;
    }
    return this.view(projectId, actor);
  }

  private async baseline(projectId: string) {
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { baseline: true },
    })) as { baseline: unknown } | null;
    return row?.baseline ?? null;
  }

  private async rows(projectId: string) {
    return (await this.points.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { seq: 'asc' },
    })) as PointRow[];
  }

  private async requirePoint(projectId: string, pointId: string) {
    const row = (await this.points.findFirst({
      where: { id: pointId, projectId, deletedAt: null },
    })) as PointRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบจุดติดตั้ง');
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกงานติดตั้งได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
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
