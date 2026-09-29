import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  customerAccessSubject,
  PrismaTransactionService,
  visibleCustomersWhere,
  type Principal,
} from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import {
  DOMAIN_EVENTS,
  type DomainEventName,
  type RequestEventPayload,
} from '../events/event-catalog';
import { RequestRepository } from '../requests/request.repository';
import { RequestTypeRepository } from '../requests/request-type.repository';
import { RequestsService } from '../requests/requests.service';
import {
  approvalTypeFor,
  CUSTOMER_TYPE_LABELS,
  readApprovalTypes,
  type CustomerTypeKey,
} from './customer-approval';
import { CustomerErpSyncService } from './customer-erp-sync.service';
import { CustomerRepository } from './customer.repository';
import { CustomerTimelineService } from './customer-timeline.service';
import { SaleOrderErpSyncService } from './sale-order-erp-sync.service';
import { SaleOrderRepository } from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';

type Outcome = 'approved' | 'rejected';

/** Request statuses after which a request no longer counts as "in flight". */
const FINISHED = ['rejected', 'closed', 'cancelled', 'approved'];

export interface NewCustomer {
  id: string;
  companyId: string;
  customerCode: string;
  nameTh: string;
  taxId: string | null;
  type: string;
}

/**
 * CD-62 — อนุมัติเปิดลูกค้าใหม่ (user decisions 29 ก.ย. 2569):
 *
 * - a customer created after the company configured an approval type for its
 *   customer type starts `pending`; customers from before, and imported ones,
 *   are `approved` (the column's default);
 * - a draft approval request (Platform Request, `ref_type=customer`) is
 *   raised for whoever created it — the type's required documents are
 *   attached there, which is why it is a draft and not submitted for them;
 * - until it is approved, neither the customer nor its sale orders go to SAP
 *   (the gates are in the two ERP sync services); on approval both are sent;
 *   a rejected or cancelled request leaves the customer `rejected`, and a new
 *   request may be raised from the customer page;
 * - KYC stays a warning by product (PO 8 ก.ย.), and quotations for a prospect
 *   are not held — the customer only exists once a sale order opens (PO
 *   10 ก.ย.).
 *
 * Matched by `Customer.approvalRequestId`, never by type code.
 */
@Injectable()
export class CustomerApprovalService implements OnModuleInit {
  private readonly logger = new Logger(CustomerApprovalService.name);

  constructor(
    private readonly customers: CustomerRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requestTypes: RequestTypeRepository,
    private readonly requests: RequestsService,
    private readonly saleOrders: SaleOrderRepository,
    private readonly customerSync: CustomerErpSyncService,
    private readonly orderSync: SaleOrderErpSyncService,
    private readonly events: DomainEventsService,
    private readonly timeline: CustomerTimelineService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    const outcomes: [DomainEventName, Outcome][] = [
      [DOMAIN_EVENTS.requestApproved, 'approved'],
      [DOMAIN_EVENTS.requestPreApproved, 'approved'],
      [DOMAIN_EVENTS.requestRejected, 'rejected'],
      [DOMAIN_EVENTS.requestCancelled, 'rejected'],
    ];
    for (const [name, outcome] of outcomes) {
      this.events.on(name, (event) =>
        this.onRequestOutcome(
          event.payload as RequestEventPayload,
          outcome,
        ).catch((error: Error) =>
          this.logger.warn(`customer approval outcome: ${error.message}`),
        ),
      );
    }
  }

