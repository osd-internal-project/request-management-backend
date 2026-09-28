import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  PrismaTransactionService,
  reachableUnitIds,
} from '@request-management/share';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { OrgUnitRepository } from '../access/org-unit.repository';
import { RequestsService } from '../requests/requests.service';
import {
  ListSalesTargetsQueryDto,
  OPEN_OPPORTUNITY_STAGES,
  SetSalesTargetDto,
} from './dto/sales.dto';
import { CrmConfigRepository } from './segment.repositories';
import {
  AmountGroup,
  OpportunityRepository,
  SaleOrderRepository,
  SalesTargetRepository,
  SalesTargetRevisionRepository,
} from './sales.repositories';

/** Thailand has no DST — a month runs from 00:00 +07:00 on the 1st. */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

type Scope = 'user' | 'org_unit';

/** `YYYY-MM` of `now` on the Bangkok calendar. */
export function currentPeriod(now: Date = new Date()): string {
  return new Date(now.getTime() + BANGKOK_OFFSET_MS).toISOString().slice(0, 7);
}

/** `[start, end)` instants of a `YYYY-MM` Bangkok month. */
export function periodRange(period: string): { start: Date; end: Date } {
  const [year, month] = period.split('-').map(Number);
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - BANGKOK_OFFSET_MS),
    end: new Date(Date.UTC(year, month, 1) - BANGKOK_OFFSET_MS),
  };
}

/** % of target, one decimal; null when there is no target to divide by. */
export function percentOf(value: number, target: number): number | null {
  if (!(target > 0)) return null;
  return Math.round((value / target) * 1000) / 10;
}

interface PipelineRow {
  ownerUserId: string;
  ownerOrgUnitId: string | null;
  amount: Prisma.Decimal | null;
  probability: number | null;
}

interface TargetRow {
  id: string;
  scope: Scope;
  subjectId: string;
  period: string;
  amount: Prisma.Decimal;
}

export interface SalesTargetView {
  id: string;
  scope: Scope;
  subject_id: string;
  subject_name: string;
  period: string;
  amount: number;
  /** ยอดขายจริงของงวด (ใบสั่งขายที่ไม่ยกเลิก — นิยามเดียวกับ CD-83). */
  actual: number;
  /**
   * พยากรณ์ = ยอดขายจริง + Σ มูลค่า × ความน่าจะเป็น ของโอกาสที่ยังเปิดและคาดว่าจะปิด
   * ในงวดนี้. งวดที่จบแล้ว = ยอดจริง.
   */
  forecast: number;
  attainment_pct: number | null;
  forecast_pct: number | null;
  pending: {
    revision_id: string;
    new_amount: number;
    approval_request_id: string | null;
  } | null;
}

export interface SalesTargetList {
  period: string;
  /** งวดนี้เริ่มแล้วหรือยัง — เริ่มแล้ว = ปรับเป้าที่มีอยู่ต้องขออนุมัติ. */
  started: boolean;
  closed: boolean;
  can_manage: boolean;
  /** CRM settings name a request type for adjustments. */
  adjustment_configured: boolean;
  targets: SalesTargetView[];
}

/**
 * CD-82 — เป้าและพยากรณ์.
 *
 * ตั้งเป้ารายเดือนให้พนักงานหนึ่งคนหรือกลุ่มหนึ่งในผังองค์กร (ทีม/ฝ่าย — นับยอดของ
 * ทุกกลุ่มใต้มัน). **ปรับเป้าของงวดที่เริ่มแล้วต้องผ่านผู้อำนวยการ**: ระบบไม่เขียน
 * state machine เอง แต่สร้างร่างคำขอตามประเภทที่ตั้งใน ตั้งค่า CRM — เส้นทาง
 * อนุมัติจึงเป็นตารางอำนาจอนุมัติของประเภทนั้น แก้ได้โดยไม่ deploy. ค่าใหม่มีผล
 * เมื่อคำขออนุมัติ (`SalesTargetApprovalSyncService`) และค่าเดิมอยู่ใน revision เสมอ.
 *
 * การตั้งเป้าครั้งแรกของงวด ไม่ถือเป็นการ "ปรับ" จึงไม่ต้องขออนุมัติ.
 */
