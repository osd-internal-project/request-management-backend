import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestRepository } from '../requests/request.repository';
import {
  SolutionDemoEquipmentRepository,
  SolutionDemoFindingRepository,
  SolutionDemoRepository,
  SolutionVersionRepository,
} from './solution.repositories';
import { SolutionsService } from './solutions.service';
import {
  cleanCriteria,
  criteriaFromText,
  demoCloseGaps,
  scopeResolutionProblem,
} from './solution-rules';
import type {
  AddEquipmentDto,
  AddFindingDto,
  CloseDemoDto,
  CreateDemoDto,
  ResolveClarificationDto,
  ReturnEquipmentDto,
  UpdateDemoDto,
} from './dto/solution.dto';

/** A calendar day, read at UTC midnight so no zone shifts it. */
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface DemoRow {
  id: string;
  solutionId: string;
  status: 'planned' | 'done' | 'cancelled';
  title: string;
  criteria: unknown;
  outcome: string;
}

/**
 * CD-139 — Demo และ POC (user decisions 30 ก.ย. 2569):
 *
 * - Sales asks through the "ขอจัด Demo หรือ POC" request type (CRM settings:
 *   `demoRequestTypeCode`); the head of Pre-Sales accepting it is the
 *   approval. Pre-Sales then keeps the Demo/POC on the Solution, started from
 *   that request (its objective, date, site and success criteria) or blank;
 * - equipment is listed item by item with the day it went out and came
 *   back; a demo does not close — done or cancelled — with anything still
 *   out, and a demo that happened must record each criterion and a summary;
 * - a finding marked "Solution must change" stays open until Pre-Sales names
 *   the version that has it (a draft, or one locked after the finding);
 *   while open, the Solution cannot go for approval (`approvalBlocker`).
 *
 * Pre-Sales writes it (`presales.solution.manage`); sales read it.
 */
