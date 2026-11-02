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
  visibleLeadsWhere,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { DomainEventsService } from '../events/domain-events.service';
import type { LeadEventPayload } from '../events/event-catalog';
import { LeadStatusService } from './lead-status.service';
import { LeadActivityRepository, LeadRepository } from './sales.repositories';
import { CampaignsService } from './campaigns.service';
import { LeadWorkflowSyncService } from './lead-workflow-sync.service';
import { OpportunitiesService } from './opportunities.service';
import { CustomerRepository } from './customer.repository';
import { CrmConfigRepository } from './segment.repositories';
import { TargetAccountRepository } from './target-accounts.repository';
import {
  CONTACT_TYPES,
  discoveryMissing,
  type DiscoveryFields,
} from './prospecting-rules';
import {
  AssignLeadDto,
  ConvertLeadDto,
  CreateLeadActivityDto,
  CreateLeadDto,
  DisqualifyLeadDto,
  ListLeadsQueryDto,
  UpdateLeadActivityDto,
  UpdateLeadDto,
  UpdateLeadIntakeDataDto,
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
  // CD-85 Discovery
  ['discovery_need', 'discoveryNeed'],
  ['discovery_budget_note', 'discoveryBudgetNote'],
  ['discovery_decision_maker', 'discoveryDecisionMaker'],
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
  if (!onlyGiven || dto.discovery_budget !== undefined) {
    data.discoveryBudget = dto.discovery_budget ?? null;
  }
  if (!onlyGiven || dto.discovery_timeframe !== undefined) {
    data.discoveryTimeframe = dto.discovery_timeframe
      ? new Date(`${dto.discovery_timeframe.slice(0, 10)}T00:00:00Z`)
      : null;
  }

  return data;
}

const MAX_INTAKE_BYTES = 16 * 1024;

/**
 * An intake object split into the keys to write and the keys to drop (`null`).
 * The sender's own data, so only its size is ours to police.
 */
function intakePatch(data: Record<string, unknown>) {
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_INTAKE_BYTES) {
    throw new AppError('VALIDATION_FAILED', 'intake data ใหญ่เกิน 16 KB', [
      { field: 'intake_data', reason: 'too_large' },
    ]);
  }
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === null) remove.push(key);
    else set[key] = value;
  }
  return { set, remove };
}

export interface LeadEventRow {
  id: string;
  name: string;
  status: string;
  sourceCode?: string | null;
}

/** The webhook payload of a lead event — identity and state only, no contact data. */
function leadEvent(
  companyId: string,
  row: LeadEventRow,
  extra: Partial<LeadEventPayload> = {},
): LeadEventPayload {
  return {
    company_id: companyId,
    lead_id: row.id,
    name: row.name,
    status: row.status,
    source_code: row.sourceCode ?? null,
    ...extra,
  };
}

/** CD-85 — completed contacts only: a planned call is not an attempt yet. */
const CONTACT_WHERE = {
  type: { in: [...CONTACT_TYPES] },
  completedAt: { not: null },
} satisfies Prisma.LeadActivityWhereInput;

/** CD-85 — what the Getter screens show beside a lead. */
function prospectingOf(
  lead: DiscoveryFields & {
    _count?: { activities: number };
    activities?: { completedAt: Date | null; outcome: string | null }[];
  },
) {
  const last = lead.activities?.[0] ?? null;
  return {
    discovery_missing: discoveryMissing(lead),
    contact_attempts: lead._count?.activities ?? 0,
    last_contact_at: last?.completedAt ?? null,
    last_outcome: last?.outcome ?? null,
  };
}