@Injectable()
export class SalesTargetsService {
  constructor(
    private readonly targets: SalesTargetRepository,
    private readonly revisions: SalesTargetRevisionRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly members: CompanyMemberRepository,
    private readonly orgUnits: OrgUnitRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestsService: RequestsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async list(
    query: ListSalesTargetsQueryDto,
    actor: Principal,
    now: Date = new Date(),
  ): Promise<SalesTargetList> {
    const current = currentPeriod(now);
    const period = query.period ?? current;
    const companyId = actor.activeCompanyId;

    const rows = (await this.targets.findMany({
      where: { companyId, period, ...(await this.visibleWhere(actor)) },
      select: {
        id: true,
        scope: true,
        subjectId: true,
        period: true,
        amount: true,
      },
    })) as TargetRow[];

    const config = await this.targetApprovalTypeCode(companyId);
    const views = await this.measure(rows, period, period < current, companyId);

    return {
      period,
      started: period <= current,
      closed: period < current,
      can_manage: actor.permissions.includes('crm.target.manage'),
      adjustment_configured: Boolean(config),
      targets: views,
    };
  }

  /** ประวัติการเปลี่ยนเป้าหนึ่งตัว — ใหม่สุดก่อน. */
  async history(id: string, actor: Principal) {
    await this.requireVisible(id, actor);

    const rows = (await this.revisions.findMany({
      where: { targetId: id },
      orderBy: { createdAt: 'desc' },
    })) as {
      id: string;
      previousAmount: Prisma.Decimal | null;
      newAmount: Prisma.Decimal;
      reason: string | null;
      status: string;
      approvalRequestId: string | null;
      decidedAt: Date | null;
      createdAt: Date;
      createdBy: string | null;
    }[];

    const names = await this.userNames(
      rows.map((row) => row.createdBy).filter(Boolean) as string[],
      actor.activeCompanyId,
    );

    return rows.map((row) => ({
      id: row.id,
      previous_amount:
        row.previousAmount === null ? null : Number(row.previousAmount),
      new_amount: Number(row.newAmount),
      reason: row.reason,
      status: row.status,
      approval_request_id: row.approvalRequestId,
      decided_at: row.decidedAt,
      created_at: row.createdAt,
      created_by_name: row.createdBy
        ? (names.get(row.createdBy) ?? row.createdBy)
        : null,
    }));
  }

  async set(dto: SetSalesTargetDto, actor: Principal, now: Date = new Date()) {
    const companyId = actor.activeCompanyId;
    const subjectName = await this.requireSubject(
      dto.scope,
      dto.subject_id,
      companyId,
    );
    const amount = new Prisma.Decimal(dto.amount).toDecimalPlaces(2);
    const started = dto.period <= currentPeriod(now);

    const existing = (await this.targets.findFirst({
      where: {
        companyId,
        scope: dto.scope,
        subjectId: dto.subject_id,
        period: dto.period,
      },
    })) as (TargetRow & { companyId: string }) | null;

    if (!existing) {
      return this.transactions.execute(async (prisma) => {
        const created = (await this.targets.create(
          {
            data: {
              companyId,
              scope: dto.scope,
              subjectId: dto.subject_id,
              period: dto.period,
              amount,
              createdBy: actor.userId,
              updatedBy: actor.userId,
            },
          },
          { prisma },
        )) as TargetRow;
        await this.revisions.create(
          {
            data: {
              companyId,
              targetId: created.id,
              previousAmount: null,
              newAmount: amount,
              reason: dto.reason?.trim() || null,
              status: 'applied',
              createdBy: actor.userId,
            },
          },
          { prisma },
        );
        await this.record(prisma, actor, 'crm.sales_target.set', created.id, {
          before: null,
          after: { ...describe(dto, subjectName), amount: amount.toFixed(2) },
        });
        return {
          target_id: created.id,
          applied: true,
          approval_request_id: null,
        };
      });
    }

    if (existing.amount.equals(amount)) {
      throw new AppError('VALIDATION_FAILED', 'เป้าใหม่เท่ากับเป้าเดิม', [
        { field: 'amount', reason: 'unchanged' },
      ]);
    }

    const pending = await this.revisions.findFirst({
      where: { targetId: existing.id, status: 'pending_approval' },
      select: { id: true },
    });
    if (pending) {
      throw new AppError(
        'CRM_TARGET_ADJUSTMENT_PENDING',
        'เป้านี้มีการปรับที่รออนุมัติอยู่ — รอผลหรือยกเลิกคำขอเดิมก่อน',
      );
    }

    if (!started) {
      return this.transactions.execute(async (prisma) => {
        await this.targets.update(
          {
            where: { id: existing.id },
            data: { amount, updatedBy: actor.userId },
          },
          { prisma },
        );
        await this.revisions.create(
          {
            data: {
              companyId,
              targetId: existing.id,
              previousAmount: existing.amount,
              newAmount: amount,
              reason: dto.reason?.trim() || null,
              status: 'applied',
              createdBy: actor.userId,
            },
          },
          { prisma },
        );
        await this.record(
          prisma,
          actor,
          'crm.sales_target.updated',
          existing.id,
          {
            before: { amount: existing.amount.toFixed(2) },
            after: { ...describe(dto, subjectName), amount: amount.toFixed(2) },
          },
        );
        return {
          target_id: existing.id,
          applied: true,
          approval_request_id: null,
        };
      });
    }

    // งวดเริ่มแล้ว — ปรับได้ด้วยการขออนุมัติเท่านั้น.
    const reason = dto.reason?.trim();
    if (!reason) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ปรับเป้าของงวดที่เริ่มแล้วต้องระบุเหตุผลเพื่อขออนุมัติ',
        [{ field: 'reason', reason: 'required_when_period_started' }],
      );
    }

