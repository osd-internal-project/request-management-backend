import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { thaiToday } from '../crm/vendor-costs';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { DecideExtraWorkDto, ProposeExtraWorkDto } from './support.dto';
import {
  decideBlocker,
  extrasCloseBlocker,
  MAX_EXTRAS_PER_JOB,
  proposalProblems,
} from './extra-work-rules';
import {
  ServiceExtraWorkRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';
import { ackProblems } from './work-order-rules';

interface ExtraRow {
  id: string;
  companyId: string;
  workOrderId: string;
  seq: number;
  description: string;
  reason: string;
  estimate: Prisma.Decimal;
  status: string;
  ackName: string | null;
  ackOn: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  declineNote: string | null;
  createdAt: Date;
  createdBy: string;
}

interface OrderRow {
  id: string;
  companyId: string;
  requestId: string;
  billing: string | null;
}

/** A job is under way: received and not yet done. */
const WORKING = ['in_progress', 'on_hold'];

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-228 บำรุงรักษาและสนับสนุน (CD-19 Engineer) — maintenance runs on the
 * contract's entitlements and service levels already (CD-239/240/244); what
 * this adds is the work found outside the contract once the job started:
 * whoever works it proposes the item with why and an estimate, the customer
 * agrees (who, when) or declines. Agreed items go on the job's charge
 * (CD-242) even when the job itself is in contract; declined ones stay on
 * the record, uncharged. The job cannot be reported done while an item waits
 * for the customer.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` or the case's
 * assignee proposes, records the customer's answer, or withdraws.
 */
@Injectable()
export class ExtraWorksService implements OnModuleInit {
  constructor(
    private readonly extras: ServiceExtraWorkRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  onModuleInit(): void {
    this.requests.addGuard('complete', (request) =>
      this.guardClose(request.id),
    );
  }

  /** Held at complete: nothing still waiting for the customer. */
  async guardClose(requestId: string) {
    const order = (await this.orders.findFirst({
      where: { requestId },
      select: { id: true },
    })) as { id: string } | null;
    if (!order) return;
    const rows = (await this.extras.findMany({
      where: { workOrderId: order.id },
      select: { seq: true, status: true },
    })) as { seq: number; status: string }[];
    const blocker = extrasCloseBlocker(rows);
    if (blocker) throw new AppError('CONFLICT', blocker);
  }

  async list(actor: Principal, workOrderId: string) {
    const order = await this.requireOrder(actor.activeCompanyId, workOrderId);
    const rows = (await this.extras.findMany({
      where: { workOrderId },
      orderBy: { seq: 'asc' },
    })) as ExtraRow[];
    const names = await this.displayNames(
      rows.flatMap((row) => [row.createdBy, row.decidedBy]),
    );
    const status = await this.requestStatus(order.requestId);
    const mayWork = await this.mayWork(actor, order);
    return {
      canPropose: mayWork && WORKING.includes(status),
      canDecide: mayWork,
      agreedTotal: rows
        .filter((row) => row.status === 'agreed')
        .reduce((sum, row) => sum + Number(row.estimate), 0),
      items: rows.map((row) => ({
        id: row.id,
        label: `X-${row.seq}`,
        description: row.description,
        reason: row.reason,
        estimate: Number(row.estimate),
        status: row.status,
        ackName: row.ackName,
        ackOn: day(row.ackOn),
        declineNote: row.declineNote,
        decidedByName: row.decidedBy
          ? (names.get(row.decidedBy) ?? null)
          : null,
        decidedAt: row.decidedAt,
        createdByName: names.get(row.createdBy) ?? null,
        createdAt: row.createdAt,
      })),
    };
  }

  async propose(
    actor: Principal,
    workOrderId: string,
    dto: ProposeExtraWorkDto,
  ) {
    const order = await this.requireOrder(actor.activeCompanyId, workOrderId);
    await this.assertWorker(actor, order);
    if (!WORKING.includes(await this.requestStatus(order.requestId))) {
      throw new AppError(
        'CONFLICT',
        'เสนองานนอกสัญญาได้ระหว่างที่งานกำลังดำเนินอยู่เท่านั้น',
      );
    }
    const input = {
      description: dto.description.trim(),
      reason: dto.reason.trim(),
      estimate: dto.estimate,
    };
    const problems = proposalProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'extra', reason })),
      );
    }
    await this.transactions.execute(async (prisma) => {
      const count = await this.extras.count(
        { where: { workOrderId } },
        { prisma },
      );
      if (count >= MAX_EXTRAS_PER_JOB) {
        throw new AppError(
          'CONFLICT',
          `งานนอกสัญญาไม่เกิน ${MAX_EXTRAS_PER_JOB} รายการต่องาน`,
        );
      }
      const last = (await this.extras.findFirst(
        {
          where: { workOrderId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        },
        { prisma },
      )) as { seq: number } | null;
      const row = (await this.extras.create(
        {
          data: {
            companyId: order.companyId,
            workOrderId,
            seq: (last?.seq ?? 0) + 1,
            ...input,
            createdBy: actor.userId,
          },
          select: { id: true, seq: true },
        },
        { prisma },
      )) as { id: string; seq: number };
      await this.audit.record(
        {
          eventType: 'service.extra_work.proposed',
          companyId: order.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: order.requestId,
          after: { label: `X-${row.seq}`, ...input },
        },
        { prisma },
      );
    });
    return this.list(actor, workOrderId);
  }

  /** The customer agreed (who, when) or declined. */
  async decide(actor: Principal, id: string, dto: DecideExtraWorkDto) {
    const row = await this.requireExtra(actor.activeCompanyId, id);
    const order = await this.requireOrder(row.companyId, row.workOrderId);
    await this.assertWorker(actor, order);
    const blocked = decideBlocker(row.status);
    if (blocked) throw new AppError('CONFLICT', blocked);
    const agreed = dto.decision === 'agreed';
    if (agreed) {
      const problems = ackProblems({
        name: dto.name ?? '',
        on: dto.on ?? '',
        estimate: null,
        today: thaiToday(),
      });
      if (problems.length) {
        throw new AppError(
          'VALIDATION_FAILED',
          problems[0],
          problems.map((reason) => ({ field: 'ack', reason })),
        );
      }
    }
    await this.settle(actor, row, order, {
      status: dto.decision,
      ackName: agreed ? dto.name!.trim() : dto.name?.trim() || null,
      ackOn: agreed ? new Date(`${dto.on}T00:00:00Z`) : null,
      declineNote: agreed ? null : dto.note?.trim() || null,
    });
    return this.list(actor, row.workOrderId);
  }

  /** Withdrawn before the customer answered — proposed in error. */
  async cancel(actor: Principal, id: string) {
    const row = await this.requireExtra(actor.activeCompanyId, id);
    const order = await this.requireOrder(row.companyId, row.workOrderId);
    await this.assertWorker(actor, order);
    const blocked = decideBlocker(row.status);
    if (blocked) throw new AppError('CONFLICT', blocked);
    await this.settle(actor, row, order, { status: 'cancelled' });
    return this.list(actor, row.workOrderId);
  }

  /** What the customer agreed to on a job — for its charge (CD-242). */
  async agreedOf(workOrderId: string) {
    return (
      (await this.extras.findMany({
        where: { workOrderId, status: 'agreed' },
        orderBy: { seq: 'asc' },
        select: { seq: true, description: true, estimate: true, status: true },
      })) as {
        seq: number;
        description: string;
        estimate: Prisma.Decimal;
        status: string;
      }[]
    ).map((row) => ({ ...row, estimate: Number(row.estimate) }));
  }

  // --- helpers -------------------------------------------------------------------

  private async settle(
    actor: Principal,
    row: ExtraRow,
    order: OrderRow,
    data: {
      status: 'agreed' | 'declined' | 'cancelled';
      ackName?: string | null;
      ackOn?: Date | null;
      declineNote?: string | null;
    },
  ) {
    await this.transactions.execute(async (prisma) => {
      const claimed = await this.extras.updateMany(
        {
          where: { id: row.id, status: 'proposed' },
          data: {
            ...data,
            decidedBy: actor.userId,
            decidedAt: new Date(),
            updatedBy: actor.userId,
          },
        },
        { prisma },
      );
      if (claimed.count !== 1) {
        throw new AppError('CONFLICT', 'รายการนี้ตัดสินไปแล้ว');
      }
      await this.audit.record(
        {
          eventType: `service.extra_work.${data.status}`,
          companyId: order.companyId,
          ...auditActor(actor),
          resourceType: 'request',
          resourceId: order.requestId,
          after: { label: `X-${row.seq}`, estimate: Number(row.estimate) },
        },
        { prisma },
      );
    });
  }

  private async mayWork(actor: Principal, order: OrderRow) {
    if (actor.permissions.includes('service.asset.manage')) return true;
    const request = (await this.requestRows.findFirst({
      where: { id: order.requestId },
      select: { assigneeUserId: true },
    })) as { assigneeUserId: string | null } | null;
    return request?.assigneeUserId === actor.userId;
  }

  private async assertWorker(actor: Principal, order: OrderRow) {
    if (!(await this.mayWork(actor, order))) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกงานนอกสัญญาได้เฉพาะผู้รับผิดชอบงาน หรือทีมบริการ',
      );
    }
  }

  private async requestStatus(requestId: string) {
    const request = (await this.requestRows.findFirst({
      where: { id: requestId },
      select: { status: true },
    })) as { status: string } | null;
    return request?.status ?? '';
  }

  private async requireOrder(companyId: string, id: string) {
    const order = (await this.orders.findFirst({
      where: { id, companyId },
      select: { id: true, companyId: true, requestId: true, billing: true },
    })) as OrderRow | null;
    if (!order) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    return order;
  }

  private async requireExtra(companyId: string, id: string) {
    const row = (await this.extras.findFirst({
      where: { id, companyId },
    })) as ExtraRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายการงานนอกสัญญา');
    return row;
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
