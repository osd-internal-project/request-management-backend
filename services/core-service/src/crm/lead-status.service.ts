import { Injectable } from '@nestjs/common';
import type { LeadStatusKind } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
  TQueryClient,
} from '@request-management/share';
import { LeadRepository, LeadStatusRepository } from './sales.repositories';
import {
  CreateLeadStatusDto,
  ReorderLeadStatusesDto,
  UpdateLeadStatusSettingDto,
} from './dto/sales.dto';

/** What every caller of this service reads back. */
export interface LeadStatusRow {
  id: string;
  companyId: string;
  code: string;
  nameTh: string;
  kind: LeadStatusKind;
  color: string;
  isDefault: boolean;
  isSystem: boolean;
  active: boolean;
  sortOrder: number;
}

/**
 * ชุดตั้งต้นของบริษัทใหม่ — เท่ากับที่ migration seed ให้บริษัทเดิมทุกประการ.
 * สามแถวที่ `isSystem` คือปลายทางที่โค้ดต้องมีเสมอ (ตั้งต้น / แปลงแล้ว / คัดออก);
 * `cannot_contact`, `contacted`, `qualified` เป็นขั้นธรรมดา ลบหรือเปลี่ยนชื่อได้.
 */
export const DEFAULT_LEAD_STATUSES: readonly Omit<
  LeadStatusRow,
  'id' | 'companyId'
>[] = [
  {
    code: 'new',
    nameTh: 'ใหม่',
    kind: 'open',
    color: 'blue',
    isDefault: true,
    isSystem: true,
    active: true,
    sortOrder: 10,
  },
  {
    code: 'cannot_contact',
    nameTh: 'ติดต่อไม่ได้',
    kind: 'open',
    color: 'orange',
    isDefault: false,
    isSystem: false,
    active: true,
    sortOrder: 20,
  },
  {
    code: 'contacted',
    nameTh: 'ติดต่อแล้ว',
    kind: 'open',
    color: 'cyan',
    isDefault: false,
    isSystem: false,
    active: true,
    sortOrder: 30,
  },
  {
    code: 'qualified',
    nameTh: 'ผ่านคัดกรอง',
    kind: 'open',
    color: 'green',
    isDefault: false,
    isSystem: false,
    active: true,
    sortOrder: 40,
  },
  {
    code: 'converted',
    nameTh: 'แปลงเป็นโอกาสการขายแล้ว',
    kind: 'won',
    color: 'purple',
    isDefault: false,
    isSystem: true,
    active: true,
    sortOrder: 50,
  },
  {
    code: 'disqualified',
    nameTh: 'คัดออก',
    kind: 'lost',
    color: 'red',
    isDefault: false,
    isSystem: true,
    active: true,
    sortOrder: 60,
  },
];

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,29}$/;

/**
 * รายการสถานะ Lead ต่อบริษัท — configuration over code (D-09): เพิ่ม ลบ
 * เปลี่ยนชื่อ สลับลำดับ ได้จากหน้า "ตั้งค่า CRM → สถานะ Lead" โดยไม่ต้อง deploy.
 *
 * **สิ่งที่โค้ดยึดคือ `kind` ไม่ใช่รหัส** — `won` คือปลายทางของการแปลงเป็นโอกาส
 * การขาย, `lost` คือปลายทางของการคัดออก, ที่เหลือ `open` คือขั้นระหว่างทางที่
 * เลื่อนไปมาได้อิสระ. ผู้ดูแลจึงเปลี่ยนชื่อ "ผ่านคัดกรอง" หรือแทรกขั้นใหม่ได้
 * โดยไม่มีอะไรในโค้ดต้องรู้จักรหัสนั้น.
 *
 * **ที่นี่มีแต่รายการขั้น ไม่มีกฎการเลื่อนขั้น** — PO ตัดสิน 10 ก.ย. 2569 ว่า
 * workflow ของ CRM อยู่บน service `workflowable` ("Workflow owns Process, Core
 * owns Data"). เงื่อนไขอย่าง "ต้องมีกิจกรรมที่ทำเสร็จก่อน" หรือ "ขั้นนี้แปลงเป็น
 * โอกาสการขายได้" เป็น Decision rule บน workflow `lwf-0001` ไม่ใช่คอลัมน์ในตาราง
 * นี้. สิ่งที่ service นี้ยังบังคับคือ *ความถูกต้องของข้อมูล* เท่านั้น: ขอบเขต
 * บริษัท, รหัสต้องมีจริง, ปลายทางต้องมีอยู่, และลบขั้นที่ยังมี Lead ใช้อยู่ไม่ได้.
 */
