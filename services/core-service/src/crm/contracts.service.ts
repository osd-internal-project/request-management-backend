import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  customerAccessSubject,
  Principal,
  PrismaTransactionService,
  visibleCustomersWhere,
} from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { RequestRepository } from '../requests/request.repository';
import { CustomerRepository } from './customer.repository';
import { CustomerContractRepository } from './contract.repositories';
import { contractVisibleWhere } from './contract-visibility';
import { CustomerTimelineService } from './customer-timeline.service';
import { OpportunityRepository } from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';

export interface ContractInput {
  contract_no?: string;
  title?: string;
  start_on?: string | null;
  end_on?: string;
  value?: number | null;
  note?: string | null;
  status?: 'active' | 'cancelled';
}

const isoDay = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : null;

const asDate = (day: string) => new Date(`${day}T00:00:00Z`);

interface DealRef {
  id: string;
  title: string;
  ownerUserId: string;
  ownerOrgUnitId: string | null;
}

/**
 * CD-70 — the customer's contract register, until the Legal module (CD-13)
 * owns contracts. A contract lands here when a contract request (the type
 * CRM settings name, CD-81) completes — its form gives the dates and value —
 * or is entered by hand for one made before the system. Renewals are raised
 * from `endOn` by `ContractRenewalService`.
 */
