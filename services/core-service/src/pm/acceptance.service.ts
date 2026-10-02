import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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
import { NotificationsService } from '../notifications/notifications.service';
import { safeFileName } from '../requests/attachments.service';
import {
  bookProblems,
  criteriaAccepted,
  followUp,
  MAX_ACCEPTANCE_TEXT,
  resultProblems,
} from './acceptance-rules';
import {
  AcceptanceItemDoneDto,
  BookAcceptanceDto,
  RecordAcceptanceDto,
} from './dto/project.dto';
import { readCriteria } from './milestone-rules';
import {
  EVIDENCE_TYPES,
  MAX_EVIDENCE_BYTES,
  MilestonesService,
} from './milestones.service';
import {
  ProjectAcceptanceItemRepository,
  ProjectAcceptanceRepository,
  ProjectMilestoneRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { ReadinessService } from './readiness.service';

interface RoundRow {
  id: string;
  seq: number;
  milestoneId: string | null;
  scheduledAt: Date;
  location: string | null;
  customerPeople: string | null;
  preparation: string | null;
  status: string;
  decidedOn: Date | null;
  outcomeNote: string | null;
  certificateName: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdBy: string;
  items: {
    id: string;
    seq: number;
    text: string;
    dueOn: Date;
    ownerUserId: string | null;
    status: string;
    doneNote: string | null;
    doneAt: Date | null;
    doneBy: string | null;
  }[];
}

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

type Access = Awaited<ReturnType<ProjectsService['access']>>;

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDay = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`);

/**
 * CD-189 เตรียมการตรวจรับ — acceptance with the customer, round by round:
 * booked (when, where, who comes, what is brought) only once the readiness
 * review passes (CD-225: tests, as-built, checklist, no open issue) and for
 * the milestone it accepts; then the result — accepted, accepted with
 * conditions (the open points followed until done) or rejected (why) — with
 * the certificate the customer signed. Accepted (or accepted with
 * conditions), the milestone is achieved with the certificate as its
 * evidence (CD-182), which tells Sales the installment may be billed.
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager books and records; an open point's owner (or the
 * manager) closes it.
 */
@Injectable()
export class AcceptanceService {
  private readonly logger = new Logger(AcceptanceService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly readiness: ReadinessService,
    private readonly milestoneService: MilestonesService,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly rounds: ProjectAcceptanceRepository,
    private readonly items: ProjectAcceptanceItemRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal, now = new Date()) {
    const access = await this.projects.access(projectId, actor);
    const [rows, state, milestones] = await Promise.all([
      this.rows(projectId),
      this.readiness.state(projectId, access.project.companyId),
      this.milestones.findMany({
        where: { projectId },
        orderBy: { seq: 'asc' },
        select: { id: true, seq: true, title: true, status: true },
      }) as Promise<
        { id: string; seq: number; title: string; status: string }[]
      >,
    ]);
    const today = bangkokDay(now);
    const names = await this.displayNames(
      rows.flatMap((row) => [
        row.decidedBy,
        ...row.items.flatMap((item) => [item.ownerUserId, item.doneBy]),
      ]),
    );
    return {
      canEdit: access.canEdit,
      readiness: state.readiness,
      milestones: milestones.map((row) => ({
        id: row.id,
        label: `${row.seq}. ${row.title}`,
        status: row.status,
      })),
      rounds: rows.map((row) => {
        const milestone = milestones.find((m) => m.id === row.milestoneId);
        return {
          id: row.id,
          label: `A-${row.seq}`,
          milestone: milestone
            ? {
                id: milestone.id,
                title: milestone.title,
                status: milestone.status,
              }
            : null,
          scheduledAt: row.scheduledAt,
          location: row.location,
          customerPeople: row.customerPeople,
          preparation: row.preparation,
          status: row.status,
          decidedOn: day(row.decidedOn),
          outcomeNote: row.outcomeNote,
          certificateName: row.certificateName,
          decidedByName: row.decidedBy
            ? (names.get(row.decidedBy) ?? null)
            : null,
          followUp: followUp(
            row.items.map((item) => ({
              status: item.status,
              dueOn: day(item.dueOn)!,
            })),
            today,
          ),
          items: row.items.map((item) => ({
            id: item.id,
            seq: item.seq,
            text: item.text,
            dueOn: day(item.dueOn),
            ownerUserId: item.ownerUserId,
            ownerName: item.ownerUserId
              ? (names.get(item.ownerUserId) ?? null)
              : null,
            status: item.status,
            overdue: item.status === 'open' && day(item.dueOn)! < today,
            doneNote: item.doneNote,
            doneAt: item.doneAt,
            doneByName: item.doneBy ? (names.get(item.doneBy) ?? null) : null,
            mayClose:
              item.status === 'open' &&
              this.running(access) &&
              (access.canEdit || item.ownerUserId === actor.userId),
          })),
        };
      }),
    };
  }

  /** Booked — only once the project is ready to be accepted. */
  async book(
    projectId: string,
    dto: BookAcceptanceDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const scheduledAt = dto.scheduled_at ? new Date(dto.scheduled_at) : null;
    const milestoneId = dto.milestone_id || null;
    const milestone = milestoneId
      ? ((await this.milestones.findFirst({
          where: { id: milestoneId, projectId },
          select: { status: true },
        })) as { status: string } | null)
      : null;
    if (milestoneId && !milestone) {
      throw new AppError('NOT_FOUND', 'ไม่พบ milestone ในโครงการนี้');
    }
    const [state, open] = await Promise.all([
      this.readiness.state(projectId, access.project.companyId),
      this.rounds.findFirst({
        where: { projectId, status: 'scheduled', milestoneId },
        select: { seq: true },
      }) as Promise<{ seq: number } | null>,
    ]);
    const problems = bookProblems({
      ready: state.readiness.ready,
      blockers: state.readiness.blockers,
      scheduledAt,
      now,
      openRound: open ? `A-${open.seq}` : null,
      milestoneStatus: milestone?.status ?? null,
    });
    if (problems.length || !scheduledAt) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'acceptance', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const last = await prisma.projectAcceptance.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const row = await prisma.projectAcceptance.create({
        data: {
          companyId: access.project.companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          milestoneId,
          scheduledAt,
          location: this.text(dto.location),
          customerPeople: this.text(dto.customer_people),
          preparation: this.text(dto.preparation),
          createdBy: actor.userId,
        },
        select: { id: true, seq: true },
      });
      await this.audit.record(
        {
          eventType: 'pm.acceptance.booked',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            acceptanceId: row.id,
            label: `A-${row.seq}`,
            milestoneId,
            scheduledAt,
          },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor, now);
  }

  /** Moved, or its details changed — while it is still booked. */
  async update(
    projectId: string,
    acceptanceId: string,
    dto: BookAcceptanceDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const row = await this.requireScheduled(projectId, acceptanceId);
    const scheduledAt = dto.scheduled_at ? new Date(dto.scheduled_at) : null;
    if (scheduledAt && scheduledAt.getTime() < now.getTime()) {
      throw new AppError('VALIDATION_FAILED', 'วันเวลานัดต้องไม่อยู่ในอดีต');
    }
    await this.transactions.execute(async (prisma) => {
      await this.rounds.update(
        {
          where: { id: acceptanceId },
          data: {
            scheduledAt: scheduledAt ?? undefined,
            location:
              dto.location === undefined ? undefined : this.text(dto.location),
            customerPeople:
              dto.customer_people === undefined
                ? undefined
                : this.text(dto.customer_people),
            preparation:
              dto.preparation === undefined
                ? undefined
                : this.text(dto.preparation),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.acceptance.updated',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          before: { acceptanceId, scheduledAt: row.scheduledAt },
          after: { acceptanceId, ...dto },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor, now);
  }

  async cancel(projectId: string, acceptanceId: string, actor: Principal) {
    const access = await this.editable(projectId, actor);
    await this.requireScheduled(projectId, acceptanceId);
    await this.transactions.execute(async (prisma) => {
      await this.rounds.update(
        {
          where: { id: acceptanceId },
          data: { status: 'cancelled', updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.acceptance.cancelled',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { acceptanceId },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor);
  }

  /**
   * The result, with the certificate the customer signed. Accepted (with
   * or without conditions), the milestone it was booked for is achieved.
   */
  async record(
    projectId: string,
    acceptanceId: string,
    dto: RecordAcceptanceDto,
    file: UploadedFile | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.editable(projectId, actor);
    const row = await this.requireScheduled(projectId, acceptanceId);
    const items = this.itemsOf(dto.items);
    const input = {
      result: (dto.result ?? '').trim(),
      decidedOn: dto.decided_on?.slice(0, 10) ?? null,
      note: (dto.note ?? '').trim(),
      hasCertificate: Boolean(file),
      items: items.map((item) => ({ text: item.text, dueOn: item.dueOn })),
      today: bangkokDay(now),
    };
    const problems = resultProblems(input);
    if (
      file &&
      !(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)
    ) {
      problems.push('แนบได้เฉพาะ PDF รูปภาพ Word หรือ Excel');
    }
    if (file && file.size > MAX_EVIDENCE_BYTES) {
      problems.push('ไฟล์ใหญ่เกิน 25 MB');
    }
    for (const owner of new Set(items.map((item) => item.ownerUserId))) {
      if (owner) await this.assertPerson(access.project.companyId, owner);
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'acceptance', reason })),
      );
    }
    let certificate: { key: string; name: string } | null = null;
    if (file) {
      const name = safeFileName(file.originalname);
      const key = `projects/${projectId}/acceptances/${acceptanceId}/${randomUUID()}/${name}`;
      await this.storage.put(key, file.buffer, {
        contentType: file.mimetype,
        size: file.size,
      });
      certificate = { key, name };
    }
    const label = `A-${row.seq}`;
    try {
      await this.transactions.execute(async (prisma) => {
        const claimed = await prisma.projectAcceptance.updateMany({
          where: { id: acceptanceId, status: 'scheduled' },
          data: {
            status: input.result,
            decidedOn: asDay(input.decidedOn!),
            outcomeNote: input.note || null,
            certificateKey: certificate?.key ?? null,
            certificateName: certificate?.name ?? null,
            certificateMime: file?.mimetype ?? null,
            certificateSize: file?.size ?? null,
            decidedBy: actor.userId,
            decidedAt: now,
            updatedBy: actor.userId,
          },
        });
        if (!claimed.count) {
          throw new AppError('CONFLICT', 'บันทึกผลรอบนี้ไปแล้ว');
        }
        if (items.length) {
          await prisma.projectAcceptanceItem.createMany({
            data: items.map((item, index) => ({
              companyId: access.project.companyId,
              acceptanceId,
              seq: index + 1,
              text: item.text,
              dueOn: asDay(item.dueOn!),
              ownerUserId: item.ownerUserId,
            })),
          });
        }
        await this.audit.record(
          {
            eventType: 'pm.acceptance.recorded',
            companyId: access.project.companyId,
            ...auditActor(actor),
            resourceType: 'project',
            resourceId: projectId,
            after: {
              acceptanceId,
              label,
              result: input.result,
              decidedOn: input.decidedOn,
              certificate: certificate?.name ?? null,
              items: items.length,
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      if (certificate) {
        await this.storage.remove(certificate.key).catch(() => undefined);
      }
      throw error;
    }

    if (
      file &&
      row.milestoneId &&
      (input.result === 'accepted' || input.result === 'conditional')
    ) {
      await this.achieveMilestone(
        projectId,
        row.milestoneId,
        label,
        input,
        file,
        actor,
        now,
      );
    }
    for (const owner of new Set(items.map((item) => item.ownerUserId))) {
      if (!owner || owner === actor.userId) continue;
      await this.notifications
        .acceptanceItemAssigned(
          owner,
          access.project.companyId,
          access.project,
          label,
        )
        .catch((error: Error) =>
          this.logger.warn(`acceptance notice not sent: ${error.message}`),
        );
    }
    return this.view(projectId, actor, now);
  }

  /** An open point done — its owner or the manager. */
  async closeItem(
    projectId: string,
    acceptanceId: string,
    itemId: string,
    dto: AcceptanceItemDoneDto,
    actor: Principal,
    now = new Date(),
  ) {
    const access = await this.projects.access(projectId, actor);
    const item = (await this.items.findFirst({
      where: { id: itemId, acceptanceId, acceptance: { projectId } },
      select: { id: true, status: true, ownerUserId: true, text: true },
    })) as {
      id: string;
      status: string;
      ownerUserId: string | null;
      text: string;
    } | null;
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบรายการค้าง');
    if (
      !this.running(access) ||
      (!access.canEdit && item.ownerUserId !== actor.userId)
    ) {
      throw new AppError(
        'FORBIDDEN',
        'ปิดรายการได้เฉพาะผู้รับผิดชอบ หรือผู้จัดการโครงการ',
      );
    }
    if (item.status !== 'open') {
      throw new AppError('CONFLICT', 'รายการนี้ปิดไปแล้ว');
    }
    const note = (dto.note ?? '').trim();
    if (!note) {
      throw new AppError('VALIDATION_FAILED', 'ต้องบอกว่าแก้อย่างไร');
    }
    await this.transactions.execute(async (prisma) => {
      await this.items.update(
        {
          where: { id: itemId },
          data: {
            status: 'done',
            doneNote: note,
            doneAt: now,
            doneBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.acceptance.item_done',
          companyId: access.project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: { acceptanceId, itemId, text: item.text, note },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor, now);
  }

  async certificate(
    projectId: string,
    acceptanceId: string,
    actor: Principal,
  ): Promise<{ stream: Readable; fileName: string; mimeType: string }> {
    await this.projects.access(projectId, actor);
    const row = (await this.rounds.findFirst({
      where: { id: acceptanceId, projectId },
      select: {
        certificateKey: true,
        certificateName: true,
        certificateMime: true,
      },
    })) as {
      certificateKey: string | null;
      certificateName: string | null;
      certificateMime: string | null;
    } | null;
    if (!row?.certificateKey) {
      throw new AppError('NOT_FOUND', 'ไม่พบใบตรวจรับ');
    }
    return {
      stream: await this.storage.get(row.certificateKey),
      fileName: row.certificateName ?? 'certificate',
      mimeType: row.certificateMime ?? 'application/octet-stream',
    };
  }

  // --- helpers -----------------------------------------------------------------------

  /**
   * The customer accepting meets every criterion; the milestone is then
   * achieved through CD-182, so its notices and audit go as they always do.
   */
  private async achieveMilestone(
    projectId: string,
    milestoneId: string,
    label: string,
    input: { decidedOn: string | null; note: string },
    file: UploadedFile,
    actor: Principal,
    now: Date,
  ) {
    try {
      const milestone = (await this.milestones.findFirst({
        where: { id: milestoneId, projectId, status: 'planned' },
        select: { criteria: true },
      })) as { criteria: unknown } | null;
      if (!milestone) return;
      await this.milestones.update({
        where: { id: milestoneId },
        data: {
          criteria: criteriaAccepted(
            readCriteria(milestone.criteria),
            actor.userId,
            now.toISOString(),
          ) as unknown as Prisma.InputJsonValue,
          updatedBy: actor.userId,
        },
      });
      await this.milestoneService.achieve(
        projectId,
        milestoneId,
        {
          achieved_on: input.decidedOn ?? undefined,
          evidence_note:
            `ลูกค้าตรวจรับแล้ว (${label})` +
            (input.note ? `: ${input.note}` : ''),
        },
        file,
        actor,
        now,
      );
    } catch (error) {
      this.logger.warn(
        `milestone not achieved from ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private itemsOf(raw: string | undefined) {
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'รายการค้างอ่านไม่ได้');
    }
    if (!Array.isArray(parsed)) {
      throw new AppError('VALIDATION_FAILED', 'รายการค้างอ่านไม่ได้');
    }
    return parsed.map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      const text = typeof row.text === 'string' ? row.text.trim() : '';
      return {
        text: text.slice(0, MAX_ACCEPTANCE_TEXT),
        dueOn:
          typeof row.due_on === 'string' &&
          /^\d{4}-\d{2}-\d{2}/.test(row.due_on)
            ? row.due_on.slice(0, 10)
            : null,
        ownerUserId:
          typeof row.owner_user_id === 'string' && row.owner_user_id
            ? row.owner_user_id
            : null,
      };
    });
  }

  private text(value: string | undefined) {
    const text = (value ?? '').trim();
    return text ? text.slice(0, MAX_ACCEPTANCE_TEXT) : null;
  }

  private async rows(projectId: string) {
    return (await this.rounds.findMany({
      where: { projectId },
      orderBy: { seq: 'desc' },
      include: { items: { orderBy: { seq: 'asc' } } },
    })) as unknown as RoundRow[];
  }

  private async requireScheduled(projectId: string, acceptanceId: string) {
    const row = (await this.rounds.findFirst({
      where: { id: acceptanceId, projectId },
    })) as RoundRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบนัดตรวจรับ');
    if (row.status !== 'scheduled') {
      throw new AppError('CONFLICT', 'บันทึกผลหรือยกเลิกรอบนี้ไปแล้ว');
    }
    return row;
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'นัดและบันทึกผลตรวจรับได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    return access;
  }

  private running(access: Access) {
    return (
      access.project.status === 'active' || access.project.status === 'on_hold'
    );
  }

  private async assertPerson(companyId: string, userId: string) {
    const found = await this.people.count({
      where: { id: userId, companies: { some: { companyId } } },
    });
    if (!found) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้รับผิดชอบรายการค้างไม่ได้อยู่ในบริษัทนี้',
        [{ field: 'items', reason: 'not_found' }],
      );
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