    const typeCode = await this.targetApprovalTypeCode(companyId);
    const unavailable = () =>
      new AppError(
        'CRM_TARGET_APPROVAL_UNAVAILABLE',
        typeCode
          ? `ยื่นขออนุมัติไม่ได้ — ประเภทคำขอ ${typeCode} ไม่เปิดให้บริษัทนี้ใช้ (ตั้งค่าได้ที่ ตั้งค่า CRM)`
          : 'ยังไม่ได้ตั้งประเภทคำขอสำหรับอนุมัติการปรับเป้า (ตั้งค่าได้ที่ ตั้งค่า CRM)',
        [{ field: 'target_approval_type_code', reason: typeCode ?? 'unset' }],
      );
    if (!typeCode) throw unavailable();

    let request: { id: string };
    try {
      request = await this.requestsService.create(
        {
          type_code: typeCode,
          ref_type: 'sales_target',
          ref_id: existing.id,
          form_data: {
            target_subject: subjectName,
            target_period: dto.period,
            current_amount: Number(existing.amount.toFixed(2)),
            new_amount: Number(amount.toFixed(2)),
            reason: `ปรับเป้า ${subjectName} งวด ${dto.period} — ${reason}`,
          },
        },
        actor,
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw unavailable();
    }

    try {
      return await this.transactions.execute(async (prisma) => {
        const revision = (await this.revisions.create(
          {
            data: {
              companyId,
              targetId: existing.id,
              previousAmount: existing.amount,
              newAmount: amount,
              reason,
              status: 'pending_approval',
              approvalRequestId: request.id,
              createdBy: actor.userId,
            },
          },
          { prisma },
        )) as { id: string };
        await this.record(
          prisma,
          actor,
          'crm.sales_target.adjustment_requested',
          existing.id,
          {
            before: { amount: existing.amount.toFixed(2) },
            after: {
              ...describe(dto, subjectName),
              requestedAmount: amount.toFixed(2),
              revisionId: revision.id,
              approvalRequestId: request.id,
              reason,
            },
          },
        );
        return {
          target_id: existing.id,
          applied: false,
          approval_request_id: request.id,
        };
      });
    } catch (error) {
      // สองหน้าต่างยื่นพร้อมกัน — index บางส่วนรับได้ใบเดียว.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppError(
          'CRM_TARGET_ADJUSTMENT_PENDING',
          'เป้านี้มีการปรับที่รออนุมัติอยู่ — รอผลหรือยกเลิกคำขอเดิมก่อน',
        );
      }
      throw error;
    }
  }

  // --- visibility -----------------------------------------------------------

  /**
   * เห็นเป้าของใคร: ผู้ตั้งเป้า (`crm.target.manage`) และ `crm.sales.read.all` เห็นทั้ง
   * บริษัท; คนอื่นเห็นเป้าของตัวเอง, ของคนในกลุ่มที่ตัวเองดูแล และของกลุ่มเหล่านั้น —
   * แนวเดียวกับ `visibleSalesWhere`.
   */
  private async visibleWhere(
    actor: Principal,
  ): Promise<Prisma.SalesTargetWhereInput> {
    if (
      actor.permissions.includes('crm.sales.read.all') ||
      actor.permissions.includes('crm.target.manage')
    ) {
      return {};
    }

    const units = reachableUnitIds(actor);
    const people = units.length
      ? await this.members.findInUnits(units, actor.activeCompanyId)
      : [];

    return {
      OR: [
        {
          scope: 'user',
          subjectId: {
            in: [actor.userId, ...people.map((person) => person.id)],
          },
        },
        ...(units.length
          ? [{ scope: 'org_unit' as const, subjectId: { in: units } }]
          : []),
      ],
    };
  }

  private async requireVisible(id: string, actor: Principal) {
    const found = await this.targets.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...(await this.visibleWhere(actor)),
      },
      select: { id: true },
    });
    // SCOPE-03: out of reach answers 404, not 403.
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบเป้านี้');
    return found;
  }

  // --- figures -------------------------------------------------------------

  /** ยอดจริงและพยากรณ์ของทุกเป้าในงวดเดียว — query ชุดเดียวไม่ว่าจะกี่แถว. */
  private async measure(
    rows: TargetRow[],
    period: string,
    closed: boolean,
    companyId: string,
  ): Promise<SalesTargetView[]> {
    if (!rows.length) return [];

    const range = periodRange(period);
    const inPeriod = { gte: range.start, lt: range.end };

    const userIds = rows
      .filter((row) => row.scope === 'user')
      .map((row) => row.subjectId);
    const unitIds = rows
      .filter((row) => row.scope === 'org_unit')
      .map((row) => row.subjectId);
    const subtrees = await this.orgUnits.subtreesOf(unitIds);

    const soldWhere = {
      companyId,
      status: 'open' as const,
      orderedAt: inPeriod,
    };
    const [byUser, byUnit, pipeline, userNames, unitNames, pending] =
      await Promise.all([
        userIds.length
          ? this.saleOrders.totalsByOwner({
              ...soldWhere,
              ownerUserId: { in: userIds },
            })
          : Promise.resolve([] as AmountGroup[]),
        unitIds.length
          ? this.saleOrders.totalsByOrgUnit(soldWhere)
          : Promise.resolve([] as AmountGroup[]),
        closed
          ? Promise.resolve([] as PipelineRow[])
          : (this.opportunities.findMany({
              where: {
                companyId,
                stage: { in: [...OPEN_OPPORTUNITY_STAGES] },
                expectedCloseAt: inPeriod,
              },
              select: {
                ownerUserId: true,
                ownerOrgUnitId: true,
                amount: true,
                probability: true,
              },
            }) as Promise<PipelineRow[]>),
        this.userNames(userIds, companyId),
        this.unitNames(unitIds),
        this.revisions.findMany({
          where: {
            targetId: { in: rows.map((row) => row.id) },
            status: 'pending_approval',
          },
          select: {
            id: true,
            targetId: true,
            newAmount: true,
            approvalRequestId: true,
          },
        }) as Promise<
          {
            id: string;
            targetId: string;
            newAmount: Prisma.Decimal;
            approvalRequestId: string | null;
          }[]
        >,
      ]);

    const soldByUser = new Map(byUser.map((g) => [g.key, g.amount]));
    const soldByUnit = new Map(byUnit.map((g) => [g.key, g.amount]));
    const weighted = (row: PipelineRow) =>
      ((row.amount === null ? 0 : Number(row.amount)) *
        (row.probability ?? 0)) /
      100;
    const pendingOf = new Map(pending.map((p) => [p.targetId, p]));

    return rows
      .map((row) => {
        const target = Number(row.amount);
        let actual: number;
        let expected: number;

        if (row.scope === 'user') {
          actual = soldByUser.get(row.subjectId) ?? 0;
          expected = pipeline
            .filter((opp) => opp.ownerUserId === row.subjectId)
            .reduce((sum, opp) => sum + weighted(opp), 0);
        } else {
          const units = new Set(subtrees.get(row.subjectId) ?? []);
          actual = [...units].reduce(
            (sum, unit) => sum + (soldByUnit.get(unit) ?? 0),
            0,
          );
          expected = pipeline
            .filter(
              (opp) => opp.ownerOrgUnitId && units.has(opp.ownerOrgUnitId),
            )
            .reduce((sum, opp) => sum + weighted(opp), 0);
        }

        const forecast = Math.round((actual + expected) * 100) / 100;
        const waiting = pendingOf.get(row.id);

        return {
          id: row.id,
          scope: row.scope,
          subject_id: row.subjectId,
          subject_name:
            (row.scope === 'user'
              ? userNames.get(row.subjectId)
              : unitNames.get(row.subjectId)) ?? row.subjectId,
          period: row.period,
          amount: target,
          actual,
          forecast,
          attainment_pct: percentOf(actual, target),
          forecast_pct: percentOf(forecast, target),
          pending: waiting
            ? {
                revision_id: waiting.id,
                new_amount: Number(waiting.newAmount),
                approval_request_id: waiting.approvalRequestId,
              }
            : null,
        };
      })
      .sort(
        (a, b) =>
          (a.scope === b.scope ? 0 : a.scope === 'org_unit' ? -1 : 1) ||
          a.subject_name.localeCompare(b.subject_name, 'th'),
      );
  }

  // --- helpers -------------------------------------------------------------

  /** เจ้าของเป้าต้องอยู่ในบริษัทนี้จริง — id มาจากผู้เรียก (SCOPE-03). */
  private async requireSubject(
    scope: Scope,
    subjectId: string,
    companyId: string,
  ): Promise<string> {
    if (scope === 'user') {
      const [person] = await this.members.findActiveByIds(
        [subjectId],
        companyId,
      );
      if (person) return person.displayName;
    } else {
      const unit = (await this.orgUnits.findFirst({
        where: { id: subjectId, companyId, active: true },
        select: { name: true },
      })) as { name: string } | null;
      if (unit) return unit.name;
    }
    throw new AppError(
      'VALIDATION_FAILED',
      'ไม่พบพนักงานหรือกลุ่มนี้ในบริษัท',
      [{ field: 'subject_id', reason: 'not_in_company' }],
    );
  }

  private async targetApprovalTypeCode(
    companyId: string,
  ): Promise<string | null> {
    const config = (await this.configs.findFirst({
      where: { companyId },
      select: { targetApprovalTypeCode: true },
    })) as { targetApprovalTypeCode: string | null } | null;
    return config?.targetApprovalTypeCode ?? null;
  }

  private async userNames(ids: string[], companyId: string) {
    const people = await this.members.findActiveByIds(
      [...new Set(ids)],
      companyId,
    );
    return new Map(people.map((person) => [person.id, person.displayName]));
  }

  private async unitNames(ids: string[]) {
    if (!ids.length) return new Map<string, string>();
    const units = (await this.orgUnits.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    })) as { id: string; name: string }[];
    return new Map(units.map((unit) => [unit.id, unit.name]));
  }

  private record(
    prisma: Prisma.TransactionClient,
    actor: Principal,
    eventType: string,
    targetId: string,
    change: { before: unknown; after: unknown },
  ) {
    return this.audit.record(
      {
        eventType,
        companyId: actor.activeCompanyId,
        ...auditActor(actor),
        resourceType: 'sales_target',
        resourceId: targetId,
        before: change.before as Prisma.InputJsonValue,
        after: change.after as Prisma.InputJsonValue,
      },
      { prisma },
    );
  }
}

function describe(dto: SetSalesTargetDto, subjectName: string) {
  return {
    scope: dto.scope,
    subjectId: dto.subject_id,
    subjectName,
    period: dto.period,
  };
}
