import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  paginated,
  salesAccessSubject,
  toSkipTake,
  visibleLeadsWhere,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  ApproachTargetAccountDto,
  CreateTargetAccountDto,
  DropTargetAccountDto,
  ListTargetAccountsQueryDto,
  UpdateTargetAccountDto,
} from './dto/sales.dto';
import { LeadsService } from './leads.service';
import { targetMayMove, type TargetStatus } from './prospecting-rules';
import { TargetAccountRepository } from './target-accounts.repository';

/** snake_case DTO field → column, for the free-text fields. */
const TEXT_COLUMNS = [
  ['name_en', 'nameEn'],
  ['tax_id', 'taxId'],
  ['industry', 'industry'],
  ['company_size', 'companySize'],
  ['province', 'province'],
  ['website', 'website'],
  ['note', 'note'],
] as const;

export interface TargetRow {
  id: string;
  companyId: string;
  name: string;
  nameEn: string | null;
  taxId: string | null;
  industry: string | null;
  companySize: string | null;
  province: string | null;
  note: string | null;
  status: TargetStatus;
  leadId: string | null;
  ownerUserId: string | null;
}

/**
 * CD-85 — บริษัทเป้าหมาย (Target Account) ของแกน Getter (ผู้ใช้เลือก 29 ก.ย.
 * 2569: ตารางแยก ไม่ใช่ธงบน Lead). รายชื่อที่จะเปิดตลาด จัดลำดับก่อนหลังได้
 * ก่อนมีใครติดต่อ — บอร์ด Lead จึงไม่เต็มไปด้วยบริษัทที่ยังไม่มีใครโทรหา.
 *
 * "เริ่มเข้าหา" สร้าง Lead ผ่าน `LeadsService.create` ทางเดียวกับที่คนกดเพิ่ม
 * Lead เอง (สถานะตั้งต้น, audit, workflow `lwf-0001`) แล้วงานเดินบน Lead ต่อ —
 * ไม่มี pipeline ชุดที่สอง. Lead แปลงเป็นดีลเมื่อไร เป้าหมายเป็น `converted`
 * (`LeadsService.convert`).
 *
 * Visibility is the leads rule (`visibleLeadsWhere`): owner, creator, the
 * owner's units, and the unowned pool. No hard delete — dropped with a reason.
 */
@Injectable()
export class TargetAccountsService {
  constructor(
    private readonly targets: TargetAccountRepository,
    private readonly leads: LeadsService,
    private readonly members: CompanyMemberRepository,
    private readonly audit: AuditWriter,
  ) {}

  async list(query: ListTargetAccountsQueryDto, actor: Principal) {
    const { skip, take } = toSkipTake(query);
    const filters: Prisma.TargetAccountWhereInput = {};
    if (query.status) filters.status = query.status;
    if (query.priority) filters.priority = query.priority;
    if (query.view === 'mine') filters.ownerUserId = actor.userId;
    if (query.view === 'unassigned') filters.ownerUserId = null;
    if (query.search) {
      const q = query.search.trim();
      filters.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { nameEn: { contains: q, mode: 'insensitive' } },
        { taxId: { contains: q } },
      ];
    }
    const where = {
      AND: [visibleLeadsWhere(salesAccessSubject(actor)), filters],
    } as Prisma.TargetAccountWhereInput;

    const [rows, total] = await Promise.all([
      this.targets.findMany({
        where,
        include: {
          lead: {
            select: {
              id: true,
              name: true,
              status: true,
              convertedOpportunityId: true,
            },
          },
        },
        // high → low is the enum order; within a priority, oldest first —
        // the list is a queue of companies to work through.
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      }),
      this.targets.count({ where }),
    ]);

