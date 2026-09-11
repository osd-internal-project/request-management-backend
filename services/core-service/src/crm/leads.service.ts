import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  Principal,
  PrismaTransactionService,
  salesAccessSubject,
  toSkipTake,
  visibleSalesWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { LeadStatusService } from './lead-status.service';
import { LeadActivityRepository, LeadRepository } from './sales.repositories';
import { LeadWorkflowSyncService } from './lead-workflow-sync.service';
import { OpportunitiesService } from './opportunities.service';
import { CustomerRepository } from './customer.repository';
import {
  ConvertLeadDto,
  CreateLeadActivityDto,
  CreateLeadDto,
  DisqualifyLeadDto,
  ListLeadsQueryDto,
  UpdateLeadActivityDto,
  UpdateLeadDto,
  UpdateLeadStatusDto,
} from './dto/sales.dto';

/**
 * snake_case DTO field → Lead column, for every free-text column the form
 * edits. One table so create and update cannot disagree about which fields
 * exist (the customer form grew that bug once).
 */
const TEXT_COLUMNS = [
  ['contact_name', 'contactName'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['note', 'note'],
  ['source_code', 'sourceCode'],
  ['contact_position', 'contactPosition'],
  ['name_en', 'nameEn'],
  ['tax_id', 'taxId'],
  ['industry', 'industry'],
  ['company_size', 'companySize'],
  ['product_group', 'productGroup'],
  ['sub_product', 'subProduct'],
  ['address_line', 'addressLine'],
  ['district', 'district'],
  ['province', 'province'],
  ['postal_code', 'postalCode'],
] as const;

/**
 * The column values a DTO carries. `onlyGiven` (update) leaves out fields the
 * caller did not send, so a PATCH with one field touches one column; create
 * writes every column, blank = NULL.
 */
function leadColumns(
  dto: Partial<CreateLeadDto>,
  onlyGiven: boolean,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const [field, column] of TEXT_COLUMNS) {
    const value = dto[field];
    if (onlyGiven && value === undefined) continue;
    data[column] = value?.trim() || null;
  }

  if (!onlyGiven || dto.employee_count !== undefined) {
    data.employeeCount = dto.employee_count ?? null;
  }
  if (!onlyGiven || dto.project_revenue !== undefined) {
    data.projectRevenue = dto.project_revenue ?? null;
  }
  if (!onlyGiven || dto.country !== undefined) {
    data.country = dto.country?.trim().toUpperCase() || 'TH';
  }
  if (!onlyGiven || dto.customer_id !== undefined) {
    data.customerId = dto.customer_id || null;
  }

  return data;
}

