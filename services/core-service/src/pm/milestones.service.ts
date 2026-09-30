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
import { ContractInstallmentRepository } from '../crm/contract-installments.service';
import {
  delayPenalty,
  penaltyCeiling,
  penaltyExposure,
  type PenaltyRate,
} from '../crm/contract-terms';
import { bangkokDay } from '../crm/kyc-rules';
import { NotificationsService } from '../notifications/notifications.service';
import { readDeliverables } from '../presales/solution-rules';
import { safeFileName } from '../requests/attachments.service';
import { SaveMilestoneDto } from './dto/project.dto';
import {
  achieveProblems,
  MAX_MILESTONES,
  mergeCriteria,
  milestoneProblems,
  milestonesFromSchedule,
  readCriteria,
  type Criterion,
} from './milestone-rules';
import {
  ProjectMilestoneRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

export const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
export const EVIDENCE_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

interface EvidenceFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface MilestoneRow {
  id: string;
  companyId: string;
  projectId: string;
  seq: number;
  title: string;
  description: string | null;
  criteria: unknown;
  dueOn: Date | null;
  installmentId: string | null;
  penaltyApplies: boolean;
  status: string;
  achievedOn: Date | null;
  achievedAt: Date | null;
  achievedBy: string | null;
  evidenceNote: string | null;
  evidenceKey: string | null;
  evidenceName: string | null;
  evidenceMime: string | null;
  evidenceSize: number | null;
  installment: {
    id: string;
    seq: number;
    kind: string;
    label: string;
    amount: Prisma.Decimal;
  } | null;
}

const MILESTONE_SELECT = {
  id: true,
  companyId: true,
  projectId: true,
  seq: true,
  title: true,
  description: true,
  criteria: true,
  dueOn: true,
  installmentId: true,
  penaltyApplies: true,
  status: true,
  achievedOn: true,
  achievedAt: true,
  achievedBy: true,
  evidenceNote: true,
  evidenceKey: true,
  evidenceName: true,
  evidenceMime: true,
  evidenceSize: true,
  installment: {
    select: { id: true, seq: true, kind: true, label: true, amount: true },
  },
} as const;

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDay = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;

/**
 * CD-182 Milestone — a project's milestones: what must be true for each to
 * count, when it is due, and which contract installment it unlocks. The
 * first set is drawn from the billing schedule; the manager ticks each
 * criterion as it is met and, with every one ticked and the evidence
 * written (a file optional), marks the milestone achieved — which tells the
 * contract's owner that its installment may be billed.
 *
 * Who: anyone who sees the project reads them; `pm.project.manage` or the
 * project's manager changes them.
 */
@Injectable()
export class MilestonesService {
  private readonly logger = new Logger(MilestonesService.name);

  constructor(
    private readonly projects: ProjectsService,
    private readonly milestones: ProjectMilestoneRepository,
    private readonly projectRows: ProjectRepository,
    private readonly installments: ContractInstallmentRepository,
    private readonly people: CompanyMemberRepository,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async list(projectId: string, actor: Principal, now = new Date()) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    const [rows, schedule] = await Promise.all([
      this.milestones.findMany({
        where: { projectId },
        orderBy: [{ seq: 'asc' }],
        select: MILESTONE_SELECT,
      }) as unknown as Promise<MilestoneRow[]>,
      this.installments.findMany({
        where: { contractId: project.contractId },
        orderBy: { seq: 'asc' },
        select: {
          id: true,
          seq: true,
          kind: true,
          label: true,
          amount: true,
          dueOn: true,
          milestone: true,
          projectMilestone: { select: { id: true, status: true } },
        },
      }) as unknown as Promise<
        {
          id: string;
          seq: number;
          kind: string;
          label: string;
          amount: Prisma.Decimal;
          dueOn: Date | null;
          milestone: string | null;
          projectMilestone: { id: string; status: string } | null;
        }[]
      >,
    ]);
    const names = await this.displayNames([
      ...rows.map((row) => row.achievedBy),
      ...rows.flatMap((row) =>
        readCriteria(row.criteria).map((item) => item.metBy),
      ),
    ]);
    const today = bangkokDay(now);
    const penalty = await this.penaltyOf(projectId);
    const milestones = rows.map((row) =>
      this.present(row, names, today, penalty),
    );
    return {
      canEdit,
      // CD-154 — the contract's delay penalty, and what it comes to so far
      penalty: {
        rate: penalty.rate,
        ceiling: penalty.ceiling,
        exposure: penaltyExposure(
          milestones
            .filter((row) => row.penalty)
            .map((row) => row.penalty!.amount),
          penalty.ceiling,
        ),
      },
      milestones,
      installments: schedule.map((row) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        label: row.label,
        amount: Number(row.amount),
        dueOn: day(row.dueOn),
        milestone: row.milestone,
        milestoneId: row.projectMilestone?.id ?? null,
        milestoneStatus: row.projectMilestone?.status ?? null,
      })),
    };
  }

  async create(projectId: string, dto: SaveMilestoneDto, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const count = await this.milestones.count({ where: { projectId } });
    if (count >= MAX_MILESTONES) {
      throw new AppError(
        'VALIDATION_FAILED',
        `หมุดหมายมีได้ไม่เกิน ${MAX_MILESTONES} รายการ`,
      );
    }
    const criteria = mergeCriteria(dto.criteria ?? [], []);
    const installmentId = await this.checkInstallment(
      project.contractId,
      dto.installment_id ?? null,
      null,
    );
    this.assertValid(dto.title ?? '', criteria, installmentId);
    const row = await this.transactions.execute(async (prisma) => {
      const last = (await this.milestones.findFirst(
        {
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.milestones.create(
        {
          data: {
            companyId: project.companyId,
            projectId,
            seq: (last?.seq ?? 0) + 1,
            title: dto.title!.trim(),
            description: dto.description?.trim() || null,
            criteria: criteria as unknown as Prisma.InputJsonValue,
            dueOn: asDay(dto.due_on),
            installmentId,
            penaltyApplies: dto.penalty_applies ?? false,
            createdBy: actor.userId,
          },
          select: { id: true },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'pm.milestone.created',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_milestone',
          resourceId: created.id,
          after: {
            projectId,
            title: dto.title,
            installmentId,
            criteria: criteria.map((item) => item.text),
          },
        },
        { prisma },
      );
      return created;
    });
    return this.one(projectId, row.id, actor);
  }

  async update(
    projectId: string,
    milestoneId: string,
    dto: SaveMilestoneDto,
    actor: Principal,
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requirePlanned(projectId, milestoneId);
    const criteria =
      dto.criteria === undefined
        ? readCriteria(current.criteria)
        : mergeCriteria(dto.criteria, readCriteria(current.criteria));
    const installmentId =
      dto.installment_id === undefined
        ? current.installmentId
        : await this.checkInstallment(
            project.contractId,
            dto.installment_id,
            milestoneId,
          );
    const title = dto.title ?? current.title;
    this.assertValid(title, criteria, installmentId);
    await this.transactions.execute(async (prisma) => {
      await this.milestones.update(
        {
          where: { id: milestoneId },
          data: {
            title: title.trim(),
            ...(dto.description !== undefined
              ? { description: dto.description.trim() || null }
              : {}),
            ...(dto.due_on !== undefined ? { dueOn: asDay(dto.due_on) } : {}),
            criteria: criteria as unknown as Prisma.InputJsonValue,
            installmentId,
            ...(dto.penalty_applies !== undefined
              ? { penaltyApplies: dto.penalty_applies }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.milestone.updated',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_milestone',
          resourceId: milestoneId,
          before: {
            title: current.title,
            installmentId: current.installmentId,
            dueOn: day(current.dueOn),
            criteria: readCriteria(current.criteria).map((item) => item.text),
          },
          after: dto as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
    });
    return this.one(projectId, milestoneId, actor);
  }

  /** Withdrawn, not deleted — and its installment is free again. */
  async cancel(projectId: string, milestoneId: string, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requirePlanned(projectId, milestoneId);
    await this.transactions.execute(async (prisma) => {
      await this.milestones.update(
        {
          where: { id: milestoneId },
          data: {
            status: 'cancelled',
            installmentId: null,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.milestone.cancelled',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_milestone',
          resourceId: milestoneId,
          before: {
            title: current.title,
            installmentId: current.installmentId,
          },
        },
        { prisma },
      );
    });
    return this.one(projectId, milestoneId, actor);
  }

  /** The first set, from the installments not yet tied to a milestone. */
  async fromSchedule(projectId: string, actor: Principal) {
    const { project } = await this.editable(projectId, actor);
    const [schedule, linked, detail] = await Promise.all([
      this.installments.findMany({
        where: { contractId: project.contractId },
        orderBy: { seq: 'asc' },
        select: {
          id: true,
          seq: true,
          kind: true,
          label: true,
          dueOn: true,
          milestone: true,
        },
      }) as Promise<
        {
          id: string;
          seq: number;
          kind: string;
          label: string;
          dueOn: Date | null;
          milestone: string | null;
        }[]
      >,
      this.milestones.findMany({
        where: { projectId, installmentId: { not: null } },
        select: { installmentId: true },
      }) as Promise<{ installmentId: string }[]>,
      this.projects.detail(projectId, actor),
    ]);
    const baseline = detail.baseline as {
      scope?: { deliverables?: unknown };
    } | null;
    const drafts = milestonesFromSchedule(
      schedule,
      readDeliverables(baseline?.scope?.deliverables),
      new Set(linked.map((row) => row.installmentId)),
    );
    // CD-154 — a payment milestone carries the contract's delay penalty
    const { rate } = await this.penaltyOf(projectId);
    if (!drafts.length) {
      throw new AppError(
        'CONFLICT',
        'ไม่มีงวดวางบิลที่รอหมุดหมาย — ทุกงวดผูกแล้ว หรือสัญญายังไม่ได้วางงวด',
      );
    }
    await this.transactions.execute(async (prisma) => {
      const last = (await this.milestones.findFirst(
        {
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      let seq = last?.seq ?? 0;
      for (const draft of drafts) {
        await this.milestones.create(
          {
            data: {
              companyId: project.companyId,
              projectId,
              seq: ++seq,
              title: draft.title,
              criteria: draft.criteria as unknown as Prisma.InputJsonValue,
              dueOn: draft.dueOn,
              installmentId: draft.installmentId,
              penaltyApplies: rate !== null,
              createdBy: actor.userId,
            },
          },
          { prisma },
        );
      }
      await this.audit.record(
        {
          eventType: 'pm.milestone.from_schedule',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: projectId,
          after: {
            milestones: drafts.map((draft) => ({
              title: draft.title,
              installmentId: draft.installmentId,
            })),
          },
        },
        { prisma },
      );
    });
    return this.list(projectId, actor);
  }

  /** The manager confirms (or un-confirms) one criterion. */
  async tick(
    projectId: string,
    milestoneId: string,
    index: number,
    met: boolean,
    actor: Principal,
    now = new Date(),
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requirePlanned(projectId, milestoneId);
    const criteria = readCriteria(current.criteria);
    if (!criteria[index]) {
      throw new AppError('NOT_FOUND', 'ไม่พบเกณฑ์ข้อนี้');
    }
    const next: Criterion[] = criteria.map((item, at) =>
      at === index
        ? {
            ...item,
            met,
            metAt: met ? now.toISOString() : null,
            metBy: met ? actor.userId : null,
          }
        : item,
    );
    await this.transactions.execute(async (prisma) => {
      await this.milestones.update(
        {
          where: { id: milestoneId },
          data: {
            criteria: next as unknown as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'pm.milestone.criterion',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project_milestone',
          resourceId: milestoneId,
          after: { index, text: criteria[index].text, met },
        },
        { prisma },
      );
    });
    return this.one(projectId, milestoneId, actor);
  }

  /**
   * Achieved: every criterion ticked, the evidence written, a file if there
   * is one. A milestone tied to an installment tells the contract's owner
   * that the installment may now be billed.
   */
  async achieve(
    projectId: string,
    milestoneId: string,
    body: { achieved_on?: string; evidence_note?: string },
    file: EvidenceFile | undefined,
    actor: Principal,
    now = new Date(),
  ) {
    const { project } = await this.editable(projectId, actor);
    const current = await this.requirePlanned(projectId, milestoneId);
    const achievedOn = (body.achieved_on ?? '').slice(0, 10);
    const evidenceNote = (body.evidence_note ?? '').trim();
    const problems = achieveProblems({
      status: current.status,
      criteria: readCriteria(current.criteria),
      evidenceNote,
      achievedOn,
      today: bangkokDay(now),
    });
    if (file) {
      if (!(EVIDENCE_TYPES as readonly string[]).includes(file.mimetype)) {
        problems.push('แนบได้เฉพาะ PDF รูปภาพ Word หรือ Excel');
      }
      if (file.size > MAX_EVIDENCE_BYTES) problems.push('ไฟล์ใหญ่เกิน 25 MB');
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'milestone', reason })),
      );
    }
    let evidence: {
      key: string;
      name: string;
      mime: string;
      size: number;
    } | null = null;
    if (file) {
      const name = safeFileName(file.originalname);
      const key = `projects/${projectId}/milestones/${milestoneId}/${randomUUID()}/${name}`;
      await this.storage.put(key, file.buffer, {
        contentType: file.mimetype,
        size: file.size,
      });
      evidence = { key, name, mime: file.mimetype, size: file.size };
    }
    try {
      await this.transactions.execute(async (prisma) => {
        // only a planned one — a second click finds it achieved
        const updated = await prisma.projectMilestone.updateMany({
          where: { id: milestoneId, status: 'planned' },
          data: {
            status: 'achieved',
            achievedOn: asDay(achievedOn),
            achievedAt: now,
            achievedBy: actor.userId,
            evidenceNote,
            evidenceKey: evidence?.key ?? null,
            evidenceName: evidence?.name ?? null,
            evidenceMime: evidence?.mime ?? null,
            evidenceSize: evidence?.size ?? null,
            updatedBy: actor.userId,
          },
        });
        if (!updated.count) {
          throw new AppError('CONFLICT', 'หมุดหมายนี้บรรลุหรือยกเลิกไปแล้ว');
        }
        await this.audit.record(
          {
            eventType: 'pm.milestone.achieved',
            companyId: project.companyId,
            ...auditActor(actor),
            resourceType: 'project_milestone',
            resourceId: milestoneId,
            after: {
              projectId,
              achievedOn,
              evidenceNote,
              evidenceFile: evidence?.name ?? null,
              installmentId: current.installmentId,
            },
          },
          { prisma },
        );
      });
    } catch (error) {
      if (evidence) {
        await this.storage.remove(evidence.key).catch(() => undefined);
      }
      throw error;
    }

    if (current.installment && project.contract.ownerUserId !== actor.userId) {
      await this.notifications
        .milestoneAchieved(project.contract.ownerUserId, project.companyId, {
          project,
          milestone: current.title,
          installment: {
            seq: current.installment.seq,
            label: current.installment.label,
            amount: Number(current.installment.amount),
          },
        })
        .catch((error: Error) =>
          this.logger.warn(`milestone notice not sent: ${error.message}`),
        );
    }
    return this.one(projectId, milestoneId, actor);
  }

  async evidence(projectId: string, milestoneId: string, actor: Principal) {
    await this.projects.access(projectId, actor);
    const row = (await this.milestones.findFirst({
      where: { id: milestoneId, projectId },
      select: { evidenceKey: true, evidenceName: true, evidenceMime: true },
    })) as {
      evidenceKey: string | null;
      evidenceName: string | null;
      evidenceMime: string | null;
    } | null;
    if (!row?.evidenceKey) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์หลักฐาน');
    const stream: Readable = await this.storage.get(row.evidenceKey);
    return {
      stream,
      fileName: row.evidenceName ?? 'evidence',
      mimeType: row.evidenceMime ?? 'application/octet-stream',
    };
  }

  // --- helpers -------------------------------------------------------------------

  private async one(projectId: string, milestoneId: string, actor: Principal) {
    const view = await this.list(projectId, actor);
    return {
      ...view,
      milestone: view.milestones.find((row) => row.id === milestoneId) ?? null,
    };
  }

  private present(
    row: MilestoneRow,
    names: Map<string, string>,
    today: string,
    terms: { rate: PenaltyRate | null; contractValue: number | null },
  ) {
    const criteria = readCriteria(row.criteria);
    const due = day(row.dueOn);
    return {
      penaltyApplies: row.penaltyApplies,
      penalty:
        row.penaltyApplies && terms.rate && row.status !== 'cancelled'
          ? delayPenalty(
              terms.rate,
              {
                dueOn: due,
                status: row.status,
                achievedOn: day(row.achievedOn),
              },
              {
                contractValue: terms.contractValue,
                installmentAmount: row.installment
                  ? Number(row.installment.amount)
                  : null,
              },
              today,
            )
          : null,
      id: row.id,
      seq: row.seq,
      title: row.title,
      description: row.description,
      dueOn: due,
      overdue: row.status === 'planned' && due !== null && due < today,
      status: row.status,
      criteria: criteria.map((item) => ({
        ...item,
        metByName: item.metBy ? (names.get(item.metBy) ?? null) : null,
      })),
      criteriaMet: criteria.filter((item) => item.met).length,
      installment: row.installment
        ? {
            id: row.installment.id,
            seq: row.installment.seq,
            kind: row.installment.kind,
            label: row.installment.label,
            amount: Number(row.installment.amount),
          }
        : null,
      achievedOn: day(row.achievedOn),
      achievedAt: row.achievedAt,
      achievedByName: row.achievedBy
        ? (names.get(row.achievedBy) ?? null)
        : null,
      evidenceNote: row.evidenceNote,
      evidenceFile: row.evidenceName
        ? { name: row.evidenceName, size: row.evidenceSize }
        : null,
    };
  }

  /** CD-154 — the delay penalty of the project's contract, if it has one. */
  private async penaltyOf(projectId: string) {
    const row = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: {
        contract: {
          select: {
            value: true,
            terms: {
              select: {
                penaltyRatePct: true,
                penaltyPeriod: true,
                penaltyBasis: true,
                penaltyCapPct: true,
                penaltyCapAmount: true,
              },
            },
          },
        },
      },
    })) as {
      contract: {
        value: Prisma.Decimal | null;
        terms: {
          penaltyRatePct: Prisma.Decimal | null;
          penaltyPeriod: string | null;
          penaltyBasis: string | null;
          penaltyCapPct: Prisma.Decimal | null;
          penaltyCapAmount: Prisma.Decimal | null;
        } | null;
      };
    } | null;
    const n = (value: Prisma.Decimal | null | undefined) =>
      value === null || value === undefined ? null : Number(value);
    const contractValue = n(row?.contract.value);
    const terms = row?.contract.terms ?? null;
    const rate =
      terms && terms.penaltyRatePct !== null
        ? {
            ratePct: n(terms.penaltyRatePct),
            period: terms.penaltyPeriod,
            basis: terms.penaltyBasis,
          }
        : null;
    return {
      rate,
      contractValue,
      ceiling: terms
        ? penaltyCeiling(
            {
              penaltyCapPct: n(terms.penaltyCapPct),
              penaltyCapAmount: n(terms.penaltyCapAmount),
            },
            contractValue,
          )
        : null,
    };
  }

  private async editable(projectId: string, actor: Principal) {
    const access = await this.projects.access(projectId, actor);
    if (!access.canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'แก้หมุดหมายได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ ขณะโครงการยังดำเนินอยู่',
      );
    }
    return access;
  }

  private async requirePlanned(projectId: string, milestoneId: string) {
    const row = (await this.milestones.findFirst({
      where: { id: milestoneId, projectId },
      select: MILESTONE_SELECT,
    })) as MilestoneRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบหมุดหมายที่ระบุ');
    if (row.status !== 'planned') {
      throw new AppError('CONFLICT', 'หมุดหมายนี้บรรลุหรือยกเลิกไปแล้ว');
    }
    return row;
  }

  /** An installment of this project's contract, not tied to another milestone. */
  private async checkInstallment(
    contractId: string,
    installmentId: string | null,
    milestoneId: string | null,
  ): Promise<string | null> {
    if (!installmentId) return null;
    const found = (await this.installments.findFirst({
      where: { id: installmentId, contractId },
      select: { id: true, projectMilestone: { select: { id: true } } },
    })) as { id: string; projectMilestone: { id: string } | null } | null;
    if (!found) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ไม่พบงวดชำระนี้ในสัญญาของโครงการ',
        [{ field: 'installment_id', reason: 'not_found' }],
      );
    }
    if (found.projectMilestone && found.projectMilestone.id !== milestoneId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'งวดชำระนี้ผูกกับหมุดหมายอื่นแล้ว',
        [{ field: 'installment_id', reason: 'taken' }],
      );
    }
    return found.id;
  }

  private assertValid(
    title: string,
    criteria: Criterion[],
    installmentId: string | null,
  ) {
    const problems = milestoneProblems({ title, criteria, installmentId });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'milestone', reason })),
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