@Injectable()
export class DemosService {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly demos: SolutionDemoRepository,
    private readonly equipment: SolutionDemoEquipmentRepository,
    private readonly findings: SolutionDemoFindingRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly requests: RequestRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly configs: CrmConfigRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The deal's Demo/POC requests, for starting a demo from one. */
  async requestsFor(id: string, actor: Principal) {
    const solution = await this.solutions.requireReadable(id, actor);
    const [typeCode, deal] = await Promise.all([
      this.demoType(solution.companyId),
      this.opportunities.findFirst({
        where: { id: solution.opportunityId },
        select: { opportunityCode: true },
      }) as Promise<{ opportunityCode: string } | null>,
    ]);
    if (!typeCode || !deal) return [];
    const used = (await this.demos.findMany({
      where: { solutionId: id, requestId: { not: null }, deletedAt: null },
      select: { requestId: true },
    })) as { requestId: string }[];
    const rows = (await this.requests.findMany({
      where: {
        companyId: solution.companyId,
        typeCode,
        refType: 'opportunity',
        refId: deal.opportunityCode,
        status: { notIn: ['draft', 'cancelled', 'rejected'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, requestNo: true, status: true, formData: true },
    })) as {
      id: string;
      requestNo: string | null;
      status: string;
      formData: unknown;
    }[];
    const taken = new Set(used.map((row) => row.requestId));
    return rows.map((row) => ({
      id: row.id,
      requestNo: row.requestNo,
      status: row.status,
      objective: formText(row.formData, 'objective'),
      used: taken.has(row.id),
    }));
  }

  async create(id: string, dto: CreateDemoDto, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    let prefill: {
      kind?: 'demo' | 'poc';
      title?: string;
      scheduledOn?: Date;
      site?: string;
      criteria?: ReturnType<typeof criteriaFromText>;
    } = {};
    if (dto.request_id) {
      const request = await this.requireDemoRequest(dto.request_id, solution);
      const form = (request.formData ?? {}) as Record<string, unknown>;
      const date = formText(form, 'proposed_date');
      prefill = {
        kind: formText(form, 'kind').toUpperCase() === 'POC' ? 'poc' : 'demo',
        title: formText(form, 'objective').split('\n')[0]?.slice(0, 300),
        ...(ISO_DATE.test(date) ? { scheduledOn: day(date) } : {}),
        site: formText(form, 'site'),
        criteria: criteriaFromText(form.success_criteria),
      };
    }
    const title = dto.title?.trim() || prefill.title || 'Demo';
    await this.transactions.execute(async (prisma) => {
      const last = (await this.demos.findFirst(
        {
          where: { solutionId: id },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.demos.create(
        {
          data: {
            companyId: solution.companyId,
            solutionId: id,
            seq: (last?.seq ?? 0) + 1,
            requestId: dto.request_id ?? null,
            kind: dto.kind ?? prefill.kind ?? 'demo',
            title,
            scheduledOn: prefill.scheduledOn ?? null,
            site: prefill.site ?? '',
            criteria: (prefill.criteria ??
              []) as unknown as Prisma.InputJsonValue,
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.record(
        'presales.solution.demo_created',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            demoId: created.id,
            seq: created.seq,
            requestId: dto.request_id ?? null,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  async update(
    id: string,
    demoId: string,
    dto: UpdateDemoDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    await this.requirePlanned(id, demoId);
    if (dto.scheduled_on && !ISO_DATE.test(dto.scheduled_on)) {
      throw new AppError('VALIDATION_FAILED', 'วันที่จัดไม่ถูกต้อง', [
        { field: 'scheduled_on', reason: 'invalid' },
      ]);
    }
    const criteria = dto.criteria ? cleanCriteria(dto.criteria) : undefined;
    if (criteria?.problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        criteria.problems[0],
        criteria.problems.map((reason) => ({ field: 'criteria', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.demos.update(
        {
          where: { id: demoId },
          data: {
            ...(dto.kind ? { kind: dto.kind } : {}),
            ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
            ...(dto.scheduled_on !== undefined
              ? {
                  scheduledOn: dto.scheduled_on ? day(dto.scheduled_on) : null,
                }
              : {}),
            ...(dto.site !== undefined ? { site: dto.site.trim() } : {}),
            ...(dto.people !== undefined ? { people: dto.people.trim() } : {}),
            ...(dto.plan !== undefined ? { plan: dto.plan.trim() } : {}),
            ...(criteria
              ? {
                  criteria:
                    criteria.criteria as unknown as Prisma.InputJsonValue,
                }
              : {}),
            ...(dto.outcome !== undefined
              ? { outcome: dto.outcome.trim() }
              : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.demo_updated',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            demoId,
            fields: Object.keys(dto).filter(
              (key) => dto[key as keyof UpdateDemoDto] !== undefined,
            ),
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Done or cancelled — only with every item back, and done with its results. */
  async close(id: string, demoId: string, dto: CloseDemoDto, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const demo = await this.requirePlanned(id, demoId);
    const items = (await this.equipment.findMany({
      where: { demoId, deletedAt: null },
      select: { name: true, returnedOn: true },
    })) as { name: string; returnedOn: Date | null }[];
    const gaps = demoCloseGaps(dto.status, demo, items);
    if (gaps.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ปิดไม่ได้ — ${gaps.join(' · ')}`,
        gaps.map((reason) => ({ field: 'status', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const moved = await this.demos.updateMany(
        {
          where: { id: demoId, status: 'planned' },
          data: {
            status: dto.status,
            closedAt: new Date(),
            closedBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (moved.count !== 1) {
        throw new AppError('CONFLICT', 'Demo/POC นี้ปิดไปแล้ว');
      }
      await this.record(
        'presales.solution.demo_closed',
        solution,
        id,
        actor,
        prisma,
        {
          after: { demoId, status: dto.status },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Soft delete — only a demo still being planned, with nothing out. */
  async remove(id: string, demoId: string, actor: Principal) {
    const solution = await this.solutions.requireManageable(id, actor);
    const demo = await this.requirePlanned(id, demoId);
    const out = await this.equipment.count({
      where: { demoId, deletedAt: null, returnedOn: null },
    });
    if (out) {
      throw new AppError(
        'CONFLICT',
        `ยังไม่คืนอุปกรณ์ ${out} รายการ — คืนก่อนจึงเอาออกได้`,
      );
    }
    await this.transactions.execute(async (prisma) => {
      await this.demos.update(
        {
          where: { id: demoId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.demo_removed',
        solution,
        id,
        actor,
        prisma,
        {
          before: { demoId, title: demo.title },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  // --- equipment ---------------------------------------------------------------

  async checkOut(
    id: string,
    demoId: string,
    dto: AddEquipmentDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    await this.requirePlanned(id, demoId);
    await this.transactions.execute(async (prisma) => {
      const created = (await this.equipment.create(
        {
          data: {
            demoId,
            name: dto.name.trim(),
            serial: dto.serial?.trim() ?? '',
            quantity: dto.quantity ?? 1,
            takenBy: dto.taken_by?.trim() ?? '',
            outOn: day(dto.out_on),
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string };
      await this.record(
        'presales.solution.demo_equipment_out',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            demoId,
            itemId: created.id,
            name: dto.name.trim(),
            quantity: dto.quantity ?? 1,
            outOn: dto.out_on,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  async checkIn(
    id: string,
    demoId: string,
    itemId: string,
    dto: ReturnEquipmentDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    await this.requireDemo(id, demoId);
    const item = (await this.equipment.findFirst({
      where: { id: itemId, demoId, deletedAt: null },
      select: { name: true, outOn: true, returnedOn: true },
    })) as { name: string; outOn: Date; returnedOn: Date | null } | null;
    if (!item) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์ที่ระบุ');
    if (item.returnedOn) {
      throw new AppError('CONFLICT', 'อุปกรณ์นี้คืนแล้ว');
    }
    const returnedOn = day(dto.returned_on);
    if (returnedOn.getTime() < item.outOn.getTime()) {
      throw new AppError('VALIDATION_FAILED', 'วันที่คืนก่อนวันที่เบิก', [
        { field: 'returned_on', reason: 'before_out' },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await this.equipment.update(
        {
          where: { id: itemId },
          data: { returnedOn, updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.demo_equipment_returned',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            demoId,
            itemId,
            name: item.name,
            returnedOn: dto.returned_on,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  // --- findings ------------------------------------------------------------------

  async addFinding(
    id: string,
    demoId: string,
    dto: AddFindingDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    await this.requireDemo(id, demoId);
    await this.transactions.execute(async (prisma) => {
      const last = (await this.findings.findFirst(
        { where: { demoId }, orderBy: { seq: 'desc' }, select: { seq: true } },
        { prisma },
      )) as { seq: number } | null;
      const created = (await this.findings.create(
        {
          data: {
            demoId,
            seq: (last?.seq ?? 0) + 1,
            text: dto.text.trim(),
            requiresChange: dto.requires_change ?? false,
            recordedOnVersionNo: solution.currentVersionNo,
            createdBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string };
      await this.record(
        'presales.solution.demo_finding_added',
        solution,
        id,
        actor,
        prisma,
        {
          after: {
            demoId,
            findingId: created.id,
            requiresChange: dto.requires_change ?? false,
          },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  /** Close a finding with the version that has the change. */
  async resolveFinding(
    id: string,
    demoId: string,
    findingId: string,
    dto: ResolveClarificationDto,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    await this.requireDemo(id, demoId);
    const finding = (await this.findings.findFirst({
      where: { id: findingId, demoId, deletedAt: null },
    })) as {
      requiresChange: boolean;
      resolvedVersionNo: number | null;
      recordedOnVersionNo: number;
      createdAt: Date;
    } | null;
    if (!finding) throw new AppError('NOT_FOUND', 'ไม่พบข้อค้นพบที่ระบุ');
    if (!finding.requiresChange) {
      throw new AppError('CONFLICT', 'ข้อค้นพบนี้ไม่ต้องปรับ Solution');
    }
    if (finding.resolvedVersionNo !== null) {
      throw new AppError(
        'CONFLICT',
        `ปรับแล้วในเวอร์ชัน ${finding.resolvedVersionNo}`,
      );
    }
    const version = (await this.versions.findFirst({
      where: { solutionId: id, versionNo: dto.version_no },
      select: { versionNo: true, status: true, lockedAt: true },
    })) as { versionNo: number; status: string; lockedAt: Date | null } | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    const problem = scopeResolutionProblem(
      {
        answerRecordedAt: finding.createdAt,
        answeredOnVersionNo: finding.recordedOnVersionNo,
      },
      version,
    )?.replace('ได้คำตอบ', 'บันทึกข้อค้นพบ');
    if (problem) {
      throw new AppError('VALIDATION_FAILED', problem, [
        { field: 'version_no', reason: problem },
      ]);
    }
    await this.transactions.execute(async (prisma) => {
      await this.findings.update(
        {
          where: { id: findingId },
          data: {
            resolvedVersionNo: version.versionNo,
            resolvedAt: new Date(),
            resolvedBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.demo_finding_resolved',
        solution,
        id,
        actor,
        prisma,
        {
          after: { demoId, findingId, versionNo: version.versionNo },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  async removeFinding(
    id: string,
    demoId: string,
    findingId: string,
    actor: Principal,
  ) {
    const solution = await this.solutions.requireManageable(id, actor);
    await this.requireDemo(id, demoId);
    const found = await this.findings.findFirst({
      where: { id: findingId, demoId, deletedAt: null },
      select: { id: true },
    });
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบข้อค้นพบที่ระบุ');
    await this.transactions.execute(async (prisma) => {
      await this.findings.update(
        {
          where: { id: findingId },
          data: { deletedAt: new Date(), updatedBy: actor.userId },
        },
        { prisma },
      );
      await this.record(
        'presales.solution.demo_finding_removed',
        solution,
        id,
        actor,
        prisma,
        {
          before: { demoId, findingId },
        },
      );
    });
    return this.solutions.findOne(id, actor);
  }

  // --- helpers -------------------------------------------------------------------

  private async requireDemo(solutionId: string, demoId: string) {
    const demo = (await this.demos.findFirst({
      where: { id: demoId, solutionId, deletedAt: null },
    })) as DemoRow | null;
    if (!demo) throw new AppError('NOT_FOUND', 'ไม่พบ Demo/POC ที่ระบุ');
    return demo;
  }

  private async requirePlanned(solutionId: string, demoId: string) {
    const demo = await this.requireDemo(solutionId, demoId);
    if (demo.status !== 'planned') {
      throw new AppError('CONFLICT', 'Demo/POC นี้ปิดแล้ว — แก้ไม่ได้');
    }
    return demo;
  }

  /** The request must be this deal's Demo/POC request, and not used already. */
  private async requireDemoRequest(
    requestId: string,
    solution: { id: string; companyId: string; opportunityId: string },
  ) {
    const [typeCode, deal, request, used] = await Promise.all([
      this.demoType(solution.companyId),
      this.opportunities.findFirst({
        where: { id: solution.opportunityId },
        select: { opportunityCode: true },
      }) as Promise<{ opportunityCode: string } | null>,
      this.requests.findFirst({
        where: { id: requestId, companyId: solution.companyId },
        select: {
          typeCode: true,
          refType: true,
          refId: true,
          status: true,
          formData: true,
        },
      }) as Promise<{
        typeCode: string;
        refType: string | null;
        refId: string | null;
        status: string;
        formData: unknown;
      } | null>,
      this.demos.findFirst({
        where: { requestId, deletedAt: null },
        select: { id: true },
      }),
    ]);
    if (
      !request ||
      !typeCode ||
      request.typeCode !== typeCode ||
      request.refType !== 'opportunity' ||
      request.refId !== deal?.opportunityCode
    ) {
      throw new AppError(
        'NOT_FOUND',
        'ไม่พบคำขอ "ขอจัด Demo หรือ POC" ของดีลนี้',
      );
    }
    if (used) {
      throw new AppError('CONFLICT', 'คำขอนี้มี Demo/POC แล้ว');
    }
    return request;
  }

  private async demoType(companyId: string): Promise<string | null> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { demoRequestTypeCode: true },
    })) as { demoRequestTypeCode: string | null } | null;
    return config?.demoRequestTypeCode ?? null;
  }

  private record(
    eventType: string,
    solution: { companyId: string },
    solutionId: string,
    actor: Principal,
    prisma: Prisma.TransactionClient,
    change: { before?: Prisma.InputJsonValue; after?: Prisma.InputJsonValue },
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: solution.companyId,
        ...auditActor(actor),
        resourceType: 'solution',
        resourceId: solutionId,
        ...change,
      },
      { prisma },
    );
  }
}

function formText(form: unknown, key: string): string {
  const value =
    form && typeof form === 'object'
      ? (form as Record<string, unknown>)[key]
      : undefined;
  return typeof value === 'string' ? value.trim() : '';
}