/**
 * CRM Lead — รับ → คัดกรอง (new → ติดต่อไม่ได้/ติดต่อแล้ว → ผ่านคัดกรอง) →
 * แปลงเป็นโอกาสการขาย (ข้อมูลไหลต่อ) หรือคัดออกพร้อมเหตุผล. หน้ารายละเอียด
 * ลงกิจกรรม (โทร/อีเมล/นัดหมาย/งาน/บันทึก) บน Lead ได้ตลอดที่ยังเปิดอยู่.
 * Scope ผ่าน `visibleSalesWhere` (SCOPE-02) — คนขายเห็น Lead ของตนและของทีม,
 * `crm.sales.read.all` เห็นทั้งบริษัท. No hard delete.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly customers: CustomerRepository,
    private readonly opportunities: OpportunitiesService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly activities: LeadActivityRepository,
    private readonly members: CompanyMemberRepository,
    private readonly statuses: LeadStatusService,
    private readonly workflowSync: LeadWorkflowSyncService,
  ) {}

  async list(actor: Principal, query: ListLeadsQueryDto) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.LeadWhereInput = {};

    if (query.status) filters.status = query.status;
    if (query.view === 'mine') filters.ownerUserId = actor.userId;
    if (query.search) {
      const q = query.search.trim();
      filters.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { contactName: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
    }

    const where = {
      AND: [visibleSalesWhere(salesAccessSubject(actor)), filters],
    } as Prisma.LeadWhereInput;

    const [rows, total] = await Promise.all([
      this.leads.findMany({
        where,
        include: {
          customer: { select: { id: true, customerCode: true, nameTh: true } },
          convertedOpportunity: { select: { id: true, opportunityCode: true } },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.leads.count({ where }),
    ]);

    return paginated(rows as unknown[], query, total);
  }

  /**
   * หน้ารายละเอียด — Lead + ลูกค้าที่ผูก + โอกาสการขายที่แปลงไป + กิจกรรมทั้งหมด
   * (ใหม่สุดก่อน; หน้าจอแยกเองว่าอันไหนค้าง/เกินกำหนด/เสร็จแล้ว). User ids
   * are resolved to display names here so the page never has to look them up.
   * SCOPE-03: unseen = 404.
   */
  async findOne(id: string, actor: Principal) {
    const found = (await this.leads.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
      include: {
        customer: {
          select: {
            id: true,
            customerCode: true,
            nameTh: true,
            branchName: true,
          },
        },
        convertedOpportunity: {
          select: { id: true, opportunityCode: true, title: true, stage: true },
        },
        activities: { orderBy: { createdAt: 'desc' } },
      },
    })) as
      | ({
          ownerUserId: string;
          activities: {
            createdBy: string;
            completedBy: string | null;
          }[];
        } & Record<string, unknown>)
      | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');

    const nameOf = await this.displayNames([
      found.ownerUserId,
      ...found.activities.map((activity) => activity.createdBy),
      ...found.activities.map((activity) => activity.completedBy),
    ]);

    return {
      ...found,
      owner: {
        id: found.ownerUserId,
        displayName: nameOf.get(found.ownerUserId) ?? found.ownerUserId,
      },
      activities: found.activities.map((activity) => ({
        ...activity,
        createdByName: nameOf.get(activity.createdBy) ?? activity.createdBy,
        completedByName: activity.completedBy
          ? (nameOf.get(activity.completedBy) ?? activity.completedBy)
          : null,
      })),
    };
  }

  async create(dto: CreateLeadDto, actor: Principal) {
    if (dto.customer_id) await this.assertCustomer(dto.customer_id, actor);

    const row = (await this.leads.create({
      data: {
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        ...leadColumns(dto, false),
        // ขั้นตั้งต้นมาจากหน้าตั้งค่า ไม่ใช่ค่า default ของคอลัมน์ — ผู้ดูแลที่ย้ายธง
        // "สถานะตั้งต้น" ไปขั้นอื่นต้องเห็นผลกับ Lead ใบถัดไปทันที.
        status: await this.statuses.defaultCode(actor.activeCompanyId),
        ownerUserId: actor.userId,
        ownerOrgUnitId: actor.orgUnitId,
        createdBy: actor.userId,
      },
    })) as { id: string };

    await this.audit.record({
      eventType: 'crm.lead.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: row.id,
      after: { name: dto.name, sourceCode: dto.source_code },
    });

    /*
      Lead ใบใหม่ = process ใบใหม่ (PO 10 ก.ย. 2569). ยิงหลัง audit เขียนเสร็จ
      และไม่ `await` — OSD Workflow ล่มต้องไม่ทำให้เพิ่ม Lead ไม่ได้; งานที่ยิง
      ไม่ผ่านลงคิว `integration_sync_jobs` แล้ว sweeper ตามเก็บเอง.
    */
    this.workflowSync.kickLead(row.id);

    return row;
  }

  async update(id: string, dto: UpdateLeadDto, actor: Principal) {
    await this.requireOpen(id, actor);
    if (dto.customer_id) await this.assertCustomer(dto.customer_id, actor);

    return this.leads.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...leadColumns(dto, true),
        updatedBy: actor.userId,
      },
    });
  }

  /**
   * เลื่อนขั้นใน pipeline — ขั้นระหว่างทาง (`kind = open`) ไปมาได้อิสระ
   * (ติดต่อไม่ได้วันนี้ ติดต่อได้พรุ่งนี้). ปิดต้องผ่าน convert/disqualify เท่านั้น.
   *
   * **สิ่งที่ตรวจที่นี่คือความถูกต้องของข้อมูล ไม่ใช่กฎ workflow** — รหัสสถานะต้อง
   * มีจริงในบริษัทนี้, ต้องไม่ใช่ปลายทาง, ต้องยังเปิดใช้งาน. เงื่อนไขว่า *ควร*
   * เลื่อนได้ไหม (เช่นต้องมีกิจกรรมที่ทำเสร็จก่อน) อยู่บน workflow `lwf-0001` บน
   * service `workflowable` — PO 10 ก.ย. 2569: "Workflow owns Process, Core owns
   * Data". อย่าเติมด่านเชิง process กลับมาที่นี่ จะได้ process สองที่แล้ว drift.
   */
  async setStatus(id: string, dto: UpdateLeadStatusDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);
    const target = await this.statuses.require(
      actor.activeCompanyId,
      dto.status,
    );

    // ปลายทางมีข้อมูลกำกับของมันเอง (โอกาสการขายที่เกิด / เหตุผลที่คัดออก) — เลื่อน
    // เข้ามาตรง ๆ จะได้ Lead ที่ปิดแล้วโดยไม่มีอะไรอธิบายว่าปิดเพราะอะไร.
    if (target.kind !== 'open') {
      throw new AppError(
        'CONFLICT',
        `สถานะ "${target.nameTh}" เป็นสถานะปิด — ใช้ปุ่มแปลงเป็นโอกาสการขายหรือคัดออก`,
        [{ field: 'status', reason: target.kind }],
      );
    }

    if (!target.active) {
      throw new AppError(
        'CONFLICT',
        `สถานะ "${target.nameTh}" ถูกปิดใช้งานอยู่`,
        [{ field: 'status', reason: 'inactive' }],
      );
    }

    if (found.status !== target.code) {
      await this.leads.update({
        where: { id },
        data: { status: target.code, updatedBy: actor.userId },
      });

      await this.audit.record({
        eventType: 'crm.lead.status_changed',
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'lead',
        resourceId: id,
        before: { status: found.status },
        after: { status: target.code },
      });
    }

    return this.findOne(id, actor);
  }

  /**
   * ลงกิจกรรม — ไม่มีกำหนด = บันทึกสิ่งที่ทำไปแล้ว (ปิดทันที), มีกำหนด =
   * นัด/งานที่ต้องตามต่อ. Only on an open lead: once converted the work
   * continues on the opportunity, once disqualified there is nothing to log.
   */
  async addActivity(id: string, dto: CreateLeadActivityDto, actor: Principal) {
    await this.requireOpen(id, actor);

    const dueAt = dto.due_at ? new Date(dto.due_at) : null;
    const done = dueAt === null;

    const activity = (await this.activities.create({
      data: {
        companyId: actor.activeCompanyId,
        leadId: id,
        type: dto.type,
        subject: dto.subject.trim(),
        detail: dto.detail?.trim() || null,
        dueAt,
        completedAt: done ? new Date() : null,
        completedBy: done ? actor.userId : null,
        createdBy: actor.userId,
      },
    })) as { id: string };

    await this.audit.record({
      eventType: 'crm.lead.activity_logged',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      after: { activityId: activity.id, type: dto.type, subject: dto.subject },
    });

    return activity;
  }

  /** ติ๊กเสร็จ / เปิดกลับ / แก้หัวข้อ-กำหนด. The row must belong to this lead. */
  async updateActivity(
    id: string,
    activityId: string,
    dto: UpdateLeadActivityDto,
    actor: Principal,
  ) {
    await this.requireOpen(id, actor);

    const activity = (await this.activities.findFirst({
      where: { id: activityId, leadId: id },
    })) as { id: string; completedAt: Date | null } | null;
    if (!activity) throw new AppError('NOT_FOUND', 'ไม่พบกิจกรรมที่ระบุ');

    const data: Prisma.LeadActivityUncheckedUpdateInput = {};
    if (dto.subject !== undefined) data.subject = dto.subject.trim();
    if (dto.detail !== undefined) data.detail = dto.detail?.trim() || null;
    if (dto.due_at !== undefined) {
      data.dueAt = dto.due_at ? new Date(dto.due_at) : null;
    }
    if (dto.completed !== undefined) {
      data.completedAt = dto.completed ? new Date() : null;
      data.completedBy = dto.completed ? actor.userId : null;
    }

    return this.activities.update({ where: { id: activityId }, data });
  }

  /** คัดออก — สถานะ + เหตุผล, ไม่มีการลบ. */
  async disqualify(id: string, dto: DisqualifyLeadDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);

    await this.leads.update({
      where: { id },
      data: {
        status: await this.statuses.closingCode(actor.activeCompanyId, 'lost'),
        disqualifyReason: dto.reason.trim(),
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.lead.disqualified',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      before: { status: found.status },
      after: { status: 'disqualified', reason: dto.reason },
    });

    return this.leads.findFirst({ where: { id } });
  }

  /**
   * แปลงเป็นโอกาสการขาย — spec: "แปลงเป็นโอกาสการขายโดยข้อมูลไหลต่อทั้งหมด". The
   * opportunity is created through OpportunitiesService (same code path as a hand-made
   * opportunity), then the lead points at it and closes at the company's `won` status.
   *
   * ด่านเดียวที่เหลือที่นี่คือ "Lead ต้องยังเปิดอยู่" (`requireOpen`) ซึ่งเป็น
   * integrity ไม่ใช่ process. เงื่อนไขว่าแปลงได้จากขั้นไหน อยู่บน workflow
   * `lwf-0001` — ดู `setStatus`.
   */
  async convert(id: string, dto: ConvertLeadDto, actor: Principal) {
    const lead = await this.requireOpen(id, actor);

    // PO 10 ก.ย. 2569: ไม่ต้องมีลูกค้าในทะเบียนก่อน — ว่างไว้ = ผู้มุ่งหวัง ข้อมูล
    // ระบุตัวจาก Lead ไหลไปอยู่บนโอกาสการขาย และลูกค้าจะเกิดตอนเปิดใบสั่งขาย.
    const customerId = dto.customer_id || lead.customerId || undefined;
    if (customerId) await this.assertCustomer(customerId, actor);

    const opportunity = await this.opportunities.create(
      customerId
        ? {
            customer_id: customerId,
            title: dto.title?.trim() || lead.name,
            amount: dto.amount,
          }
        : {
            prospect_name: lead.name,
            prospect_tax_id: lead.taxId ?? undefined,
            prospect_contact_name: lead.contactName ?? undefined,
            prospect_phone: lead.phone ?? undefined,
            prospect_email: lead.email ?? undefined,
            title: dto.title?.trim() || lead.name,
            amount: dto.amount,
          },
      actor,
      { fromLeadId: id },
    );

    await this.leads.update({
      where: { id },
      data: {
        status: await this.statuses.closingCode(actor.activeCompanyId, 'won'),
        convertedOpportunityId: opportunity.id,
        customerId: customerId ?? null,
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.lead.converted',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      after: {
        opportunityId: opportunity.id,
        opportunityCode: opportunity.opportunityCode,
      },
    });

    return opportunity;
  }

  /** Visible AND still workable (anything but converted/disqualified). SCOPE-03: unseen = 404. */
  private async requireOpen(id: string, actor: Principal) {
    const found = (await this.leads.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      },
    })) as {
      id: string;
      name: string;
      status: string;
      customerId: string | null;
      taxId: string | null;
      contactName: string | null;
      phone: string | null;
      email: string | null;
    } | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');

    // "ปิดแล้ว" ถามจากชนิดของสถานะ ไม่ใช่จากรหัสสองตัวที่เขียนตายไว้ — ผู้ดูแล
    // เปลี่ยนชื่อหรือรหัสของปลายทางได้ และด่านนี้ต้องไม่หลุดตาม.
    const status = await this.statuses.require(
      actor.activeCompanyId,
      found.status,
    );

    if (status.kind !== 'open') {
      throw new AppError(
        'CONFLICT',
        'Lead นี้ถูกปิดแล้ว (แปลงเป็นโอกาสการขายหรือคัดออก) — แก้ไขไม่ได้',
      );
    }

    return found;
  }

  private async assertCustomer(customerId: string, actor: Principal) {
    const customer = await this.customers.findFirst({
      where: {
        id: customerId,
        companyId: actor.activeCompanyId,
        mergedIntoCustomerId: null,
      },
      select: { id: true },
    });

    if (!customer) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบลูกค้าที่ระบุ', [
        { field: 'customer_id', reason: customerId },
      ]);
    }
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    if (!unique.length) return new Map<string, string>();

    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];

    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