@Injectable()
export class ContractsService implements OnModuleInit {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly contracts: CustomerContractRepository,
    private readonly customers: CustomerRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly requests: RequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly events: DomainEventsService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.requestCompleted, (event) =>
      this.onRequestCompleted(
        event.payload as {
          request_id: string;
          type_code: string;
          company_id: string;
        },
      ).catch((error: Error) =>
        this.logger.warn(`contract from request: ${error.message}`),
      ),
    );
  }

  async list(customerId: string, actor: Principal) {
    await this.requireCustomer(customerId, actor);
    return this.contracts.findMany({
      // CD-161 — a confidential contract is not listed to everyone who can
      // read the customer.
      where: { customerId, ...contractVisibleWhere(actor) },
      orderBy: [{ status: 'asc' }, { endOn: 'asc' }],
    });
  }

  /** By hand — a contract made before the system, or one the request missed. */
  async create(customerId: string, dto: ContractInput, actor: Principal) {
    const customer = await this.requireCustomer(customerId, actor);
    const endOn = isoDay(dto.end_on);
    if (!dto.contract_no?.trim() || !dto.title?.trim() || !endOn) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุเลขที่สัญญา ชื่อสัญญา และวันสิ้นสุด',
        [{ field: 'contract', reason: 'required' }],
      );
    }
    const startOn = isoDay(dto.start_on);
    if (startOn && startOn > endOn) {
      throw new AppError(
        'VALIDATION_FAILED',
        'วันเริ่มต้องไม่อยู่หลังวันสิ้นสุด',
        [{ field: 'start_on', reason: 'after_end' }],
      );
    }
    await this.assertNumberFree(customer.companyId, dto.contract_no.trim());

    return this.transactions.execute(async (prisma) => {
      const row = (await this.contracts.create(
        {
          data: {
            companyId: customer.companyId,
            customerId,
            contractNo: dto.contract_no!.trim(),
            title: dto.title!.trim(),
            startOn: startOn ? asDate(startOn) : null,
            endOn: asDate(endOn),
            value: dto.value ?? null,
            note: dto.note?.trim() || null,
            ownerUserId: customer.accountOwnerUserId ?? actor.userId,
            ownerOrgUnitId: customer.ownerOrgUnitId ?? actor.orgUnitId,
            createdBy: actor.userId,
            updatedBy: actor.userId,
          },
        },
        { prisma },
      )) as { id: string; contractNo: string };
      await this.audit.record(
        {
          eventType: 'crm.contract.created',
          companyId: customer.companyId,
          ...auditActor(actor),
          resourceType: 'customer_contract',
          resourceId: row.id,
          after: {
            customerId,
            contractNo: row.contractNo,
            endOn,
            value: dto.value ?? null,
          },
        },
        { prisma },
      );
      await this.timeline.publish(
        {
          companyId: customer.companyId,
          customerId,
          refType: 'customer',
          refId: customerId,
          eventType: 'customer.contract_added',
          summary: `บันทึกสัญญา ${row.contractNo} · สิ้นสุด ${endOn}`,
          actorId: auditActor(actor).actorId,
          actorName: actor.displayName,
        },
        { prisma },
      );
      return row;
    });
  }

  /**
   * Edits the dates, value, title or note, or cancels it. A new end date
   * starts the renewal reminders over — they were counted from the old one.
   */
  async update(
    customerId: string,
    contractId: string,
    dto: ContractInput,
    actor: Principal,
  ) {
    const customer = await this.requireCustomer(customerId, actor);
    const before = (await this.contracts.findFirst({
      where: { id: contractId, customerId, ...contractVisibleWhere(actor) },
    })) as ({ endOn: Date; status: string } & Record<string, unknown>) | null;
    if (!before) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');

    const endOn = dto.end_on === undefined ? undefined : isoDay(dto.end_on);
    if (dto.end_on !== undefined && !endOn) {
      throw new AppError('VALIDATION_FAILED', 'วันสิ้นสุดไม่ถูกต้อง', [
        { field: 'end_on', reason: 'invalid' },
      ]);
    }
    const endChanged =
      endOn !== undefined && endOn !== before.endOn.toISOString().slice(0, 10);

    return this.transactions.execute(async (prisma) => {
      const row = await this.contracts.update(
        {
          where: { id: contractId },
          data: {
            ...(dto.title?.trim() ? { title: dto.title.trim() } : {}),
            ...(dto.start_on !== undefined
              ? {
                  startOn: isoDay(dto.start_on)
                    ? asDate(isoDay(dto.start_on)!)
                    : null,
                }
              : {}),
            ...(endOn ? { endOn: asDate(endOn) } : {}),
            ...(dto.value !== undefined ? { value: dto.value } : {}),
            ...(dto.note !== undefined
              ? { note: dto.note?.trim() || null }
              : {}),
            ...(dto.status ? { status: dto.status } : {}),
            ...(endChanged ? { remindedDays: [], status: 'active' } : {}),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'crm.contract.updated',
          companyId: customer.companyId,
          ...auditActor(actor),
          resourceType: 'customer_contract',
          resourceId: contractId,
          before: before as unknown as Prisma.InputJsonValue,
          after: dto as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
      return row;
    });
  }

  /**
   * A completed contract request becomes a contract when its form carries an
   * end date and it is about a customer (directly or through a deal that has
   * one). A prospect's deal has no customer yet — nothing to register.
   * Idempotent by request.
   */
  async onRequestCompleted(payload: {
    request_id: string;
    type_code: string;
    company_id: string;
  }): Promise<void> {
    const config = (await this.configs.findFirst({
      where: { companyId: payload.company_id },
      select: { contractRequestTypeCode: true },
    })) as { contractRequestTypeCode: string | null } | null;
    if (!config?.contractRequestTypeCode) return;
    if (payload.type_code !== config.contractRequestTypeCode) return;

    const request = (await this.requests.findFirst({
      where: { id: payload.request_id },
      select: {
        id: true,
        requestNo: true,
        companyId: true,
        refType: true,
        refId: true,
        requesterId: true,
        requesterOrgUnitId: true,
        formData: true,
      },
    })) as {
      id: string;
      requestNo: string | null;
      companyId: string;
      refType: string | null;
      refId: string | null;
      requesterId: string;
      requesterOrgUnitId: string | null;
      formData: unknown;
    } | null;
    if (!request?.refId) return;
    if (await this.contracts.findFirst({ where: { requestId: request.id } }))
      return;

    const form = (request.formData ?? {}) as Record<string, unknown>;
    const endOn = isoDay(form.end_date);
    if (!endOn) {
      this.logger.warn(
        `contract request ${request.id} has no end_date — not registered`,
      );
      return;
    }

    let customerId: string | null = null;
    let deal: DealRef | null = null;
    if (request.refType === 'customer') customerId = request.refId;
    if (request.refType === 'opportunity') {
      const found = (await this.opportunities.findFirst({
        where: {
          companyId: request.companyId,
          OR: [{ opportunityCode: request.refId }, { id: request.refId }],
        },
        select: {
          id: true,
          title: true,
          customerId: true,
          ownerUserId: true,
          ownerOrgUnitId: true,
        },
      })) as (DealRef & { customerId: string | null }) | null;
      customerId = found?.customerId ?? null;
      deal = found;
    }
    if (!customerId) return;

    const counterparty =
      typeof form.counterparty === 'string' ? form.counterparty.trim() : '';
    const value = Number(form.contract_value);
    const contractNo = request.requestNo ?? request.id;
    const startOn = isoDay(form.start_date);

    const row = (await this.contracts.create({
      data: {
        companyId: request.companyId,
        customerId,
        contractNo,
        title: deal?.title ?? (counterparty || contractNo),
        startOn: startOn ? asDate(startOn) : null,
        endOn: asDate(endOn),
        value: Number.isFinite(value) && value > 0 ? value : null,
        opportunityId: deal?.id ?? null,
        requestId: request.id,
        ownerUserId: deal?.ownerUserId ?? request.requesterId,
        ownerOrgUnitId: deal?.ownerOrgUnitId ?? request.requesterOrgUnitId,
        createdBy: null,
      },
    })) as { id: string };

    await this.audit.record({
      eventType: 'crm.contract.created',
      companyId: request.companyId,
      actorId: null,
      actorUsername: 'contract-request',
      resourceType: 'customer_contract',
      resourceId: row.id,
      after: { customerId, contractNo, endOn, requestId: request.id },
    });
    await this.timeline.publish({
      companyId: request.companyId,
      customerId,
      refType: 'request',
      refId: request.id,
      eventType: 'customer.contract_added',
      summary: `บันทึกสัญญา ${contractNo} จากคำขอที่ปิดแล้ว · สิ้นสุด ${endOn}`,
      actorId: null,
      actorName: 'ระบบ (คำขอสัญญา)',
    });
  }

  private async requireCustomer(id: string, actor: Principal) {
    const found = (await this.customers.findFirst({
      where: { id, AND: [visibleCustomersWhere(customerAccessSubject(actor))] },
      select: {
        id: true,
        companyId: true,
        accountOwnerUserId: true,
        ownerOrgUnitId: true,
      },
    })) as {
      id: string;
      companyId: string;
      accountOwnerUserId: string | null;
      ownerOrgUnitId: string | null;
    } | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุ');
    return found;
  }

  private async assertNumberFree(companyId: string, contractNo: string) {
    const taken = await this.contracts.findFirst({
      where: { companyId, contractNo },
      select: { id: true },
    });
    if (taken) {
      throw new AppError('CONFLICT', `เลขที่สัญญา ${contractNo} มีอยู่แล้ว`, [
        { field: 'contract_no', reason: 'taken' },
      ]);
    }
  }
}
