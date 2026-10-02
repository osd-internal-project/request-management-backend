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
import { ChangeRequestsService } from './change-requests.service';
import { SaveSurveyDto, SurveyPhotoDto } from './dto/project.dto';
import { MAX_EVIDENCE_BYTES } from './milestones.service';
import {
  ProjectRepository,
  ProjectSurveyPhotoRepository,
  ProjectSurveyRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import {
  baselineAssumptions,
  changeFromAssumption,
  completeProblems,
  MAX_SURVEY_TEXT,
  mergeAssumptions,
  type SurveyAssumption,
  surveyProblems,
} from './survey-rules';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SURVEY_PHOTOS = 50;

interface SurveyRow {
  id: string;
  projectId: string;
  seq: number;
  site: string;
  surveyedOn: Date;
  latitude: unknown;
  longitude: unknown;
  summary: string | null;
  assumptions: unknown;
  status: string;
  completedAt: Date | null;
  completedBy: string | null;
  createdBy: string;
}

interface PhotoRow {
  id: string;
  surveyId: string;
  caption: string | null;
  latitude: unknown;
  longitude: unknown;
  takenAt: Date | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedBy: string;
}

interface UploadedPhoto {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date) => value.toISOString().slice(0, 10);
const num = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);
const coordinate = (value: string | undefined) => {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
};

/**
 * CD-210 สำรวจหน้างาน — a survey made on a phone, often where there is no
 * signal: the device keeps the draft and syncs it later, so a survey and
 * each photo carry an id the device made, and syncing again only updates.
 * The survey walks the Solution's assumptions from the baseline one by one;
 * one that does not hold on site becomes a change request before the
 * survey can be completed.
 *
 * Who: whoever sees the project reads; the team syncs drafts while the
 * project runs; the manager turns an assumption into a change request; the
 * manager or whoever made the survey completes it.
 */
