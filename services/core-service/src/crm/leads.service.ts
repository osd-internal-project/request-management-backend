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
import { LeadRepository } from './sales.repositories';
import { DealsService } from './deals.service';
import { CustomerRepository } from './customer.repository';
import {
  ConvertLeadDto,
  CreateLeadDto,
  DisqualifyLeadDto,
  ListLeadsQueryDto,
  UpdateLeadDto,
} from './dto/sales.dto';

/**
 * CRM Lead — รับ → คัดกรอง → แปลงเป็นดีล (ข้อมูลไหลต่อ) หรือคัดออกพร้อม
 * เหตุผล. Scope ผ่าน `visibleSalesWhere` (SCOPE-02) — คนขายเห็น Lead ของตน
 * และของทีม, `crm.sales.read.all` เห็นทั้งบริษัท. No hard delete.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly customers: CustomerRepository,
    private readonly deals: DealsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
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
          convertedDeal: { select: { id: true, dealCode: true } },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.leads.count({ where }),
    ]);

    return paginated(rows as unknown[], query, total);
  }

  async create(dto: CreateLeadDto, actor: Principal) {
    if (dto.customer_id) await this.assertCustomer(dto.customer_id, actor);

    const row = (await this.leads.create({
      data: {
        companyId: actor.activeCompanyId,
        name: dto.name.trim(),
        contactName: dto.contact_name?.trim() || null,
        phone: dto.phone?.trim() || null,
        email: dto.email?.trim() || null,
        note: dto.note?.trim() || null,
        sourceCode: dto.source_code?.trim() || null,
        customerId: dto.customer_id ?? null,
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

    return row;
  }

  async update(id: string, dto: UpdateLeadDto, actor: Principal) {
    await this.requireOpen(id, actor);
    if (dto.customer_id) await this.assertCustomer(dto.customer_id, actor);

    return this.leads.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.contact_name !== undefined
          ? { contactName: dto.contact_name?.trim() || null }
          : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.email !== undefined ? { email: dto.email?.trim() || null } : {}),
        ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
        ...(dto.source_code !== undefined
          ? { sourceCode: dto.source_code?.trim() || null }
          : {}),
        ...(dto.customer_id !== undefined
          ? { customerId: dto.customer_id || null }
          : {}),
        updatedBy: actor.userId,
      },
    });
  }

  /** คัดออก — สถานะ + เหตุผล, ไม่มีการลบ. */
  async disqualify(id: string, dto: DisqualifyLeadDto, actor: Principal) {
    const found = await this.requireOpen(id, actor);

    await this.leads.update({
      where: { id },
      data: {
        status: 'disqualified',
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
   * แปลงเป็นดีล — spec: "แปลงเป็นโอกาสการขายโดยข้อมูลไหลต่อทั้งหมด". The
   * deal is created through DealsService (same code path as a hand-made
   * deal), then the lead points at it and closes as `converted`.
   */
  async convert(id: string, dto: ConvertLeadDto, actor: Principal) {
    const lead = await this.requireOpen(id, actor);
    await this.assertCustomer(dto.customer_id, actor);

    const deal = await this.deals.create(
      {
        customer_id: dto.customer_id,
        title: dto.title?.trim() || lead.name,
        amount: dto.amount,
      },
      actor,
      { fromLeadId: id },
    );

    await this.leads.update({
      where: { id },
      data: {
        status: 'converted',
        convertedDealId: deal.id,
        customerId: dto.customer_id,
        updatedBy: actor.userId,
      },
    });

    await this.audit.record({
      eventType: 'crm.lead.converted',
      companyId: actor.activeCompanyId,
      ...auditActor(actor),
      resourceType: 'lead',
      resourceId: id,
      after: { dealId: deal.id, dealCode: deal.dealCode },
    });

    return deal;
  }

  /** Visible AND still workable (new/qualified). SCOPE-03: unseen = 404. */
  private async requireOpen(id: string, actor: Principal) {
    const found = (await this.leads.findFirst({
      where: {
        id,
        AND: [visibleSalesWhere(salesAccessSubject(actor))],
      } as Prisma.LeadWhereInput,
    })) as {
      id: string;
      name: string;
      status: string;
    } | null;

    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบ Lead ที่ระบุ');
    if (found.status === 'converted' || found.status === 'disqualified') {
      throw new AppError(
        'CONFLICT',
        'Lead นี้ถูกปิดแล้ว (แปลงเป็นดีลหรือคัดออก) — แก้ไขไม่ได้',
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
}
