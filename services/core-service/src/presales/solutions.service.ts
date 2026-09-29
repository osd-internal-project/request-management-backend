import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  visibleSalesWhere,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CustomerTimelineService } from '../crm/customer-timeline.service';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { safeFileName } from '../requests/attachments.service';
import { RequestRepository } from '../requests/request.repository';
import {
  SolutionFileRepository,
  SolutionRepository,
  SolutionRequirementRepository,
  SolutionVersionRepository,
} from './solution.repositories';
import {
  briefOf,
  cleanAssumptions,
  lockGaps,
  readAssumptions,
  readDeliverables,
  readLines,
  cleanDeliverables,
  cleanLines,
  sowGaps,
  approvalBlocker,
  type SolutionApprovalStatus,
  requirementCounts,
  requirementGaps,
  type RequirementState,
} from './solution-rules';
import type {
  NewSolutionVersionDto,
  UpdateSolutionDraftDto,
} from './dto/solution.dto';

/** A design document or diagram; drawings exported to PDF are the big ones. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_VERSION = 30;

/** Request statuses in which Pre-Sales holds the brief — accepted, working. */
const WORKING = ['in_progress', 'on_hold'];

interface UploadedFile {
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Buffer;
}

interface SolutionRow {
  id: string;
  companyId: string;
  opportunityId: string;
  requestId: string;
  title: string;
  currentVersionNo: number;
}

interface VersionRow {
  id: string;
  solutionId: string;
  versionNo: number;
  status: 'draft' | 'locked' | 'superseded';
  approvalStatus: SolutionApprovalStatus;
  approvalRequestId: string | null;
  summary: string;
  design: string;
  assumptions: unknown;
  inScope: unknown;
  outOfScope: unknown;
  deliverables: unknown;
  changeNote: string | null;
  lockedAt: Date | null;
  lockedBy: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DealRow {
  id: string;
  companyId: string;
  opportunityCode: string;
  title: string;
  customerId: string | null;
  prospectName: string | null;
  customer: { nameTh: string } | null;
}

const DEAL_SELECT = {
  id: true,
  companyId: true,
  opportunityCode: true,
  title: true,
  customerId: true,
  prospectName: true,
  customer: { select: { nameTh: true } },
} as const;

const FILE_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  uploadedBy: true,
  uploadedAt: true,
} as const;

/**
 * CD-132 — ออกแบบ Solution (user decisions 29 ก.ย. 2569):
 *
 * - a Solution starts only from a "ขอ Solution" request (CD-130) Pre-Sales has
 *   accepted — one request, one Solution; there is no Solution without a
 *   brief, and the brief stays visible beside the design;
 * - each version holds a summary, the design, the design assumptions as a
 *   list (category + text — they travel on into the contract), design
 *   files and — CD-134 — the scope of work: in scope, out of scope, and
 *   deliverables each with their acceptance criteria. A draft is edited freely; locking it fixes it for good, and a
 *   change means a new version from the locked one, with a note of why. The
 *   older locked version becomes `superseded` when the new one locks;
 * - `presales.solution.manage` does the work; `presales.solution.read` sees
 *   every Solution; a salesperson sees their own deal's Solution through the
 *   deal (`crm.sales.read`), read-only.
 */
@Injectable()
export class SolutionsService {
  private readonly logger = new Logger(SolutionsService.name);