/**
 * CRM Lead — รับ → คัดกรอง (new → ติดต่อไม่ได้/ติดต่อแล้ว → ผ่านคัดกรอง) →
 * แปลงเป็นโอกาสการขาย (ข้อมูลไหลต่อ) หรือคัดออกพร้อมเหตุผล. หน้ารายละเอียด
 * ลงกิจกรรม (โทร/อีเมล/นัดหมาย/งาน/บันทึก) บน Lead ได้ตลอดที่ยังเปิดอยู่.
 * Scope ผ่าน `visibleLeadsWhere` (SCOPE-02) — คนขายเห็น Lead ของตนและของทีม,
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
    private readonly campaigns: CampaignsService,
    private readonly configs: CrmConfigRepository,
    private readonly targets: TargetAccountRepository,
    private readonly events: DomainEventsService,
  ) {}

  async list(actor: Principal, query: ListLeadsQueryDto) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.LeadWhereInput = {};

    if (query.status) filters.status = query.status;
    if (query.campaign_id) filters.campaignId = query.campaign_id;
    if (query.new_customer === 'true') filters.customerId = null;
    if (query.view === 'mine') filters.ownerUserId = actor.userId;
    // กองกลาง — ใบที่ยังไม่มีใครรับ. ตัวกรอง ไม่ใช่ประตู: `visibleLeadsWhere`
    // ด้านล่างยังผูกทุกแถวไว้กับขอบเขตของคนเรียกเหมือนเดิม.
    if (query.view === 'unassigned') filters.ownerUserId = null;
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
      AND: [visibleLeadsWhere(salesAccessSubject(actor)), filters],
    } as Prisma.LeadWhereInput;

    const [rows, total] = await Promise.all([
      this.leads.findMany({
        where,
        include: {
          customer: { select: { id: true, customerCode: true, nameTh: true } },
          convertedOpportunity: { select: { id: true, opportunityCode: true } },
          campaign: { select: { id: true, code: true, name: true } },
          // CD-85 — attempts and the latest contact, per row
          _count: { select: { activities: { where: CONTACT_WHERE } } },
          activities: {
            where: CONTACT_WHERE,
            orderBy: { completedAt: 'desc' },
            take: 1,
            select: { completedAt: true, outcome: true },
          },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.leads.count({ where }),
    ]);

    return paginated(
      (rows as unknown as (DiscoveryFields & Record<string, unknown>)[]).map(
        ({ activities: _latest, _count, ...row }) => ({
          ...row,
          ...prospectingOf({
            ...row,
            _count: _count as { activities: number },
            activities: _latest as {
              completedAt: Date | null;
              outcome: string | null;
            }[],
          }),
        }),
      ),
      query,
      total,
    );
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
        AND: [visibleLeadsWhere(salesAccessSubject(actor))],
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
        campaign: { select: { id: true, code: true, name: true } },
        activities: { orderBy: { createdAt: 'desc' } },
        targetAccount: {
          select: { id: true, name: true, priority: true, status: true },
        },
      },
    })) as
      | ({
          ownerUserId: string | null;
          activities: {
            createdBy: string;
            completedBy: string | null;
          }[];
        } & Record<string, unknown>)
      | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');

    // CD-85 — the same summary the list shows, from the activities in hand
    const contacts = (
      found.activities as unknown as {
        type: string;
        completedAt: Date | null;
        outcome: string | null;
      }[]
    )
      .filter(
        (activity) =>
          activity.completedAt &&
          (CONTACT_TYPES as readonly string[]).includes(activity.type),
      )
      .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime());
    const config = (await this.configs.findFirst({
      where: { companyId: actor.activeCompanyId },
      select: { discoveryRequired: true },
    })) as { discoveryRequired: boolean } | null;

    const nameOf = await this.displayNames([
      found.ownerUserId,
      ...found.activities.map((activity) => activity.createdBy),
      ...found.activities.map((activity) => activity.completedBy),
    ]);

    return {
      ...found,
      /*
        `null` = กองกลาง ยังไม่มีใครรับ. ส่ง null ทั้งก้อนแทนที่จะแต่งชื่อปลอมอย่าง
        "ยังไม่ระบุ" ลงไป — ข้อความให้คนอ่านเป็นงานของหน้าจอ และค่าที่ไม่มีจริง
        ต้องหน้าตาต่างจาก id ที่หาชื่อไม่เจอ (ซึ่งคืน id กลับไปตามเดิม).
      */
      owner: found.ownerUserId
        ? {
            id: found.ownerUserId,
            displayName: nameOf.get(found.ownerUserId) ?? found.ownerUserId,
          }
        : null,
      activities: found.activities.map((activity) => ({
        ...activity,
        createdByName: nameOf.get(activity.createdBy) ?? activity.createdBy,
        completedByName: activity.completedBy
          ? (nameOf.get(activity.completedBy) ?? activity.completedBy)
          : null,
      })),
      ...prospectingOf({
        ...(found as unknown as DiscoveryFields),
        _count: { activities: contacts.length },
        activities: contacts,
      }),
      /** CD-85 — the company wants Discovery done before a deal; the workflow decides, the screen warns. */
      discovery_required: config?.discoveryRequired ?? false,
    };
  }

  /**
   * `options.unowned` = ใบนี้เข้ากองกลาง ไม่มีเจ้าของ.
   *
   * มีไว้ให้ทางเข้าที่ *ไม่มีคน* อยู่ปลายสาย — `POST /integrations/crm/leads`
   * ที่ระบบภายนอกยิงมาด้วยบัญชีบริการ (14 ก.ย. 2569). ไม่ใช่ธงสำหรับหน้าจอ:
   * คนกดเพิ่ม Lead เองย่อมเป็นเจ้าของใบนั้น.
   *
   * ทางเข้าเดียวกันทั้งสองแบบโดยตั้งใจ — ขั้นตั้งต้นมาจากหน้าตั้งค่า, audit
   * เขียนเหมือนกัน, workflow ถูก start เหมือนกัน. แยก path ให้ integration
   * เมื่อไร คือวันที่ Lead จากเว็บฟอร์มเริ่มมี pipeline คนละชุดกับใบที่คนกรอก.
   */
  async create(
    dto: CreateLeadDto,
    actor: Principal,
    options: { unowned?: boolean } = {},
  ) {
    if (dto.customer_id) await this.assertCustomer(dto.customer_id, actor);
    const campaignId = await this.campaigns.resolveCode(
      dto.campaign_code,
      actor.activeCompanyId,
    );

    const row = (await this.leads.create({
      data: {
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        ...leadColumns(dto, false),
        ...(dto.intake_data
          ? {
              intakeData: intakePatch(dto.intake_data)
                .set as Prisma.InputJsonValue,
            }
          : {}),
        campaignId: campaignId ?? null,
        // ขั้นตั้งต้นมาจากหน้าตั้งค่า ไม่ใช่ค่า default ของคอลัมน์ — ผู้ดูแลที่ย้ายธง
        // "สถานะตั้งต้น" ไปขั้นอื่นต้องเห็นผลกับ Lead ใบถัดไปทันที.
        status: await this.statuses.defaultCode(actor.activeCompanyId),
        ownerUserId: options.unowned ? null : actor.userId,
        ownerOrgUnitId: options.unowned ? null : actor.orgUnitId,
        createdBy: actor.userId,
      },
    })) as LeadEventRow;

    await this.audit.record({
      eventType: 'crm.lead.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: row.id,
      after: {
        name: dto.name,
        sourceCode: dto.source_code,
        campaignCode: campaignId
          ? dto.campaign_code?.trim().toUpperCase()
          : null,
        // ตอบคำถาม "ใบนี้เข้ามาแล้วไปอยู่กับใคร" ได้จาก audit ใบเดียว — ค่า null
        // คือกองกลาง และเป็นจุดเริ่มของคู่ before/after ที่ `crm.lead.assigned` เขียนต่อ.
        ownerUserId: options.unowned ? null : actor.userId,
      },
    });

    /*
      Lead ใบใหม่ = process ใบใหม่ (PO 10 ก.ย. 2569). ยิงหลัง audit เขียนเสร็จ
      และไม่ `await` — OSD Workflow ล่มต้องไม่ทำให้เพิ่ม Lead ไม่ได้; งานที่ยิง
      ไม่ผ่านลงคิว `integration_sync_jobs` แล้ว sweeper ตามเก็บเอง.
    */
    this.workflowSync.kickLead(row.id);

    await this.events.emit({
      name: 'lead.created',
      payload: leadEvent(actor.activeCompanyId, row),
    });

    return row;
  }

  async update(id: string, dto: UpdateLeadDto, actor: Principal) {
    // a whole-object write here would undo another channel's keys; merge has its own route
    if (dto.intake_data !== undefined) {
      throw new AppError(
        'VALIDATION_FAILED',
        'แก้ intake data ผ่าน PATCH …/leads/{id}/intake-data',
        [{ field: 'intake_data', reason: 'use_intake_data_route' }],
      );
    }
    await this.requireOpen(id, actor);
    if (dto.customer_id) await this.assertCustomer(dto.customer_id, actor);
    const campaignId = await this.campaigns.resolveCode(
      dto.campaign_code,
      actor.activeCompanyId,
    );

    const row = (await this.leads.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...leadColumns(dto, true),
        ...(campaignId !== undefined ? { campaignId } : {}),
        updatedBy: actor.userId,
      },
    })) as LeadEventRow;

    await this.events.emit({
      name: 'lead.updated',
      payload: leadEvent(actor.activeCompanyId, row, {
        changed_fields: Object.keys(dto).filter(
          (field) => dto[field as keyof UpdateLeadDto] !== undefined,
        ),
      }),
    });

    return row;
  }

  /** Merge (default) or replace `intakeData` on an open lead. */
  async updateIntakeData(
    id: string,
    dto: UpdateLeadIntakeDataDto,
    actor: Principal,
  ) {
    await this.requireOpen(id, actor);
    const { set, remove } = intakePatch(dto.data);

    const row = dto.replace
      ? ((await this.leads.update({
          where: { id },
          data: {
            intakeData: set as Prisma.InputJsonValue,
            updatedBy: actor.userId,
          },
        })) as LeadEventRow)
      : await this.leads.mergeIntakeData(id, set, remove, actor.userId);

    const keys = Object.keys(dto.data);
    await this.audit.record({
      eventType: 'crm.lead.intake_updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      // key names only — the values are the sender's and may hold anything
      after: { keys, replace: dto.replace ?? false },
    });

    await this.events.emit({
      name: 'lead.intake_updated',
      payload: leadEvent(actor.activeCompanyId, row, { changed_fields: keys }),
    });

    return this.leads.findFirst({
      where: { id },
      select: { id: true, intakeData: true, updatedAt: true },
    });
  }

  /**
   * มอบหมายเจ้าของ — ทั้ง "หัวหน้าแจกงาน" และ "คนขายกดรับใบจากกองกลาง"
   * (14 ก.ย. 2569).
   *
   * หนึ่ง endpoint สำหรับสองเรื่องนี้เพราะมันคือการกระทำเดียวกัน: เขียนชื่อคน
   * ลงบนใบที่ยังไม่มี หรือย้ายจากคนหนึ่งไปอีกคน. แยกเป็น `claim` กับ `assign`
   * จะได้โค้ดสองชุดที่ต้องเขียน audit เหมือนกัน แล้ววันหนึ่งจะเหมือนกันไม่หมด.
   *
   * ปลายทางต้องเป็นคนที่ **ยัง active และอยู่ในบริษัทนี้** — ไม่ใช่กฎ process
   * แต่เป็นความถูกต้องของข้อมูล (SCOPE-03): ใบที่ชี้ไปยังคนนอกบริษัทคือใบที่
   * หลุดจากทุกคิว. ส่วนคำถามว่า *ควร* แจกให้ใคร (โควตา, เขตการขาย, เวร) เป็น
   * process — อยู่บน workflow ไม่ใช่ที่นี่.
   */
  async assign(id: string, dto: AssignLeadDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);
    const targetId = dto.owner_user_id?.trim() || actor.userId;
    const target = await this.requireCompanyMember(targetId, actor);

    /*
      ไม่มีอะไรเปลี่ยน = ไม่เขียนอะไร. กดรับซ้ำใบที่ตัวเองถืออยู่แล้วได้ใบเดิม
      กลับไปเงียบ ๆ โดยไม่มี audit ปลอมว่า "มอบหมายให้ตัวเอง" เพิ่มมาอีกใบ.
    */
    if (found.ownerUserId === target.id) {
      return this.leads.findFirst({ where: { id } });
    }

    /*
      แย่งใบกันในกองกลาง — เงื่อนไข "ยังไม่มีเจ้าของ" อยู่ใน statement ไม่ใช่ใน if
      ด้านบน. คนขายสองคนกดรับพร้อมกันจะอ่าน `ownerUserId: null` ได้ทั้งคู่ ถ้าตัด
      สินจากค่าที่อ่านมา คนที่สองจะเขียนทับคนแรกแบบเงียบ ๆ แล้วทั้งคู่เห็นว่า
      "ได้ใบแล้ว" — ฐานข้อมูลต้องเป็นคนตัดสิน และ `count: 0` คือคำตอบของคนที่แพ้.

      การ *โอน* (ระบุ `owner_user_id` มาชัด ๆ) ไม่มีเงื่อนไขนี้: เป็นการตัดสินใจ
      ของคนแจกว่าใบนี้ต้องไปอยู่กับใคร ไม่ใช่การแข่งกันหยิบ.
    */
    const written = await this.leads.updateMany({
      where: dto.owner_user_id ? { id } : { id, ownerUserId: null },
      data: {
        ownerUserId: target.id,
        ownerOrgUnitId: target.orgUnitId,
        updatedBy: actor.userId,
      },
    });

    if (written.count === 0) {
      throw new AppError(
        'CONFLICT',
        'Lead ใบนี้มีผู้รับผิดชอบแล้ว — ถ้าต้องการโอนให้คนอื่น ระบุ owner_user_id',
        [{ field: 'owner_user_id', reason: 'already_assigned' }],
      );
    }

    await this.audit.record({
      eventType: 'crm.lead.assigned',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      before: { ownerUserId: found.ownerUserId },
      after: { ownerUserId: target.id },
    });

    /*
      อ่านกลับตรง ๆ ไม่ผ่าน `findOne` — คนที่โอนใบให้คนอื่นอาจมองไม่เห็นใบนั้น
      อีกแล้วหลังโอน (SCOPE-02) และการอ่านซ้ำผ่านตัวกรองจะตอบ 404 ให้กับงานที่
      เพิ่งสำเร็จ. ด่านขอบเขตผ่านไปแล้วตอน `requireOpen` ต้นเมธอด.
    */
    return this.leads.findFirst({ where: { id } });
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

      await this.events.emit({
        name: 'lead.status_changed',
        payload: leadEvent(
          actor.activeCompanyId,
          { ...found, status: target.code },
          { previous_status: found.status },
        ),
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
    assertOutcomeFits(dto.type, dto.outcome);

    const activity = (await this.activities.create({
      data: {
        companyId: actor.activeCompanyId,
        leadId: id,
        type: dto.type,
        subject: dto.subject.trim(),
        detail: dto.detail?.trim() || null,
        outcome: dto.outcome ?? null,
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
      after: {
        activityId: activity.id,
        type: dto.type,
        subject: dto.subject,
        outcome: dto.outcome ?? null,
      },
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
    })) as { id: string; type: string; completedAt: Date | null } | null;
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
    if (dto.outcome !== undefined) {
      assertOutcomeFits(activity.type, dto.outcome);
      data.outcome = dto.outcome;
    }

    return this.activities.update({ where: { id: activityId }, data });
  }

  /**
   * ปิดแบบไม่ได้ไปต่อ — สถานะชนิด `lost` + เหตุผล, ไม่มีการลบ. บริษัทมีปลายทาง
   * แบบนี้ได้หลายขั้น (Lost / Disqualified) จึงเลือกได้ด้วย `dto.status`.
   */
  async disqualify(id: string, dto: DisqualifyLeadDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);

    const status = dto.status
      ? await this.requireLostStatus(actor.activeCompanyId, dto.status)
      : await this.statuses.closingCode(actor.activeCompanyId, 'lost');
    await this.leads.update({
      where: { id },
      data: {
        status,
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
      after: { status, reason: dto.reason },
    });

    await this.events.emit({
      name: 'lead.status_changed',
      payload: leadEvent(
        actor.activeCompanyId,
        { ...found, status },
        {
          previous_status: found.status,
          reason: dto.reason.trim(),
        },
      ),
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

    // opportunity.ownerUserId is a person; a service account has no User row
    if (actor.isServiceAccount && !lead.ownerUserId) {
      throw new AppError(
        'CONFLICT',
        'Lead นี้ยังอยู่ในกองกลาง — มอบหมายเจ้าของก่อนแปลงเป็นโอกาสการขาย',
        [{ field: 'owner_user_id', reason: 'unowned' }],
      );
    }

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
      actor.isServiceAccount && lead.ownerUserId
        ? {
            fromLeadId: id,
            owner: { userId: lead.ownerUserId, orgUnitId: lead.ownerOrgUnitId },
          }
        : { fromLeadId: id },
    );

    const status = await this.statuses.closingCode(
      actor.activeCompanyId,
      'won',
    );
    await this.leads.update({
      where: { id },
      data: {
        status,
        convertedOpportunityId: opportunity.id,
        customerId: customerId ?? null,
        updatedBy: actor.userId,
      },
    });

    // CD-85 — the target this lead came from has become a deal.
    await this.targets.updateMany({
      where: { leadId: id, status: 'approaching' },
      data: { status: 'converted', updatedBy: actor.userId },
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

    await this.events.emit({
      name: 'lead.converted',
      payload: leadEvent(
        actor.activeCompanyId,
        { ...lead, status },
        {
          previous_status: lead.status,
          opportunity_id: opportunity.id,
          opportunity_code: opportunity.opportunityCode,
        },
      ),
    });

    return opportunity;
  }

  private async requireLostStatus(companyId: string, code: string) {
    const target = await this.statuses.require(companyId, code);

    if (target.kind !== 'lost') {
      throw new AppError(
        'VALIDATION_FAILED',
        `สถานะ "${target.nameTh}" ไม่ใช่สถานะปิดแบบไม่ได้ไปต่อ`,
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

    return target.code;
  }

  /** Visible AND still workable (anything but converted/disqualified). SCOPE-03: unseen = 404. */
  private async requireOpen(id: string, actor: Principal) {
    const found = (await this.leads.findFirst({
      where: {
        id,
        AND: [visibleLeadsWhere(salesAccessSubject(actor))],
      },
    })) as {
      id: string;
      name: string;
      status: string;
      ownerUserId: string | null;
      ownerOrgUnitId: string | null;
      sourceCode: string | null;
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

  /** ปลายทางของการมอบหมาย: ต้องเป็นคนที่ยังทำงานอยู่ในบริษัทที่ active. */
  private async requireCompanyMember(userId: string, actor: Principal) {
    const member = (await this.members.findFirst({
      where: {
        id: userId,
        status: 'ACTIVE',
        companies: { some: { companyId: actor.activeCompanyId } },
      },
      select: { id: true, orgUnitId: true },
    })) as { id: string; orgUnitId: string | null } | null;

    if (!member) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ไม่พบผู้ใช้ที่ระบุ หรือผู้ใช้ไม่ได้อยู่ในบริษัทนี้',
        [{ field: 'owner_user_id', reason: userId }],
      );
    }

    return member;
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

/**
 * CD-85 — an outcome belongs to a contact (a call answered or not). On a task
 * or a note it would count as an attempt that never happened.
 */
function assertOutcomeFits(type: string, outcome: string | null | undefined) {
  if (outcome && !(CONTACT_TYPES as readonly string[]).includes(type)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'ผลการติดต่อใช้กับการโทร อีเมล นัดหมาย เข้าพบ LINE หรือโซเชียลเท่านั้น',
      [{ field: 'outcome', reason: type }],
    );
  }
}