  /** The type a new customer of this kind needs, or null (no approval). */
  async typeFor(companyId: string, customerType: string) {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { customerApprovalTypes: true },
    })) as { customerApprovalTypes: unknown } | null;
    return approvalTypeFor(config?.customerApprovalTypes, customerType);
  }

  /**
   * CRM settings: every code named must be a request type this company can
   * raise — a code that is not would leave each new customer of that type
   * pending with no way to ask. Returns the cleaned map to store.
   */
  async assertUsableTypes(companyId: string, value: unknown) {
    const types = readApprovalTypes(value);
    const codes = [...new Set(Object.values(types))];
    if (!codes.length) return types;
    const found = (await this.requestTypes.findMany({
      where: {
        code: { in: codes },
        active: true,
        companies: { some: { companyId, active: true } },
      },
      select: { code: true },
    })) as { code: string }[];
    const known = new Set(found.map((type) => type.code));
    const missing = codes.filter((code) => !known.has(code));
    if (missing.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        `ไม่พบประเภทคำขอที่ใช้ได้ในบริษัทนี้: ${missing.join(', ')}`,
        missing.map((code) => ({
          field: 'customer_approval_types',
          reason: code,
        })),
      );
    }
    return types;
  }

  /**
   * Right after a pending customer is created: raise the draft request.
   * Never throws — the customer is saved; without a request the page offers
   * "ยื่นขออนุมัติ" instead.
   */
  async raiseFor(customer: NewCustomer, typeCode: string, actor: Principal) {
    try {
      return await this.raise(customer, typeCode, actor);
    } catch (error) {
      this.logger.warn(
        `approval request for customer ${customer.customerCode} not raised: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /** The customer page's view: status, the request, and whether one may be raised. */
  async view(customerId: string, actor: Principal) {
    const customer = await this.requireVisible(customerId, actor);
    const request = customer.approvalRequestId
      ? ((await this.requestRows.findFirst({
          where: { id: customer.approvalRequestId },
          select: { id: true, requestNo: true, status: true, typeCode: true },
        })) as {
          id: string;
          requestNo: string | null;
          status: string;
          typeCode: string;
        } | null)
      : null;
    const typeCode = await this.typeFor(customer.companyId, customer.type);
    return {
      status: customer.approvalStatus,
      request,
      type_code: typeCode,
      can_raise:
        customer.approvalStatus !== 'approved' &&
        Boolean(typeCode) &&
        (!request || FINISHED.includes(request.status)),
    };
  }

  /** "ยื่นขออนุมัติ" — a new draft when there is none in flight. */
  async raiseFromPage(customerId: string, actor: Principal) {
    const customer = await this.requireVisible(customerId, actor);
    if (customer.approvalStatus === 'approved') {
      throw new AppError('CONFLICT', 'ลูกค้ารายนี้อนุมัติแล้ว');
    }
    const typeCode = await this.typeFor(customer.companyId, customer.type);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขออนุมัติเปิดลูกค้าสำหรับลูกค้าประเภทนี้ในหน้าตั้งค่า CRM',
      );
    }
    const current = await this.view(customerId, actor);
    if (!current.can_raise) {
      throw new AppError(
        'CONFLICT',
        'มีคำขออนุมัติที่ยังดำเนินการอยู่แล้ว — เปิดคำขอนั้นแทน',
      );
    }
    await this.raise(customer, typeCode, actor);
    return this.view(customerId, actor);
  }

  async onRequestOutcome(
    payload: RequestEventPayload,
    outcome: Outcome,
  ): Promise<void> {
    const customer = (await this.customers.findFirst({
      where: {
        approvalRequestId: payload.request_id,
        approvalStatus: 'pending',
      },
      select: {
        id: true,
        companyId: true,
        customerCode: true,
        nameTh: true,
      },
    })) as {
      id: string;
      companyId: string;
      customerCode: string;
      nameTh: string;
    } | null;
    if (!customer) return;

    const approved = outcome === 'approved';
    const moved = await this.transactions.execute(async (prisma) => {
      const updated = await this.customers.updateMany(
        {
          where: {
            id: customer.id,
            approvalRequestId: payload.request_id,
            approvalStatus: 'pending',
          },
          data: { approvalStatus: outcome },
        },
        { prisma },
      );
      if (updated.count !== 1) return false;

      await this.audit.record(
        {
          eventType: approved
            ? 'crm.customer.approved'
            : 'crm.customer.approval_rejected',
          companyId: customer.companyId,
          actorId: null,
          actorUsername: 'customer-approval-sync',
          resourceType: 'customer',
          resourceId: customer.id,
          before: { approvalStatus: 'pending' },
          after: {
            approvalStatus: outcome,
            requestId: payload.request_id,
            requestNo: payload.request_no,
          },
        },
        { prisma },
      );
      await this.timeline.publish(
        {
          companyId: customer.companyId,
          customerId: customer.id,
          refType: 'request',
          refId: payload.request_id,
          eventType: approved
            ? 'customer.approved'
            : 'customer.approval_rejected',
          summary: approved
            ? `อนุมัติเปิดลูกค้าแล้ว (${payload.request_no ?? 'คำขอ'}) — ส่งเข้า SAP`
            : `ไม่อนุมัติเปิดลูกค้า (${payload.request_no ?? 'คำขอ'}) — ยังไม่ส่งเข้า SAP`,
          actorId: null,
          actorName: 'ระบบ (อนุมัติเปิดลูกค้า)',
        },
        { prisma },
      );
      return true;
    });
    if (!moved || !approved) return;

    // After the commit, as every SAP push is: the customer, then its orders
    // (each order also waits on the customer's BP number by itself).
    this.customerSync.kickCustomer(customer.id);
    const orders = (await this.saleOrders.findMany({
      where: { customerId: customer.id, status: 'open', erpOrderNo: null },
      select: { id: true },
    })) as { id: string }[];
    for (const order of orders) this.orderSync.kickCreate(order.id);
    this.logger.log(
      `CD-62: customer ${customer.customerCode} approved — SAP push started with ${orders.length} sale order(s)`,
    );
  }

  private async raise(
    customer: NewCustomer,
    typeCode: string,
    actor: Principal,
  ) {
    const created = (await this.requests.create(
      {
        type_code: typeCode,
        ref_type: 'customer',
        ref_id: customer.id,
        // Named for the seeded NCA-* forms; a company's own type ignores keys
        // its form does not have.
        form_data: {
          customer_code: customer.customerCode,
          customer_name: customer.nameTh,
          customer_type:
            CUSTOMER_TYPE_LABELS[customer.type as CustomerTypeKey] ??
            customer.type,
          ...(customer.taxId ? { tax_id: customer.taxId } : {}),
        },
      },
      actor,
    )) as { id: string; requestNo: string | null };

    await this.transactions.execute(async (prisma) => {
      await this.customers.update(
        {
          where: { id: customer.id },
          data: {
            approvalStatus: 'pending',
            approvalRequestId: created.id,
          },
        },
        { prisma },
      );
      await this.audit.record(
        {
          eventType: 'crm.customer.approval_requested',
          companyId: customer.companyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: customer.id,
          after: { requestId: created.id, typeCode },
        },
        { prisma },
      );
    });
    return created;
  }

  private async requireVisible(id: string, actor: Principal) {
    const found = (await this.customers.findFirst({
      where: {
        id,
        mergedIntoCustomerId: null,
        AND: [visibleCustomersWhere(customerAccessSubject(actor))],
      },
      select: {
        id: true,
        companyId: true,
        customerCode: true,
        nameTh: true,
        taxId: true,
        type: true,
        approvalStatus: true,
        approvalRequestId: true,
      },
    })) as
      | (NewCustomer & {
          approvalStatus: 'approved' | 'pending' | 'rejected';
          approvalRequestId: string | null;
        })
      | null;
    // SCOPE-03: out of reach answers 404.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุ');
    return found;
  }
}
