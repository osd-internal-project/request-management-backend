import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CustomerRepository } from '../crm/customer.repository';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { thaiToday } from '../crm/vendor-costs';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { SlaService } from '../sla/sla.service';
import { EntitlementsService } from './entitlements.service';
import {
  AttachWorkOrderDto,
  ConfirmBillingDto,
  CustomerAckDto,
  ListWorkOrdersQueryDto,
  OpenWorkOrderDto,
  WorkOrderOutcomeDto,
} from './support.dto';
import {
  ServiceAssetRepository,
  ServiceEntitlementRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';
import {
  ackProblems,
  closeBlocker,
  confirmProblems,
  startBlocker,
  suggestBilling,
  WorkKind,
} from './work-order-rules';

interface OrderRow {
  id: string;
  companyId: string;
  requestId: string;
  customerId: string | null;
  assetId: string | null;
  workKind: string;
  suggestedBilling: string;
  suggestedEntitlementId: string | null;
  suggestionNote: string | null;
  billing: string | null;
  entitlementId: string | null;
  billingReason: string | null;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  quotaTaken: string | null;
  ackName: string | null;
  ackOn: Date | null;
  ackEstimate: unknown;
  ackBy: string | null;
  cause: string | null;
  resolution: string | null;
  createdAt: Date;
}

const CLOSED = ['completed', 'closed', 'cancelled', 'rejected', 'approved'];
const STARTED = ['in_progress', 'on_hold', 'pending_approval', ...CLOSED];
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-239 ใบสั่งงานบริการ — a service job is a case on the request engine
 * (CD-67: owner, receiver, status, SLA clock, the customer channels of
 * CD-66), with its service side here: the asset, corrective or preventive,
 * and — decided before work starts — in contract or billed. The system
 * suggests from the asset's entitlements and quotas (CD-237); a person
 * confirms, a different answer says why; in contract takes one visit off the
 * quota (given back if the case is cancelled); a billed job needs the
 * customer's acknowledgement of the cost. The request engine is held at
 * "receive" until that is settled, and at "complete" until the cause and fix
 * are written.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` opens and decides;
 * whoever works the case (its assignee) may also write the cause and fix.
 */
@Injectable()
export class WorkOrdersService implements OnModuleInit {
  private readonly logger = new Logger(WorkOrdersService.name);

  constructor(
    private readonly orders: ServiceWorkOrderRepository,
    private readonly assets: ServiceAssetRepository,
    private readonly entitlementRows: ServiceEntitlementRepository,
    private readonly customers: CustomerRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly entitlements: EntitlementsService,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
    private readonly sla: SlaService,
  ) {}

  onModuleInit(): void {
    this.requests.addGuard('receive', (request) => this.guardStart(request.id));
    this.requests.addGuard('complete', (request) =>
      this.guardClose(request.id),
    );
    this.events.on(DOMAIN_EVENTS.requestCancelled, (event) => {
      const payload = event.payload as { request_id?: string };
      if (!payload.request_id) return Promise.resolve();
      return this.giveBack(payload.request_id).catch((error: Error) =>
        this.logger.warn(`quota not given back: ${error.message}`),
      );
    });
  }

  /** Held at receive: the in-contract/billed decision, and a billed job's consent. */
  async guardStart(requestId: string) {
    const order = await this.byRequestId(requestId);
    if (!order) return;
    const blocker = startBlocker(order);
    if (blocker) throw new AppError('CONFLICT', blocker);
  }

  /** Held at complete: the cause and the fix. */
  async guardClose(requestId: string) {
    const order = await this.byRequestId(requestId);
    if (!order) return;
    const blocker = closeBlocker(order);
    if (blocker) throw new AppError('CONFLICT', blocker);
  }

  /** A new job: the case raised and sent, its service side suggested. */
  async open(actor: Principal, dto: OpenWorkOrderDto, authorization: string) {
    const companyId = actor.activeCompanyId;
    const typeCode = await this.typeCode(companyId);
    if (!typeCode) {
      throw new AppError(
        'CONFLICT',
        'ยังไม่ได้ตั้งประเภทคำขอใบสั่งงานบริการในหน้าตั้งค่า CRM',
      );
    }
    const customer = await this.requireCustomer(companyId, dto.customer_id);
    const asset = dto.asset_id
      ? await this.requireAsset(companyId, dto.asset_id, customer.id)
      : null;
    const created = (await this.requests.create(
      {
        type_code: typeCode,
        severity: dto.severity as never,
        ref_type: 'customer',
        ref_id: customer.customerCode,
        form_data: {
          subject: dto.subject.trim(),
          detail: [
            dto.detail?.trim() ?? '',
            asset
              ? `อุปกรณ์: ${[asset.name, asset.serialNo, asset.location].filter(Boolean).join(' · ')}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          customer_code: customer.customerCode,
          work_kind: dto.work_kind,
        },
      },
      actor,
    )) as { id: string };
    await this.requests.submit(created.id, actor, authorization);
    const id = await this.make(
      actor,
      created.id,
      customer.id,
      asset?.id ?? null,
      dto.work_kind as WorkKind,
    );
    return this.detail(actor, id);
  }

  /** A case already raised (LINE, web form) made a service job. */
  async attach(actor: Principal, requestId: string, dto: AttachWorkOrderDto) {
    const companyId = actor.activeCompanyId;
    const request = (await this.requestRows.findFirst({
      where: { id: requestId, companyId },
      select: { id: true, status: true, refType: true, refId: true },
    })) as {
      id: string;
      status: string;
      refType: string | null;
      refId: string | null;
    } | null;
    if (!request) throw new AppError('NOT_FOUND', 'ไม่พบคำขอ');
    if (STARTED.includes(request.status)) {
      throw new AppError(
        'CONFLICT',
        'ผูกเป็นใบสั่งงานบริการได้เฉพาะคำขอที่ยังไม่เริ่มงาน',
      );
    }
    if (await this.orders.count({ where: { requestId } })) {
      throw new AppError('CONFLICT', 'คำขอนี้เป็นใบสั่งงานบริการแล้ว');
    }
    // the customer named, or the one the case already points at
    let customerId = dto.customer_id ?? null;
    if (!customerId && request.refType === 'customer' && request.refId) {
      const found = (await this.customers.findFirst({
        where: {
          companyId,
          OR: [{ id: request.refId }, { customerCode: request.refId }],
        },
        select: { id: true },
      })) as { id: string } | null;
      customerId = found?.id ?? null;
    }
    if (!customerId) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุลูกค้า', [
        { field: 'customer_id', reason: 'required' },
      ]);
    }
    const customer = await this.requireCustomer(companyId, customerId);
    const asset = dto.asset_id
      ? await this.requireAsset(companyId, dto.asset_id, customer.id)
      : null;
    const id = await this.make(
      actor,
      requestId,
      customer.id,
      asset?.id ?? null,
      dto.work_kind as WorkKind,
    );
    return this.detail(actor, id);
  }

  /**
   * In contract or billed, by a person: a different answer from the
   * suggestion says why; in contract takes one visit off the cover's quota
   * (and gives back what an earlier answer took). Before work starts only.
   */
  async confirm(actor: Principal, id: string, dto: ConfirmBillingDto) {
    const companyId = actor.activeCompanyId;
    const order = await this.requireOrder(companyId, id);
    await this.assertNotStarted(order.requestId);
    const entitlementId =
      dto.billing === 'in_contract'
        ? (dto.entitlement_id ?? order.suggestedEntitlementId)
        : null;
    const reason = dto.reason?.trim() ?? '';
    const problems = confirmProblems({
      billing: dto.billing,
      suggested: order.suggestedBilling,
      reason,
      entitlementId,
    });
    if (entitlementId) {
      if (!order.assetId) {
        problems.push('อยู่ในสัญญา ต้องระบุอุปกรณ์ที่สิทธิ์ครอบคลุม');
      } else {
        const cover = await this.entitlements.coverageOf(
          companyId,
          order.assetId,
        );
        if (!cover.some((row) => row.id === entitlementId)) {
          problems.push('สิทธิ์นี้ไม่ได้ครอบคลุมอุปกรณ์นี้ในวันนี้');
        }
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((why) => ({ field: 'billing', reason: why })),
      );
    }
    const kind = order.workKind as WorkKind;
    await this.transactions.execute(async (prisma) => {
      await this.release(prisma, order);
      if (entitlementId) {
        await prisma.serviceEntitlement.update({
          where: { id: entitlementId },
          data:
            kind === 'corrective'
              ? { correctiveUsed: { increment: 1 } }
              : { preventiveUsed: { increment: 1 } },
        });
      }
      await prisma.serviceWorkOrder.update({
        where: { id },
        data: {
          billing: dto.billing,
          entitlementId,
          billingReason: reason || null,
          confirmedBy: actor.userId,
          confirmedAt: new Date(),
          quotaTaken: entitlementId ? kind : null,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.work_order.confirmed',
          companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: order.requestId,
          after: {
            billing: dto.billing,
            suggested: order.suggestedBilling,
            entitlementId,
            reason: reason || null,
          },
        },
        { prisma },
      );
      // CD-240 — the confirmed cover's levels (or the type's, when billed)
      await this.sla.retarget(prisma, order.requestId);
    });
    return this.detail(actor, id);
  }

  /** A billed job: the customer agreed to the cost. */
  async acknowledge(actor: Principal, id: string, dto: CustomerAckDto) {
    const companyId = actor.activeCompanyId;
    const order = await this.requireOrder(companyId, id);
    if (order.billing !== 'billable') {
      throw new AppError(
        'CONFLICT',
        'บันทึกการยินยอมได้เฉพาะงานที่ยืนยันว่าเก็บเงินเพิ่ม',
      );
    }
    const estimate =
      dto.estimate === undefined || dto.estimate === null ? null : dto.estimate;
    const problems = ackProblems({
      name: dto.name,
      on: dto.on,
      estimate,
      today: thaiToday(),
    });
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((why) => ({ field: 'ack', reason: why })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceWorkOrder.update({
        where: { id },
        data: {
          ackName: dto.name.trim(),
          ackOn: new Date(`${dto.on}T00:00:00Z`),
          ackEstimate: estimate,
          ackBy: actor.userId,
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.work_order.customer_ack',
          companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: order.requestId,
          after: { name: dto.name.trim(), on: dto.on, estimate },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  /** The cause and the fix — the service team, or whoever works the case. */
  async outcome(actor: Principal, id: string, dto: WorkOrderOutcomeDto) {
    const companyId = actor.activeCompanyId;
    const order = await this.requireOrder(companyId, id);
    if (!actor.permissions.includes('service.asset.manage')) {
      const request = (await this.requestRows.findFirst({
        where: { id: order.requestId },
        select: { assigneeUserId: true },
      })) as { assigneeUserId: string | null } | null;
      if (request?.assigneeUserId !== actor.userId) {
        throw new AppError(
          'FORBIDDEN',
          'บันทึกสาเหตุและวิธีแก้ได้เฉพาะผู้รับผิดชอบงาน หรือทีมบริการ',
        );
      }
    }
    await this.orders.update({
      where: { id },
      data: {
        ...(dto.cause !== undefined ? { cause: dto.cause.trim() || null } : {}),
        ...(dto.resolution !== undefined
          ? { resolution: dto.resolution.trim() || null }
          : {}),
        updatedBy: actor.userId,
      },
    });
    return this.detail(actor, id);
  }

  async detail(actor: Principal, id: string) {
    const order = await this.requireOrder(actor.activeCompanyId, id);
    const [view] = await this.views(actor.activeCompanyId, [order]);
    const cover = order.assetId
      ? await this.entitlements.coverageOf(actor.activeCompanyId, order.assetId)
      : [];
    return { ...view, cover };
  }

  /** The service side of a case, if it has one (the request page asks). */
  async ofRequest(actor: Principal, requestId: string) {
    const order = (await this.orders.findFirst({
      where: { requestId, companyId: actor.activeCompanyId },
      select: { id: true },
    })) as { id: string } | null;
    return order ? this.detail(actor, order.id) : null;
  }

  async list(actor: Principal, query: ListWorkOrdersQueryDto) {
    const companyId = actor.activeCompanyId;
    const rows = (await this.orders.findMany({
      where: {
        companyId,
        ...(query.customer_id ? { customerId: query.customer_id } : {}),
        ...(query.asset_id ? { assetId: query.asset_id } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    })) as OrderRow[];
    const views = await this.views(companyId, rows);
    return query.state === 'all'
      ? views
      : views.filter((row) => !CLOSED.includes(row.request?.status ?? ''));
  }

  // --- helpers -----------------------------------------------------------------------

  private async make(
    actor: Principal,
    requestId: string,
    customerId: string,
    assetId: string | null,
    kind: WorkKind,
  ) {
    const companyId = actor.activeCompanyId;
    const cover = assetId
      ? await this.entitlements.coverageOf(companyId, assetId)
      : [];
    const suggestion = suggestBilling(cover, kind);
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceWorkOrder.create({
        data: {
          companyId,
          requestId,
          customerId,
          assetId,
          workKind: kind,
          suggestedBilling: suggestion.billing,
          suggestedEntitlementId: suggestion.entitlementId,
          suggestionNote: assetId
            ? suggestion.note
            : 'ไม่ได้ระบุอุปกรณ์ — ตรวจสิทธิ์ไม่ได้',
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'service.work_order.opened',
          companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: requestId,
          after: {
            workOrderId: created.id,
            assetId,
            workKind: kind,
            suggested: suggestion.billing,
          },
        },
        { prisma },
      );
      // CD-240 — the clock began on the type's levels; the cover's apply now
      await this.sla.retarget(prisma, requestId);
      return created;
    });
    return row.id;
  }

  /** Whatever visit an earlier answer took, back to its cover. */
  private async release(prisma: Prisma.TransactionClient, order: OrderRow) {
    if (!order.entitlementId || !order.quotaTaken) return;
    await prisma.serviceEntitlement.updateMany({
      where:
        order.quotaTaken === 'corrective'
          ? { id: order.entitlementId, correctiveUsed: { gt: 0 } }
          : { id: order.entitlementId, preventiveUsed: { gt: 0 } },
      data:
        order.quotaTaken === 'corrective'
          ? { correctiveUsed: { decrement: 1 } }
          : { preventiveUsed: { decrement: 1 } },
    });
  }

  /** A cancelled case gives its visit back. */
  async giveBack(requestId: string) {
    const order = await this.byRequestId(requestId);
    if (!order?.quotaTaken) return;
    await this.transactions.execute(async (prisma) => {
      const tx = prisma;
      await this.release(tx, order);
      await tx.serviceWorkOrder.update({
        where: { id: order.id },
        data: { quotaTaken: null },
      });
    });
  }

  private async views(companyId: string, rows: OrderRow[]) {
    const requestIds = rows.map((row) => row.requestId);
    const assetIds = rows.flatMap((row) => row.assetId ?? []);
    const customerIds = rows.flatMap((row) => row.customerId ?? []);
    const entitlementIds = rows.flatMap((row) =>
      [row.entitlementId, row.suggestedEntitlementId].filter(
        (value): value is string => Boolean(value),
      ),
    );
    const [requests, assets, customers, covers] = await Promise.all([
      requestIds.length
        ? (this.requestRows.findMany({
            where: { id: { in: requestIds } },
            select: {
              id: true,
              requestNo: true,
              status: true,
              severity: true,
              formData: true,
              assigneeUserId: true,
            },
          }) as Promise<
            {
              id: string;
              requestNo: string | null;
              status: string;
              severity: string | null;
              formData: unknown;
              assigneeUserId: string | null;
            }[]
          >)
        : Promise.resolve([]),
      assetIds.length
        ? (this.assets.findMany({
            where: { id: { in: assetIds } },
            select: { id: true, name: true, serialNo: true, location: true },
          }) as Promise<
            {
              id: string;
              name: string;
              serialNo: string | null;
              location: string | null;
            }[]
          >)
        : Promise.resolve([]),
      customerIds.length
        ? (this.customers.findMany({
            where: { id: { in: customerIds } },
            select: { id: true, customerCode: true, nameTh: true },
          }) as Promise<{ id: string; customerCode: string; nameTh: string }[]>)
        : Promise.resolve([]),
      entitlementIds.length
        ? this.entitlementTitles(companyId, entitlementIds)
        : Promise.resolve(new Map<string, string>()),
    ]);
    const request = new Map(requests.map((row) => [row.id, row]));
    const asset = new Map(assets.map((row) => [row.id, row]));
    const customer = new Map(customers.map((row) => [row.id, row]));
    return rows.map((row) => {
      const req = request.get(row.requestId);
      const form = (req?.formData ?? {}) as { subject?: unknown };
      return {
        id: row.id,
        requestId: row.requestId,
        request: req
          ? {
              requestNo: req.requestNo,
              status: req.status,
              severity: req.severity,
              subject: typeof form.subject === 'string' ? form.subject : null,
            }
          : null,
        customer: row.customerId
          ? (() => {
              const c = customer.get(row.customerId);
              return c
                ? { id: c.id, code: c.customerCode, name: c.nameTh }
                : null;
            })()
          : null,
        asset: row.assetId ? (asset.get(row.assetId) ?? null) : null,
        workKind: row.workKind,
        suggestedBilling: row.suggestedBilling,
        suggestedEntitlement: row.suggestedEntitlementId
          ? {
              id: row.suggestedEntitlementId,
              title: covers.get(row.suggestedEntitlementId) ?? null,
            }
          : null,
        suggestionNote: row.suggestionNote,
        billing: row.billing,
        entitlement: row.entitlementId
          ? {
              id: row.entitlementId,
              title: covers.get(row.entitlementId) ?? null,
            }
          : null,
        billingReason: row.billingReason,
        confirmedAt: row.confirmedAt,
        ack: row.ackOn
          ? {
              name: row.ackName,
              on: day(row.ackOn),
              estimate:
                row.ackEstimate === null ? null : Number(row.ackEstimate),
            }
          : null,
        cause: row.cause,
        resolution: row.resolution,
        startBlocker: startBlocker(row),
        closeBlocker: closeBlocker(row),
        createdAt: row.createdAt,
      };
    });
  }

  private async entitlementTitles(companyId: string, ids: string[]) {
    const rows = (await this.entitlementRows.findMany({
      where: { companyId, id: { in: [...new Set(ids)] } },
      select: { id: true, title: true },
    })) as { id: string; title: string }[];
    return new Map(rows.map((row) => [row.id, row.title]));
  }

  private async assertNotStarted(requestId: string) {
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { status: true },
    })) as { status: string } | null;
    if (request && STARTED.includes(request.status)) {
      throw new AppError(
        'CONFLICT',
        'เริ่มงานแล้ว เปลี่ยนการตัดสินอยู่ในสัญญา/เก็บเงินไม่ได้',
      );
    }
  }

  private async typeCode(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: { serviceWorkOrderTypeCode: true },
    })) as { serviceWorkOrderTypeCode: string | null } | null;
    return row?.serviceWorkOrderTypeCode ?? null;
  }

  private async byRequestId(requestId: string) {
    return (await this.orders.findFirst({
      where: { requestId },
    })) as OrderRow | null;
  }

  private async requireOrder(companyId: string, id: string) {
    const row = (await this.orders.findFirst({
      where: { id, companyId },
    })) as OrderRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    return row;
  }

  private async requireCustomer(companyId: string, id: string) {
    const row = (await this.customers.findFirst({
      where: { id, companyId },
      select: { id: true, customerCode: true },
    })) as { id: string; customerCode: string } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบลูกค้า');
    return row;
  }

  private async requireAsset(
    companyId: string,
    id: string,
    customerId: string,
  ) {
    const row = (await this.assets.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        customerId: true,
        name: true,
        serialNo: true,
        location: true,
      },
    })) as {
      id: string;
      customerId: string | null;
      name: string;
      serialNo: string | null;
      location: string | null;
    } | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบอุปกรณ์');
    if (row.customerId !== customerId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'อุปกรณ์นี้ไม่ใช่ของลูกค้ารายนี้',
      );
    }
    return row;
  }
}