    const nameOf = await this.displayNames(
      (rows as unknown as TargetRow[]).map((row) => row.ownerUserId),
    );
    return paginated(
      (rows as unknown as TargetRow[]).map((row) => ({
        ...row,
        owner: row.ownerUserId
          ? {
              id: row.ownerUserId,
              displayName: nameOf.get(row.ownerUserId) ?? row.ownerUserId,
            }
          : null,
      })),
      query,
      total,
    );
  }

  async create(dto: CreateTargetAccountDto, actor: Principal) {
    const owner = await this.ownerOf(dto.owner_user_id, actor);
    const row = (await this.targets.create({
      data: {
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        ...columns(dto, false),
        priority: dto.priority ?? 'medium',
        ownerUserId: owner?.id ?? null,
        ownerOrgUnitId: owner?.orgUnitId ?? null,
        createdBy: actor.userId,
      },
    })) as TargetRow;

    await this.audit.record({
      eventType: 'crm.target_account.created',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'target_account',
      resourceId: row.id,
      after: {
        name: row.name,
        priority: dto.priority ?? 'medium',
        ownerUserId: owner?.id ?? null,
      },
    });
    return row;
  }

  async update(id: string, dto: UpdateTargetAccountDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    const owner =
      dto.owner_user_id === undefined
        ? undefined
        : await this.ownerOf(dto.owner_user_id, actor);

    const row = await this.targets.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...columns(dto, true),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(owner !== undefined
          ? {
              ownerUserId: owner?.id ?? null,
              ownerOrgUnitId: owner?.orgUnitId ?? null,
            }
          : {}),
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.target_account.updated',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'target_account',
      resourceId: id,
      before: { name: found.name, ownerUserId: found.ownerUserId },
      after: { ...dto },
    });
    return row;
  }

  /**
   * เริ่มเข้าหา — makes the lead (company fields flow over) and links it. A
   * dropped target that already had its lead goes back to `approaching` on
   * that same lead; it never gets a second one.
   */
  async approach(id: string, dto: ApproachTargetAccountDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    this.assertMove(found.status, 'approaching');

    let leadId = found.leadId;
    if (!leadId) {
      const lead = await this.leads.create(
        {
          name: found.name,
          name_en: found.nameEn ?? undefined,
          tax_id: found.taxId ?? undefined,
          industry: found.industry ?? undefined,
          company_size: found.companySize ?? undefined,
          province: found.province ?? undefined,
          note: found.note ?? undefined,
          contact_name: dto.contact_name,
          phone: dto.phone,
          email: dto.email,
          source_code: 'target_account',
        },
        actor,
      );
      leadId = lead.id;
    }

    // Guarded on the status read: two people pressing at once make one link.
    const moved = await this.targets.updateMany({
      where: { id, status: found.status },
      data: { status: 'approaching', leadId, updatedBy: actor.userId },
    });
    if (moved.count !== 1) {
      throw new AppError(
        'CONFLICT',
        'บริษัทเป้าหมายนี้เพิ่งถูกเปลี่ยนสถานะ — โหลดใหม่แล้วลองอีกครั้ง',
      );
    }

    await this.audit.record({
      eventType: 'crm.target_account.approached',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'target_account',
      resourceId: id,
      before: { status: found.status },
      after: { status: 'approaching', leadId },
    });
    return { id, status: 'approaching', lead_id: leadId };
  }

  async drop(id: string, dto: DropTargetAccountDto, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    this.assertMove(found.status, 'dropped');
    await this.targets.update({
      where: { id },
      data: {
        status: 'dropped',
        dropReason: dto.reason.trim(),
        updatedBy: actor.userId,
      },
    });
    await this.audit.record({
      eventType: 'crm.target_account.dropped',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'target_account',
      resourceId: id,
      before: { status: found.status },
      after: { status: 'dropped', reason: dto.reason.trim() },
    });
    return { id, status: 'dropped' };
  }

  /** Taken up again after a drop — back to the list, lead (if any) kept. */
  async reopen(id: string, actor: Principal) {
    const found = await this.requireVisible(id, actor);
    const to: TargetStatus = found.leadId ? 'approaching' : 'targeting';
    this.assertMove(found.status, to);
    await this.targets.update({
      where: { id },
      data: { status: to, dropReason: null, updatedBy: actor.userId },
    });
    await this.audit.record({
      eventType: 'crm.target_account.reopened',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'target_account',
      resourceId: id,
      before: { status: found.status },
      after: { status: to },
    });
    return { id, status: to };
  }

  private assertMove(from: TargetStatus, to: TargetStatus) {
    if (!targetMayMove(from, to)) {
      throw new AppError(
        'CONFLICT',
        'สถานะปัจจุบันของบริษัทเป้าหมายไม่อนุญาตให้ทำรายการนี้',
        [{ field: 'status', reason: `${from}->${to}` }],
      );
    }
  }

  /** SCOPE-03: out of reach = 404. */
  private async requireVisible(id: string, actor: Principal) {
    const found = (await this.targets.findFirst({
      where: { id, AND: [visibleLeadsWhere(salesAccessSubject(actor))] },
    })) as TargetRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบบริษัทเป้าหมายที่ระบุ');
    return found;
  }

  /**
   * `undefined` = the creator; `""` = nobody yet (the pool); an id must be an
   * active member of this company — a target owned by an outsider drops out
   * of every list.
   */
  private async ownerOf(
    userId: string | undefined,
    actor: Principal,
  ): Promise<{ id: string; orgUnitId: string | null } | null> {
    if (userId === undefined) {
      return { id: actor.userId, orgUnitId: actor.orgUnitId ?? null };
    }
    if (!userId.trim()) return null;
    const member = (await this.members.findFirst({
      where: {
        id: userId.trim(),
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

function columns(
  dto: Partial<CreateTargetAccountDto>,
  onlyGiven: boolean,
): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  for (const [field, column] of TEXT_COLUMNS) {
    const value = dto[field];
    if (onlyGiven && value === undefined) continue;
    data[column] = value?.trim() || null;
  }
  return data;
}