@Injectable()
export class SurveysService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly projectRows: ProjectRepository,
    private readonly surveys: ProjectSurveyRepository,
    private readonly photos: ProjectSurveyPhotoRepository,
    private readonly changes: ChangeRequestsService,
    private readonly people: CompanyMemberRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    const [texts, rows] = await Promise.all([
      this.assumptionTexts(projectId),
      this.surveys.findMany({
        where: { projectId },
        orderBy: { seq: 'asc' },
      }) as Promise<SurveyRow[]>,
    ]);
    const photos = rows.length
      ? ((await this.photos.findMany({
          where: { surveyId: { in: rows.map((row) => row.id) } },
          orderBy: { uploadedAt: 'asc' },
        })) as PhotoRow[])
      : [];
    const names = await this.displayNames(
      rows.flatMap((row) => [row.createdBy, row.completedBy]),
    );
    const canWrite = this.mayWrite(access, actor);
    return {
      canEdit: access.canEdit,
      canWrite,
      assumptions: texts,
      surveys: rows.map((row) => {
        const assumptions = mergeAssumptions(texts, row.assumptions);
        const draft = row.status === 'draft';
        return {
          id: row.id,
          label: `S-${row.seq}`,
          site: row.site,
          surveyedOn: day(row.surveyedOn),
          latitude: num(row.latitude),
          longitude: num(row.longitude),
          summary: row.summary,
          status: row.status,
          assumptions,
          problems: draft ? completeProblems(assumptions) : [],
          createdByName: names.get(row.createdBy) ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          completedByName: row.completedBy
            ? (names.get(row.completedBy) ?? null)
            : null,
          mayEdit: draft && canWrite,
          mayComplete:
            draft &&
            canWrite &&
            (access.canEdit || row.createdBy === actor.userId),
          photos: photos
            .filter((photo) => photo.surveyId === row.id)
            .map((photo) => ({
              id: photo.id,
              caption: photo.caption,
              latitude: num(photo.latitude),
              longitude: num(photo.longitude),
              takenAt: photo.takenAt?.toISOString() ?? null,
              fileName: photo.fileName,
              sizeBytes: photo.sizeBytes,
            })),
        };
      }),
    };
  }

  /** Sync a draft from the device: made on first sync, updated after. */
  async save(
    projectId: string,
    dto: SaveSurveyDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const current = await this.find(dto.id);
    if (current && current.projectId !== projectId) {
      throw new AppError('CONFLICT', 'รหัสการสำรวจนี้เป็นของโครงการอื่น');
    }
    if (current && current.status !== 'draft') {
      throw new AppError('CONFLICT', 'การสำรวจนี้ปิดแล้ว แก้ไม่ได้');
    }
    const texts = await this.assumptionTexts(projectId);
    const input = {
      site: (dto.site ?? current?.site ?? '').trim().slice(0, 1000),
      surveyedOn:
        dto.surveyed_on?.slice(0, 10) ||
        (current ? day(current.surveyedOn) : null),
      latitude:
        dto.latitude === undefined
          ? num(current?.latitude)
          : (dto.latitude ?? null),
      longitude:
        dto.longitude === undefined
          ? num(current?.longitude)
          : (dto.longitude ?? null),
      summary:
        dto.summary === undefined
          ? (current?.summary ?? null)
          : dto.summary.trim().slice(0, MAX_SURVEY_TEXT) || null,
      assumptions: mergeAssumptions(
        texts,
        current?.assumptions ?? [],
        dto.assumptions,
      ),
    };
    const problems = surveyProblems({
      id: dto.id,
      site: input.site,
      surveyedOn: input.surveyedOn,
      latitude: input.latitude,
      longitude: input.longitude,
      today: bangkokDay(now),
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'survey', reason })),
      );
    }
    const data = {
      ...input,
      surveyedOn: new Date(`${input.surveyedOn}T00:00:00Z`),
      assumptions: input.assumptions as object[],
    };
    await this.transactions.execute(async (prisma) => {
      if (current) {
        await prisma.projectSurvey.update({
          where: { id: current.id },
          data: { ...data, updatedBy: actor.userId },
        });
      } else {
        const last = await prisma.projectSurvey.findFirst({
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        await prisma.projectSurvey.create({
          data: {
            id: dto.id,
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
          eventType: current ? 'pm.survey.updated' : 'pm.survey.created',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            surveyId: dto.id,
            site: input.site,
            surveyedOn: input.surveyedOn,
            differs: input.assumptions
              .filter((row) => row.holds === false)
              .map((row) => row.index),
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /** A photo from the device; one already synced is left as it is. */
  async addPhoto(
    projectId: string,
    surveyId: string,
    dto: SurveyPhotoDto,
    file: UploadedPhoto | undefined,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const survey = await this.requireSurvey(projectId, surveyId);
    const existing = (await this.photos.findFirst({
      where: { id: dto.id },
      select: { surveyId: true },
    })) as { surveyId: string } | null;
    if (existing) {
      if (existing.surveyId !== surveyId) {
        throw new AppError('CONFLICT', 'รหัสรูปนี้เป็นของการสำรวจอื่น');
      }
      return this.view(projectId, actor);
    }
    if (survey.status !== 'draft') {
      throw new AppError('CONFLICT', 'การสำรวจนี้ปิดแล้ว เพิ่มรูปไม่ได้');
    }
    const latitude = coordinate(dto.latitude);
    const longitude = coordinate(dto.longitude);
    const takenAt = dto.taken_at ? new Date(dto.taken_at) : null;
    const count = await this.photos.count({ where: { surveyId } });
    const problems = [
      ...(UUID.test(dto.id) ? [] : ['รหัสรูปต้องเป็น UUID ที่เครื่องสร้าง']),
      ...(!file ? ['ต้องแนบรูป'] : []),
      ...(file && !PHOTO_TYPES.includes(file.mimetype)
        ? ['รูปต้องเป็น JPG PNG HEIC หรือ WEBP']
        : []),
      ...(file && file.size > MAX_EVIDENCE_BYTES ? ['รูปใหญ่เกิน 25 MB'] : []),
      ...(count >= MAX_SURVEY_PHOTOS
        ? [`การสำรวจหนึ่งครั้งมีรูปได้ไม่เกิน ${MAX_SURVEY_PHOTOS} รูป`]
        : []),
      ...(latitude !== null &&
      (Number.isNaN(latitude) || latitude < -90 || latitude > 90)
        ? ['ละติจูดไม่ถูกต้อง']
        : []),
      ...(longitude !== null &&
      (Number.isNaN(longitude) || longitude < -180 || longitude > 180)
        ? ['ลองจิจูดไม่ถูกต้อง']
        : []),
      ...(takenAt && Number.isNaN(takenAt.getTime())
        ? ['เวลาที่ถ่ายไม่ถูกต้อง']
        : []),
    ];
    if (problems.length || !file) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'photo', reason })),
      );
    }
    const fileName = safeFileName(file.originalname);
    const key = `projects/${projectId}/surveys/${surveyId}/${randomUUID()}/${fileName}`;
    await this.storage.put(key, file.buffer, {
      contentType: file.mimetype,
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await prisma.projectSurveyPhoto.create({
          data: {
            id: dto.id,
            companyId: access.project.companyId,
            surveyId,
            caption: dto.caption?.trim().slice(0, 500) || null,
            latitude,
            longitude,
            takenAt,
            fileName,
            mimeType: file.mimetype,
            sizeBytes: file.size,
            storageKey: key,
            uploadedBy: actor.userId,
          },
        });
        await this.audit.record(
          {
            eventType: 'pm.survey.photo_added',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: { surveyId, photoId: dto.id, fileName },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage.remove(key).catch(() => undefined);
      throw error;
    }
    return this.view(projectId, actor);
  }

  /** Off a draft (whoever took it, or the manager). */
  async removePhoto(
    projectId: string,
    surveyId: string,
    photoId: string,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    const survey = await this.requireSurvey(projectId, surveyId);
    if (survey.status !== 'draft') {
      throw new AppError('CONFLICT', 'การสำรวจนี้ปิดแล้ว ลบรูปไม่ได้');
    }
    const photo = (await this.photos.findFirst({
      where: { id: photoId, surveyId },
    })) as PhotoRow | null;
    if (!photo) throw new AppError('NOT_FOUND', 'ไม่พบรูป');
    if (!access.canEdit && photo.uploadedBy !== actor.userId) {
      throw new AppError('FORBIDDEN', 'ลบได้เฉพาะผู้ถ่าย หรือผู้จัดการโครงการ');
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectSurveyPhoto.delete({ where: { id: photoId } });
      await this.audit.record(
        {
          eventType: 'pm.survey.photo_removed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { surveyId, photoId, fileName: photo.fileName },
        },
        { prisma },
      );
    });
    await this.storage.remove(photo.storageKey).catch(() => undefined);
    return this.view(projectId, actor);
  }

  async photo(
    projectId: string,
    surveyId: string,
    photoId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    await this.requireSurvey(projectId, surveyId);
    const photo = (await this.photos.findFirst({
      where: { id: photoId, surveyId },
    })) as PhotoRow | null;
    if (!photo) throw new AppError('NOT_FOUND', 'ไม่พบรูป');
    return {
      stream: await this.storage.get(photo.storageKey),
      fileName: photo.fileName,
      mimeType: photo.mimeType,
    };
  }

  /** The manager turns an assumption that does not hold into a change request. */
  async toChange(
    projectId: string,
    surveyId: string,
    index: number,
    actor: Principal,
  ) {
    const access = await this.writer(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'แปลงเป็นคำขอเปลี่ยนแปลงได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const survey = await this.requireSurvey(projectId, surveyId);
    if (survey.status !== 'draft') {
      throw new AppError('CONFLICT', 'การสำรวจนี้ปิดแล้ว');
    }
    const assumptions = mergeAssumptions(
      await this.assumptionTexts(projectId),
      survey.assumptions,
    );
    const row = assumptions[index];
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบสมมติฐานข้อนี้');
    if (row.holds !== false || !row.note) {
      throw new AppError(
        'CONFLICT',
        'แปลงได้เฉพาะสมมติฐานที่บันทึกว่าไม่ตรง พร้อมบอกว่าไม่ตรงอย่างไร',
      );
    }
    if (row.changeRequestId) {
      throw new AppError(
        'CONFLICT',
        'สมมติฐานข้อนี้แปลงเป็นคำขอเปลี่ยนแปลงแล้ว',
      );
    }
    const created = await this.changes.create(
      projectId,
      changeFromAssumption({
        survey: `S-${survey.seq}`,
        site: survey.site,
        text: row.text,
        note: row.note,
      }),
      actor,
    );
    const next: SurveyAssumption[] = assumptions.map((item) =>
      item.index === index
        ? { ...item, changeRequestId: created.changeId }
        : item,
    );
    await this.surveys.update({
      where: { id: surveyId },
      data: { assumptions: next as object[], updatedBy: actor.userId },
    });
    return {
      ...(await this.view(projectId, actor)),
      changeId: created.changeId,
    };
  }

  async complete(
    projectId: string,
    surveyId: string,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.writer(projectId, actor);
    const survey = await this.requireSurvey(projectId, surveyId);
    if (!access.canEdit && survey.createdBy !== actor.userId) {
      throw new AppError(
        'FORBIDDEN',
        'ปิดการสำรวจได้เฉพาะผู้สำรวจ หรือผู้จัดการโครงการ',
      );
    }
    if (survey.status !== 'draft') {
      throw new AppError('CONFLICT', 'การสำรวจนี้ปิดแล้ว');
    }
    const assumptions = mergeAssumptions(
      await this.assumptionTexts(projectId),
      survey.assumptions,
    );
    const problems = completeProblems(assumptions);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'assumptions', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.projectSurvey.update({
        where: { id: surveyId },
        data: {
          status: 'completed',
          assumptions: [...assumptions] as object[],
          completedAt: now,
          completedBy: actor.userId,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'pm.survey.completed',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            surveyId,
            label: `S-${survey.seq}`,
            changes: assumptions
              .map((row) => row.changeRequestId)
              .filter(Boolean),
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  // --- helpers -----------------------------------------------------------------------

  private async assumptionTexts(projectId: string) {
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { baseline: true },
    })) as { baseline: unknown } | null;
    return baselineAssumptions(row?.baseline ?? null);
  }

  private async find(id: string) {
    if (!UUID.test(id)) return null;
    return (await this.surveys.findFirst({
      where: { id },
    })) as SurveyRow | null;
  }

  private async requireSurvey(projectId: string, surveyId: string) {
    const row = await this.find(surveyId);
    if (!row || row.projectId !== projectId) {
      throw new AppError('NOT_FOUND', 'ไม่พบการสำรวจ');
    }
    return row;
  }

  private async writer(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!this.mayWrite(access, actor)) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกการสำรวจได้เฉพาะทีมโครงการ ขณะโครงการยังดำเนินอยู่',
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