@Injectable()
export class LeadStatusService {
  constructor(
    private readonly statuses: LeadStatusRepository,
    private readonly leads: LeadRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /**
   * ทุกสถานะของบริษัท เรียงตามลำดับที่ตั้งไว้ — รวมที่ปิดใช้งาน เพราะหน้า admin
   * ต้องเห็น และ Lead เดิมอาจยังค้างอยู่ที่สถานะที่เพิ่งปิด.
   */
  async listAll(companyId: string): Promise<LeadStatusRow[]> {
    const rows = (await this.statuses.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    })) as LeadStatusRow[];

    if (rows.length > 0) return rows;

    // บริษัทที่ยังไม่เคยมีชุดสถานะ (สร้างหลัง migration) — วางชุดตั้งต้นให้
    // ตอนอ่านครั้งแรก แทนที่จะให้หน้าจอเจอตารางว่างซึ่งแปลว่า "พังหรือยังไม่ตั้ง"
    // แยกไม่ออก.
    return this.seedDefaults(companyId);
  }

  /** สถานะตามรหัส — ไม่พบ = ข้อมูลที่ส่งมาไม่ถูก ไม่ใช่ 404 ของทรัพยากร. */
  async require(companyId: string, code: string): Promise<LeadStatusRow> {
    const rows = await this.listAll(companyId);
    const found = rows.find((row) => row.code === code);

    if (!found) {
      throw new AppError('VALIDATION_FAILED', 'ไม่พบสถานะ Lead ที่ระบุ', [
        { field: 'status', reason: code },
      ]);
    }

    return found;
  }

  /** สถานะตั้งต้นของ Lead ที่เพิ่งรับเข้า. */
  async defaultCode(companyId: string): Promise<string> {
    const rows = await this.listAll(companyId);
    const preferred =
      rows.find((row) => row.isDefault && row.active && row.kind === 'open') ??
      rows.find((row) => row.active && row.kind === 'open');

    if (!preferred) {
      throw new AppError(
        'VALIDATION_FAILED',
        'บริษัทนี้ยังไม่มีสถานะ Lead ที่เปิดใช้งาน — ตั้งค่าที่หน้าตั้งค่า CRM ก่อน',
        [{ field: 'status', reason: 'no_open_status' }],
      );
    }

    return preferred.code;
  }

  /** ปลายทางของ convert (`won`) / disqualify (`lost`) — มีอย่างละหนึ่งเสมอ. */
  async closingCode(
    companyId: string,
    kind: Exclude<LeadStatusKind, 'open'>,
  ): Promise<string> {
    const rows = await this.listAll(companyId);
    const found = rows.find((row) => row.kind === kind);

    if (!found) {
      throw new AppError(
        'VALIDATION_FAILED',
        'บริษัทนี้ยังไม่มีสถานะปลายทางของ Lead — ตั้งค่าที่หน้าตั้งค่า CRM ก่อน',
        [{ field: 'status', reason: `no_${kind}_status` }],
      );
    }

    return found.code;
  }

  // --- หน้า admin ----------------------------------------------------------

  list(actor: Principal): Promise<LeadStatusRow[]> {
    return this.listAll(actor.activeCompanyId);
  }

  /**
   * ขั้นใหม่เป็น `open` เสมอ — ปลายทางเพิ่มไม่ได้: `convert` และ `disqualify`
   * ต้องรู้ว่าจะพา Lead ไปที่แถวไหน และคำตอบสองแถวไม่ใช่คำตอบ.
   */
  async create(dto: CreateLeadStatusDto, actor: Principal) {
    const code = dto.code.trim().toLowerCase();
    this.assertCode(code);

    const existing = await this.statuses.findFirst({
      where: { companyId: actor.activeCompanyId, code },
      select: { id: true },
    });

    if (existing) {
      throw new AppError('CONFLICT', 'รหัสสถานะนี้มีอยู่แล้ว', [
        { field: 'code', reason: code },
      ]);
    }

    const rows = await this.listAll(actor.activeCompanyId);
    const last = rows[rows.length - 1];

    return this.transactions.execute(async (prisma) => {
      if (dto.is_default)
        await this.clearDefault(actor.activeCompanyId, prisma);

      const row = (await this.statuses.create(
        {
          data: {
            companyId: actor.activeCompanyId,
            code,
            nameTh: dto.name_th.trim(),
            kind: 'open',
            color: dto.color?.trim() || 'default',
            isDefault: dto.is_default ?? false,
            sortOrder: dto.sort_order ?? (last ? last.sortOrder + 10 : 10),
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      )) as LeadStatusRow;

      await this.audit.record(
        {
          eventType: 'crm.lead_status.created',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'lead_status',
          resourceId: row.id,
          after: { ...row },
        },
        { prisma },
      );

      return row;
    });
  }

  async update(id: string, dto: UpdateLeadStatusSettingDto, actor: Principal) {
    const rows = await this.listAll(actor.activeCompanyId);
    const found = rows.find((row) => row.id === id);
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสถานะ Lead ที่ระบุ');

    const next: LeadStatusRow = {
      ...found,
      nameTh: dto.name_th?.trim() || found.nameTh,
      color: dto.color?.trim() || found.color,
      isDefault: dto.is_default ?? found.isDefault,
      active: dto.active ?? found.active,
      sortOrder: dto.sort_order ?? found.sortOrder,
    };

    this.assertStillWorkable(rows, next);

    return this.transactions.execute(async (prisma) => {
      if (next.isDefault && !found.isDefault) {
        await this.clearDefault(actor.activeCompanyId, prisma);
      }

      const row = (await this.statuses.update(
        {
          where: { id },
          data: {
            nameTh: next.nameTh,
            color: next.color,
            isDefault: next.isDefault,
            active: next.active,
            sortOrder: next.sortOrder,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      )) as LeadStatusRow;

      await this.audit.record(
        {
          eventType: 'crm.lead_status.updated',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'lead_status',
          resourceId: id,
          before: { ...found },
          after: { ...row },
        },
        { prisma },
      );

      return row;
    });
  }

  /**
   * ลบได้เฉพาะขั้นที่ไม่มี Lead ใดอ้างอยู่ — มี Lead อยู่ให้ปิดใช้งานแทน
   * (`CRM_LEAD_STATUS_IN_USE`). สถานะระบบลบไม่ได้เลย.
   */
  async remove(id: string, actor: Principal): Promise<void> {
    const rows = await this.listAll(actor.activeCompanyId);
    const found = rows.find((row) => row.id === id);
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสถานะ Lead ที่ระบุ');

    if (found.isSystem) {
      throw new AppError(
        'CONFLICT',
        'สถานะระบบลบไม่ได้ — ระบบต้องมีสถานะตั้งต้นและปลายทางเสมอ',
        [{ field: 'id', reason: 'system_status' }],
      );
    }

    const inUse = await this.leads.count({
      where: { companyId: actor.activeCompanyId, status: found.code },
    });

    if (inUse > 0) {
      throw new AppError(
        'CRM_LEAD_STATUS_IN_USE',
        'สถานะนี้มี Lead ใช้อยู่ — ปิดใช้งานแทนการลบ',
        [{ field: 'id', reason: `${inUse} leads` }],
      );
    }

    this.assertStillWorkable(
      rows.filter((row) => row.id !== id),
      null,
    );

    await this.transactions.execute(async (prisma) => {
      await this.statuses.delete({ where: { id } }, { prisma });

      await this.audit.record(
        {
          eventType: 'crm.lead_status.deleted',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'lead_status',
          resourceId: id,
          before: { ...found },
        },
        { prisma },
      );
    });
  }

  /** ลำดับใหม่ทั้งชุด — ids เรียงตามที่หน้าจอแสดง. */
  async reorder(dto: ReorderLeadStatusesDto, actor: Principal) {
    const rows = await this.listAll(actor.activeCompanyId);
    const known = new Set(rows.map((row) => row.id));

    const unknown = dto.ids.find((id) => !known.has(id));
    if (unknown || dto.ids.length !== rows.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ลำดับที่ส่งมาไม่ตรงกับสถานะที่มีอยู่',
        [{ field: 'ids', reason: unknown ?? 'incomplete' }],
      );
    }

    await this.transactions.execute(async (prisma) => {
      for (const [index, id] of dto.ids.entries()) {
        await this.statuses.update(
          {
            where: { id },
            data: { sortOrder: (index + 1) * 10, updatedBy: actor.userId },
          },
          { prisma },
        );
      }

      await this.audit.record(
        {
          eventType: 'crm.lead_status.reordered',
          companyId: actor.activeCompanyId,
          ...auditActor(actor),
          resourceType: 'lead_status',
          after: { ids: dto.ids },
        },
        { prisma },
      );
    });

    return this.listAll(actor.activeCompanyId);
  }

  // --- helpers -------------------------------------------------------------

  private assertCode(code: string): void {
    if (CODE_PATTERN.test(code)) return;

    throw new AppError(
      'VALIDATION_FAILED',
      'รหัสสถานะต้องเป็น a–z, 0–9 หรือ _ ขึ้นต้นด้วยตัวอักษร ยาวไม่เกิน 30 ตัว',
      [{ field: 'code', reason: code }],
    );
  }

  /**
   * pipeline ที่เหลือต้องยังเดินได้ — ต้องมีขั้นระหว่างทางที่เปิดใช้งานเหลืออยู่
   * และสถานะระบบต้องไม่ถูกปิด. `candidate` คือแถวหลังแก้ (null = แถวนั้นถูกลบ).
   *
   * ไม่มีเงื่อนไขเรื่อง "ต้องเหลือขั้นที่แปลงต่อได้" ที่นี่: ขั้นไหนแปลงต่อได้เป็น
   * เรื่องของ workflow `lwf-0001` ไม่ใช่ของตารางนี้.
   */
  private assertStillWorkable(
    rows: LeadStatusRow[],
    candidate: LeadStatusRow | null,
  ): void {
    const after = candidate
      ? rows.map((row) => (row.id === candidate.id ? candidate : row))
      : rows;

    const open = after.filter((row) => row.kind === 'open' && row.active);

    if (candidate?.isSystem && !candidate.active) {
      throw new AppError('CONFLICT', 'สถานะระบบปิดใช้งานไม่ได้', [
        { field: 'active', reason: 'system_status' },
      ]);
    }

    if (open.length === 0) {
      throw new AppError(
        'CONFLICT',
        'ต้องเหลือสถานะระหว่างทางที่เปิดใช้งานอย่างน้อยหนึ่งขั้น',
        [{ field: 'active', reason: 'no_open_status' }],
      );
    }

  }

  private async clearDefault(companyId: string, prisma: TQueryClient) {
    const current = (await this.statuses.findMany({
      where: { companyId, isDefault: true },
      select: { id: true },
    })) as { id: string }[];

    for (const row of current) {
      await this.statuses.update(
        { where: { id: row.id }, data: { isDefault: false } },
        { prisma },
      );
    }
  }

  private async seedDefaults(companyId: string): Promise<LeadStatusRow[]> {
    await this.statuses.createMany({
      data: DEFAULT_LEAD_STATUSES.map((status) => ({
        ...status,
        companyId,
      })),
      skipDuplicates: true,
    });

    return await this.statuses.findMany({
      where: { companyId },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }
}