  constructor(
    private readonly solutions: SolutionRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly files: SolutionFileRepository,
    private readonly requirements: SolutionRequirementRepository,
    private readonly requests: RequestRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly configs: CrmConfigRepository,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // --- starting ----------------------------------------------------------------

  /** For the request page: may this request start a Solution, and has it? */
  async forRequest(requestId: string, actor: Principal) {
    const request = await this.findRequest(requestId, actor);
    const existing = request
      ? ((await this.solutions.findFirst({
          where: { requestId },
          select: { id: true, currentVersionNo: true },
        })) as { id: string; currentVersionNo: number } | null)
      : null;
    const solutionType = request
      ? await this.solutionType(request.companyId)
      : null;
    const isSolutionRequest =
      !!request && !!solutionType && request.typeCode === solutionType;
    return {
      is_solution_request: isSolutionRequest,
      can_start:
        isSolutionRequest &&
        !existing &&
        request.refType === 'opportunity' &&
        WORKING.includes(request.status),
      solution: existing,
    };
  }

  /** Start the Solution from the accepted request. Idempotent per request. */
  async start(requestId: string, actor: Principal) {
    const request = await this.findRequest(requestId, actor);
    if (!request) throw new AppError('NOT_FOUND', 'ไม่พบคำขอที่ระบุ');
    const solutionType = await this.solutionType(request.companyId);
    if (!solutionType || request.typeCode !== solutionType) {
      throw new AppError(
        'CONFLICT',
        'คำขอนี้ไม่ใช่ประเภท "ขอ Solution" ตามที่ตั้งไว้ในตั้งค่า CRM',
      );
    }
    const existing = (await this.solutions.findFirst({
      where: { requestId },
      select: { id: true },
    })) as { id: string } | null;
    if (existing) return this.findOne(existing.id, actor);

    if (!WORKING.includes(request.status)) {
      throw new AppError(
        'CONFLICT',
        'เริ่มออกแบบได้เมื่อรับเรื่องคำขอแล้ว (กำลังดำเนินการ)',
      );
    }
    if (request.refType !== 'opportunity' || !request.refId) {
      throw new AppError('CONFLICT', 'คำขอนี้ไม่ได้อ้างโอกาสการขาย');
    }
    const deal = (await this.opportunities.findFirst({
      where: {
        companyId: request.companyId,
        OR: [{ opportunityCode: request.refId }, { id: request.refId }],
      },
      select: DEAL_SELECT,
    })) as DealRow | null;
    if (!deal) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่คำขออ้าง');

    const created = await this.transactions.execute(async (prisma) => {
      const solution = (await this.solutions.create(
        {
          data: {
            companyId: request.companyId,
            opportunityId: deal.id,
            requestId,
            title: deal.title,
            createdBy: actor.userId,
            versions: {
              create: {
                versionNo: 1,
                createdBy: actor.userId,
              },
            },
          },
        },
        { prisma },
      )) as { id: string };
      await this.audit.record(
        {
          eventType: 'presales.solution.started',
          companyId: request.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: solution.id,
          after: {
            requestId,
            requestNo: request.requestNo,
            opportunityId: deal.id,
          },
        },
        { prisma },
      );
      await this.publish(
        deal,
        `${deal.opportunityCode}: Pre-Sales เริ่มออกแบบ Solution`,
        'opportunity.solution_started',
        actor,
        prisma,
      );
      return solution;
    });
    return this.findOne(created.id, actor);
  }

  // --- reading ------------------------------------------------------------------

  /** A deal's Solutions, for its page — same `crm.sales.read` the page needs. */
  async forDeal(opportunityId: string, actor: Principal) {
    const deal = (await this.opportunities.findFirst({
      where: {
        id: opportunityId,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      select: { id: true },
    })) as { id: string } | null;
    // SCOPE-03: out of reach answers 404.
    if (!deal) throw new AppError('NOT_FOUND', 'ไม่พบโอกาสการขายที่ระบุ');
    const rows = (await this.solutions.findMany({
      where: { opportunityId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        requestId: true,
        currentVersionNo: true,
        updatedAt: true,
        versions: {
          orderBy: { versionNo: 'desc' },
          take: 1,
          select: { versionNo: true, status: true, approvalStatus: true },
        },
        requirements: {
          where: { deletedAt: null },
          select: { assessment: true, customerAnswer: true },
        },
      },
    })) as unknown as {
      id: string;
      title: string;
      requestId: string;
      currentVersionNo: number;
      updatedAt: Date;
      versions: {
        versionNo: number;
        status: string;
        approvalStatus: string;
      }[];
      requirements: RequirementState[];
    }[];
    return rows.map(({ versions, requirements, ...row }) => ({
      ...row,
      latest: versions[0] ?? null,
      // CD-131 — what the salesperson has to chase with the customer.
      waiting_customer: requirementCounts(requirements).waiting_customer,
    }));
  }

  /** The Solution with its version list and the current version in full. */
  async findOne(id: string, actor: Principal, versionNo?: number) {
    const solution = await this.requireReadable(id, actor);
    const [all, deal, request] = await Promise.all([
      this.versions.findMany({
        where: { solutionId: id },
        orderBy: { versionNo: 'desc' },
        select: {
          versionNo: true,
          status: true,
          changeNote: true,
          lockedAt: true,
          createdAt: true,
          approvalStatus: true,
        },
      }),
      this.opportunities.findFirst({
        where: { id: solution.opportunityId },
        select: DEAL_SELECT,
      }) as Promise<DealRow | null>,
      this.requests.findFirst({
        where: { id: solution.requestId },
        select: { id: true, requestNo: true, status: true, formData: true },
      }) as Promise<{
        id: string;
        requestNo: string | null;
        status: string;
        formData: unknown;
      } | null>,
    ]);
    const version = await this.requireVersion(
      id,
      versionNo ?? solution.currentVersionNo,
    );
    const [files, requirements, approvalType, approvalRequest] =
      await Promise.all([
        this.files.findMany({
          where: { versionId: version.id, deletedAt: null },
          orderBy: { uploadedAt: 'asc' },
          select: FILE_SELECT,
        }),
        this.activeRequirements(id),
        this.configs.findFirst({
          where: { companyId: solution.companyId },
          select: { solutionApprovalTypeCode: true },
        }) as Promise<{ solutionApprovalTypeCode: string | null } | null>,
        version.approvalRequestId
          ? (this.requests.findFirst({
              where: { id: version.approvalRequestId },
              select: { id: true, requestNo: true, status: true },
            }) as Promise<{
              id: string;
              requestNo: string | null;
              status: string;
            } | null>)
          : Promise.resolve(null),
      ]);
    return {
      ...solution,
      can_manage: this.canManage(actor),
      // CD-131 — a salesperson on the deal records the customer's answers.
      can_answer: this.canManage(actor) || this.canAnswerAsSales(actor),
      requirements,
      requirement_counts: requirementCounts(requirements),
      deal: deal
        ? {
            id: deal.id,
            opportunityCode: deal.opportunityCode,
            title: deal.title,
            partyName: deal.customer?.nameTh ?? deal.prospectName,
          }
        : null,
      request: request
        ? {
            id: request.id,
            requestNo: request.requestNo,
            status: request.status,
          }
        : null,
      brief: briefOf(request?.formData),
      versions: all,
      version: {
        ...version,
        assumptions: readAssumptions(version.assumptions),
        inScope: readLines(version.inScope),
        outOfScope: readLines(version.outOfScope),
        deliverables: readDeliverables(version.deliverables),
        files,
      },
      // CD-143 — whether this version may be sent for approval, and why not.
      approval: {
        configured: Boolean(approvalType?.solutionApprovalTypeCode),
        blocker: approvalBlocker(
          version,
          version.versionNo === solution.currentVersionNo,
        ),
        request: approvalRequest,
      },
    };
  }

  // --- editing ------------------------------------------------------------------

  async updateDraft(
    id: string,
    versionNo: number,
    dto: UpdateSolutionDraftDto,
    actor: Principal,
  ) {
    const solution = await this.requireManageable(id, actor);
    const version = await this.requireDraft(id, versionNo);
    let assumptions: Prisma.InputJsonValue | undefined;
    if (dto.assumptions !== undefined) {
      const cleaned = cleanAssumptions(dto.assumptions);
      if (cleaned.problems.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          cleaned.problems[0],
          cleaned.problems.map((reason) => ({ field: 'assumptions', reason })),
        );
      }
      assumptions = cleaned.assumptions as unknown as Prisma.InputJsonValue;
    }
    // CD-134 — the SOW, every problem named at once.
    const problems: { field: string; reason: string }[] = [];
    const inScope =
      dto.in_scope !== undefined
        ? cleanLines(dto.in_scope, 'งานในขอบเขต')
        : undefined;
    const outOfScope =
      dto.out_of_scope !== undefined
        ? cleanLines(dto.out_of_scope, 'งานนอกขอบเขต')
        : undefined;
    const deliverables =
      dto.deliverables !== undefined
        ? cleanDeliverables(dto.deliverables)
        : undefined;
    for (const [field, result] of [
      ['in_scope', inScope],
      ['out_of_scope', outOfScope],
      ['deliverables', deliverables],
    ] as const) {
      for (const reason of result?.problems ?? []) {
        problems.push({ field, reason });
      }
    }
    if (problems.length) {
      throw new AppError('VALIDATION_FAILED', problems[0].reason, problems);
    }

    await this.transactions.execute(async (prisma) => {
      if (dto.title?.trim()) {
        await this.solutions.update(
          {
            where: { id },
            data: { title: dto.title.trim(), updatedBy: actor.userId },
          },
          { prisma },
        );
      }
      // Guarded: a version locked meanwhile is not written.
      const moved = await this.versions.updateMany(
        {
          where: { id: version.id, status: 'draft' },
          data: {
            ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
            ...(dto.design !== undefined ? { design: dto.design } : {}),
            ...(assumptions !== undefined ? { assumptions } : {}),
            ...(inScope ? { inScope: inScope.lines } : {}),
            ...(outOfScope ? { outOfScope: outOfScope.lines } : {}),
            ...(deliverables
              ? {
                  deliverables:
                    deliverables.deliverables as unknown as Prisma.InputJsonValue,
                }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError('CONFLICT', 'เวอร์ชันนี้ยืนยันแล้ว — แก้ไม่ได้');
      }
      await this.audit.record(
        {
          eventType: 'presales.solution.draft_saved',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: id,
          after: {
            versionNo,
            fields: Object.keys(dto).filter(
              (key) => dto[key as keyof UpdateSolutionDraftDto] !== undefined,
            ),
          },
        },
        { prisma },
      );
    });
    return this.findOne(id, actor, versionNo);
  }

  /** Fix the draft for good. The version it replaces is superseded. */
  async lock(id: string, versionNo: number, actor: Principal) {
    const solution = await this.requireManageable(id, actor);
    const version = await this.requireDraft(id, versionNo);
    const gaps = [
      ...lockGaps(version),
      ...sowGaps(version),
      ...requirementGaps(await this.activeRequirements(id)),
    ];
    if (gaps.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ยืนยันเวอร์ชันไม่ได้ — ${gaps.join(' · ')}`,
        gaps.map((reason) => ({ field: 'version', reason })),
      );
    }
    const now = new Date();
    await this.transactions.execute(async (prisma) => {
      const moved = await this.versions.updateMany(
        {
          where: { id: version.id, status: 'draft' },
          data: {
            status: 'locked',
            lockedAt: now,
            lockedBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError('CONFLICT', 'เวอร์ชันนี้ยืนยันไปแล้ว');
      }
      await this.versions.updateMany(
        {
          where: {
            solutionId: id,
            status: 'locked',
            versionNo: { lt: versionNo },
          },
          data: { status: 'superseded', updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'presales.solution.version_locked',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: id,
          after: {
            versionNo,
            assumptions: readAssumptions(version.assumptions).length,
          },
        },
        { prisma },
      );
      const deal = (await this.opportunities.findFirst(
        { where: { id: solution.opportunityId }, select: DEAL_SELECT },
        { prisma },
      )) as DealRow | null;
      if (deal) {
        await this.publish(
          deal,
          `${deal.opportunityCode}: ยืนยัน Solution เวอร์ชัน ${versionNo}`,
          'opportunity.solution_locked',
          actor,
          prisma,
        );
      }
    });
    return this.findOne(id, actor, versionNo);
  }

  /** A new draft from the locked version, carrying its content and files. */
  async newVersion(id: string, dto: NewSolutionVersionDto, actor: Principal) {
    const solution = await this.requireManageable(id, actor);
    const latest = await this.requireVersion(id, solution.currentVersionNo);
    if (latest.status === 'draft') {
      throw new AppError(
        'CONFLICT',
        `ยังมีเวอร์ชัน ${latest.versionNo} เป็นร่างอยู่ — แก้ร่างนั้นหรือยืนยันก่อน`,
      );
    }
    const versionNo = latest.versionNo + 1;
    await this.transactions.execute(async (prisma) => {
      // Guarded on the version number: two people at once — one wins.
      const moved = await this.solutions.updateMany(
        {
          where: { id, currentVersionNo: latest.versionNo },
          data: { currentVersionNo: versionNo, updatedBy: actor.userId },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError('CONFLICT', 'มีคนเปิดเวอร์ชันใหม่ไปแล้ว');
      }
      const created = (await this.versions.create(
        {
          data: {
            solutionId: id,
            versionNo,
            summary: latest.summary,
            design: latest.design,
            assumptions: readAssumptions(
              latest.assumptions,
            ) as unknown as Prisma.InputJsonValue,
            inScope: readLines(latest.inScope),
            outOfScope: readLines(latest.outOfScope),
            deliverables: readDeliverables(
              latest.deliverables,
            ) as unknown as Prisma.InputJsonValue,
            changeNote: dto.change_note.trim(),
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string };
      const carried = (await this.files.findMany(
        { where: { versionId: latest.id, deletedAt: null } },
        { prisma },
      )) as {
        companyId: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
        storageKey: string;
        uploadedBy: string;
        uploadedAt: Date;
      }[];
      if (carried.length) {
        await this.files.createMany(
          {
            data: carried.map((file) => ({
              companyId: file.companyId,
              versionId: created.id,
              fileName: file.fileName,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              storageKey: file.storageKey,
              uploadedBy: file.uploadedBy,
              uploadedAt: file.uploadedAt,
            })),
          },
          { prisma },
        );
      }
      await this.audit.record(
        {
          eventType: 'presales.solution.version_opened',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: id,
          after: {
            versionNo,
            fromVersionNo: latest.versionNo,
            changeNote: dto.change_note.trim(),
          },
        },
        { prisma },
      );
    });
    return this.findOne(id, actor, versionNo);
  }

  // --- files --------------------------------------------------------------------

  async uploadFile(
    id: string,
    versionNo: number,
    file: UploadedFile | undefined,
    actor: Principal,
  ) {
    if (!file) {
      throw new AppError('VALIDATION_FAILED', 'กรุณาเลือกไฟล์', [
        { field: 'file', reason: 'required' },
      ]);
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new AppError('VALIDATION_FAILED', 'ไฟล์ใหญ่เกิน 25 MB', [
        { field: 'file', reason: 'too_large' },
      ]);
    }
    const solution = await this.requireManageable(id, actor);
    const version = await this.requireDraft(id, versionNo);
    const count = await this.files.count({
      where: { versionId: version.id, deletedAt: null },
    });
    if (count >= MAX_FILES_PER_VERSION) {
      throw new AppError(
        'VALIDATION_FAILED',
        `แนบได้ไม่เกิน ${MAX_FILES_PER_VERSION} ไฟล์ต่อเวอร์ชัน`,
        [{ field: 'file', reason: 'too_many' }],
      );
    }
    const fileId = randomUUID();
    const fileName = safeFileName(file.originalname);
    const storageKey = `solutions/${id}/${fileId}/${fileName}`;
    await this.storage.put(storageKey, file.buffer, {
      contentType: file.mimetype || 'application/octet-stream',
      size: file.size,
    });
    try {
      await this.transactions.execute(async (prisma) => {
        await this.files.create(
          {
            data: {
              id: fileId,
              companyId: solution.companyId,
              versionId: version.id,
              fileName,
              mimeType: file.mimetype || 'application/octet-stream',
              sizeBytes: file.size,
              storageKey,
              uploadedBy: actor.userId,
            },
          },
          { prisma },
        );
        await this.audit.record(
          {
            eventType: 'presales.solution.file_added',
            companyId: solution.companyId,
            ...auditActor(actor),
            resourceType: 'solution',
            resourceId: id,
            after: { versionNo, fileId, fileName, sizeBytes: file.size },
          },
          { prisma },
        );
      });
    } catch (error) {
      await this.storage
        .remove(storageKey)
        .catch((cleanup: unknown) =>
          this.logger.warn(
            `orphaned solution file ${storageKey}: ${String(cleanup)}`,
          ),
        );
      throw error;
    }
    return this.findOne(id, actor, versionNo);
  }

  async downloadFile(
    id: string,
    fileId: string,
    actor: Principal,
  ): Promise<{ fileName: string; mimeType: string; stream: Readable }> {
    await this.requireReadable(id, actor);
    const file = (await this.files.findFirst({
      where: { id: fileId, deletedAt: null, version: { solutionId: id } },
      select: { fileName: true, mimeType: true, storageKey: true },
    })) as { fileName: string; mimeType: string; storageKey: string } | null;
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      stream: await this.storage.get(file.storageKey),
    };
  }

  /**
   * Off a draft only. A soft delete that keeps the object: earlier versions
   * carrying the same file still point at it.
   */
  async removeFile(
    id: string,
    versionNo: number,
    fileId: string,
    actor: Principal,
  ) {
    const solution = await this.requireManageable(id, actor);
    const version = await this.requireDraft(id, versionNo);
    const file = (await this.files.findFirst({
      where: { id: fileId, versionId: version.id, deletedAt: null },
      select: { id: true, fileName: true },
    })) as { id: string; fileName: string } | null;
    if (!file) throw new AppError('NOT_FOUND', 'ไม่พบไฟล์ที่ระบุ');
    await this.transactions.execute(async (prisma) => {
      await this.files.update(
        { where: { id: fileId }, data: { deletedAt: new Date() } },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'presales.solution.file_removed',
          companyId: solution.companyId,
          ...auditActor(actor),
          resourceType: 'solution',
          resourceId: id,
          before: { versionNo, fileId, fileName: file.fileName },
        },
        { prisma },
      );
    });
    return this.findOne(id, actor, versionNo);
  }

  // --- helpers ------------------------------------------------------------------

  /** CD-131 — the analysis, oldest first, without the removed items. */
  activeRequirements(solutionId: string) {
    return this.requirements.findMany({
      where: { solutionId, deletedAt: null },
      orderBy: { seq: 'asc' },
    }) as Promise<
      (RequirementState & {
        id: string;
        seq: number;
        kind: string;
        text: string;
        note: string;
        answeredAt: Date | null;
        answeredBy: string | null;
      })[]
    >;
  }

  canAnswerAsSales(actor: Principal): boolean {
    return actor.permissions.includes('crm.sales.manage');
  }

  canManage(actor: Principal): boolean {
    return actor.permissions.includes('presales.solution.manage');
  }

  /**
   * Pre-Sales (read or manage) sees every Solution in the company; anyone
   * else only a Solution on a deal they can see.
   */
  async requireReadable(id: string, actor: Principal): Promise<SolutionRow> {
    const solution = (await this.solutions.findFirst({
      where: { id, companyId: actor.activeCompanyId },
      select: {
        id: true,
        companyId: true,
        opportunityId: true,
        requestId: true,
        title: true,
        currentVersionNo: true,
      },
    })) as SolutionRow | null;
    if (solution) {
      if (
        actor.permissions.includes('presales.solution.read') ||
        this.canManage(actor)
      ) {
        return solution;
      }
      if (actor.permissions.includes('crm.sales.read')) {
        const visible = await this.opportunities.findFirst({
          where: {
            id: solution.opportunityId,
            AND: [visibleSalesWhere(salesAccessSubject(actor))],
          },
          select: { id: true },
        });
        if (visible) return solution;
      }
    }
    // SCOPE-03: out of reach answers 404.
    throw new AppError('NOT_FOUND', 'ไม่พบ Solution ที่ระบุ');
  }

  async requireManageable(id: string, actor: Principal) {
    if (!this.canManage(actor)) {
      throw new AppError('FORBIDDEN', 'ต้องมีสิทธิ์ออกแบบ Solution');
    }
    return this.requireReadable(id, actor);
  }

  private async requireVersion(
    solutionId: string,
    versionNo: number,
  ): Promise<VersionRow> {
    const version = (await this.versions.findFirst({
      where: { solutionId, versionNo },
    })) as VersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    return version;
  }

  private async requireDraft(solutionId: string, versionNo: number) {
    const version = await this.requireVersion(solutionId, versionNo);
    if (version.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        `เวอร์ชัน ${versionNo} ยืนยันแล้ว — แก้ต้องเปิดเวอร์ชันใหม่`,
      );
    }
    return version;
  }

  private async findRequest(requestId: string, actor: Principal) {
    return (await this.requests.findFirst({
      where: { id: requestId, companyId: actor.activeCompanyId },
      select: {
        id: true,
        requestNo: true,
        companyId: true,
        typeCode: true,
        status: true,
        refType: true,
        refId: true,
      },
    })) as {
      id: string;
      requestNo: string | null;
      companyId: string;
      typeCode: string;
      status: string;
      refType: string | null;
      refId: string | null;
    } | null;
  }

  private async solutionType(companyId: string): Promise<string | null> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { solutionRequestTypeCode: true },
    })) as { solutionRequestTypeCode: string | null } | null;
    return config?.solutionRequestTypeCode ?? null;
  }

  private async publish(
    deal: DealRow,
    summary: string,
    eventType: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
  ) {
    // A prospect has no customer timeline yet.
    if (!deal.customerId) return;
    await this.timeline.publish(
      {
        companyId: deal.companyId,
        customerId: deal.customerId,
        refType: 'opportunity',
        refId: deal.id,
        eventType,
        summary,
        actorId: auditActor(actor).actorId,
        actorName: actor.displayName,
      },
      { prisma },
    );
  }
}
