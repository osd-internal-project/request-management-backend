import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaService,
  PrismaTransactionService,
  type TQueryClient,
} from '@request-management/share';
import { CustomerErpSyncService } from './customer-erp-sync.service';
import { CustomerTimelineService } from './customer-timeline.service';
import { MergeCustomersDto } from './dto/customer.dto';

interface Side {
  id: string;
  companyId: string;
  customerCode: string;
  nameTh: string;
  taxId: string | null;
  branchCode: string | null;
  status: string;
  headOfficeId: string | null;
  mergedIntoCustomerId: string | null;
  accountOwnerUserId: string | null;
}

const SIDE_SELECT = {
  id: true,
  companyId: true,
  customerCode: true,
  nameTh: true,
  taxId: true,
  branchCode: true,
  status: true,
  headOfficeId: true,
  mergedIntoCustomerId: true,
  accountOwnerUserId: true,
} as const;

/**
 * The plain "move every row of this kind" relations — nothing unique on
 * `customerId`, so the survivor simply gains them. Field-change history stays
 * with the customer it describes; the merge itself is on the timeline.
 */
const MOVED = [
  'lead',
  'opportunity',
  'saleOrder',
  'quotation',
  'customerContact',
  'customerLocation',
  'customerKycRecord',
  'customerContract',
  'customerTouchpoint',
  'customerTimelineEvent',
] as const;
type Moved = (typeof MOVED)[number];

type Counts = Record<Moved | 'segments' | 'requests' | 'branches', number>;

type Kept = {
  /** SAP (etc.) codes left on the alias — the survivor has its own. */
  externalCodes: string[];
  /** The alias's account plan stays with it — the survivor has one. */
  accountPlan: boolean;
};

/**
 * CM-09 / CD-122 — รวมลูกค้าซ้ำ (user decision 29 ก.ย. 2569: do it now, ahead
 * of the PO's "later"). A duplicate that slipped past CM-03 is folded into
 * the customer that stays:
 *
 * - every document is re-pointed (deals, quotations, sale orders, leads,
 *   contacts, locations, KYC, contracts, touchpoints, timeline, segments,
 *   requests raised on it, branches under it, earlier aliases of it) — so
 *   every old document still opens, now under the survivor (AC 1);
 * - the duplicate stays as an **alias**: `mergedIntoCustomerId` set, status
 *   inactive, read-only (`requireEditable`), still found by its old code and
 *   its page links to the survivor;
 * - where the survivor already has one of a kind that allows only one (a SAP
 *   code per system, an account plan) the duplicate keeps its own — the SAP
 *   side is re-synced as inactive so accounting sees it closed;
 * - `admin.customer.merge` only, reason required, audited on both (AC 2).
 *
 * One transaction: a merge is all or nothing.
 */
@Injectable()
export class CustomerMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: PrismaTransactionService,
    private readonly timeline: CustomerTimelineService,
    private readonly erpSync: CustomerErpSyncService,
    private readonly audit: AuditWriter,
  ) {}

  /** What a merge would do — counts and warnings, nothing changed. */
  async preview(sourceId: string, targetId: string, actor: Principal) {
    const { source, target } = await this.pair(sourceId, targetId, actor);
    const [counts, kept] = await Promise.all([
      this.count(this.prisma, source.id),
      this.kept(this.prisma, source.id, target.id),
    ]);
    return {
      source: view(source),
      target: view(target),
      counts,
      kept,
      warnings: warningsOf(source, target, kept),
    };
  }

  async merge(
    sourceId: string,
    targetId: string,
    dto: MergeCustomersDto,
    actor: Principal,
  ) {
    const reason = dto.reason.trim();
    if (!reason) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลในการรวม', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    const { source, target } = await this.pair(sourceId, targetId, actor);

    const result = await this.transactions.execute(async (tx) => {
      // Re-read inside: two admins merging the same pair at once — the
      // second finds the duplicate already an alias and stops.
      const fresh = await tx.customer.findUnique({
        where: { id: source.id },
        select: { mergedIntoCustomerId: true },
      });
      if (fresh?.mergedIntoCustomerId) {
        throw new AppError(
          'CONFLICT',
          'ลูกค้ารายนี้ถูกรวมไปแล้ว — โหลดหน้าใหม่',
        );
      }

      const kept = await this.kept(tx, source.id, target.id);
      const counts = await this.repoint(tx, source, target, kept);
      const now = new Date();

      await tx.customer.update({
        where: { id: source.id },
        data: {
          mergedIntoCustomerId: target.id,
          mergedAt: now,
          status: 'inactive',
          deactivatedAt: now,
          deactivateReason: `รวมเข้ากับ ${target.customerCode} — ${reason}`,
          updatedBy: actor.userId,
        },
      });

      for (const [customer, summary] of [
        [
          target,
          `รวม ${source.customerCode} ${source.nameTh} เข้ามา — ${reason}`,
        ],
        [source, `ถูกรวมเข้ากับ ${target.customerCode} ${target.nameTh}`],
      ] as const) {
        await this.timeline.publish(
          {
            companyId: target.companyId,
            customerId: customer.id,
            refType: 'customer',
            refId: customer === target ? source.id : target.id,
            eventType: 'customer.merged',
            summary,
            actorId: auditActor(actor).actorId,
            actorName: actor.displayName,
          },
          { prisma: tx },
        );
      }

      await this.audit.record(
        {
          eventType: 'crm.customer.merged',
          companyId: target.companyId,
          ...auditActor(actor),
          resourceType: 'customer',
          resourceId: target.id,
          before: {
            source: view(source),
            target: view(target),
          },
          after: {
            mergedCustomerId: source.id,
            mergedCustomerCode: source.customerCode,
            reason,
            counts,
            kept,
          },
        },
        { prisma: tx },
      );
      return { counts, kept };
    });

    // After commit, never inside: SAP learns the alias is closed.
    this.erpSync.kickCustomer(source.id);

    return {
      source: { id: source.id, customerCode: source.customerCode },
      target: { id: target.id, customerCode: target.customerCode },
      ...result,
    };
  }

  // --- helpers -------------------------------------------------------------

  private async pair(sourceId: string, targetId: string, actor: Principal) {
    if (sourceId === targetId) {
      throw new AppError('VALIDATION_FAILED', 'เลือกลูกค้าคนละรายกัน', [
        { field: 'target_id', reason: 'same' },
      ]);
    }
    const rows = (await this.prisma.customer.findMany({
      where: {
        id: { in: [sourceId, targetId] },
        companyId: actor.activeCompanyId,
      },
      select: SIDE_SELECT,
    })) as Side[];
    const source = rows.find((row) => row.id === sourceId);
    const target = rows.find((row) => row.id === targetId);
    // Another company's customer answers as missing (SCOPE-03).
    if (!source || !target) {
      throw new AppError('NOT_FOUND', 'ไม่พบลูกค้าที่ระบุในบริษัทนี้');
    }
    for (const side of [source, target]) {
      if (side.mergedIntoCustomerId) {
        throw new AppError(
          'CRM_CUSTOMER_STATE_INVALID',
          `${side.customerCode} ถูกรวมเข้ากับรายอื่นไปแล้ว`,
          [{ field: 'customer', reason: side.customerCode }],
        );
      }
    }
    return { source, target };
  }

  private async count(client: TQueryClient, sourceId: string) {
    const counts = {} as Counts;
    for (const model of MOVED) {
      counts[model] = await delegate(client, model).count({
        where: { customerId: sourceId },
      });
    }
    counts.segments = await client.customerSegmentAssignment.count({
      where: { customerId: sourceId },
    });
    counts.requests = await client.request.count({
      where: { refType: 'customer', refId: sourceId },
    });
    counts.branches = await client.customer.count({
      where: { headOfficeId: sourceId },
    });
    return counts;
  }

  private async kept(
    client: TQueryClient,
    sourceId: string,
    targetId: string,
  ): Promise<Kept> {
    const [codes, plans] = await Promise.all([
      client.customerExternalCode.findMany({
        where: { customerId: { in: [sourceId, targetId] } },
        select: { customerId: true, system: true },
      }),
      client.customerAccountPlan.findMany({
        where: { customerId: { in: [sourceId, targetId] } },
        select: { customerId: true },
      }),
    ]);
    const targetSystems = new Set(
      codes.filter((c) => c.customerId === targetId).map((c) => c.system),
    );
    return {
      externalCodes: codes
        .filter((c) => c.customerId === sourceId && targetSystems.has(c.system))
        .map((c) => c.system),
      accountPlan:
        plans.some((p) => p.customerId === sourceId) &&
        plans.some((p) => p.customerId === targetId),
    };
  }

  private async repoint(
    tx: TQueryClient,
    source: Side,
    target: Side,
    kept: Kept,
  ): Promise<Counts> {
    const from = { customerId: source.id };
    const to = { customerId: target.id };
    const counts = {} as Counts;

    for (const model of MOVED) {
      counts[model] = (
        await delegate(tx, model).updateMany({ where: from, data: to })
      ).count;
    }

    // Segments: the same value on both is one assignment, not two.
    const onTarget = await tx.customerSegmentAssignment.findMany({
      where: to,
      select: { valueId: true },
    });
    const taken = onTarget.map((row) => row.valueId);
    await tx.customerSegmentAssignment.deleteMany({
      where: { ...from, valueId: { in: taken } },
    });
    counts.segments = (
      await tx.customerSegmentAssignment.updateMany({ where: from, data: to })
    ).count;

    // One per system / one plan: move only what the survivor lacks.
    await tx.customerExternalCode.updateMany({
      where: { ...from, system: { notIn: kept.externalCodes } },
      data: to,
    });
    if (!kept.accountPlan) {
      await tx.customerAccountPlan.updateMany({ where: from, data: to });
    }

    counts.requests = (
      await tx.request.updateMany({
        where: { refType: 'customer', refId: source.id },
        data: { refId: target.id },
      })
    ).count;

    // Branches under the duplicate now sit under the survivor — except the
    // survivor itself, which takes the duplicate's own head office.
    if (target.headOfficeId === source.id) {
      await tx.customer.update({
        where: { id: target.id },
        data: { headOfficeId: source.headOfficeId },
      });
    }
    counts.branches = (
      await tx.customer.updateMany({
        where: { headOfficeId: source.id, id: { not: target.id } },
        data: { headOfficeId: target.id },
      })
    ).count;
    // Earlier aliases of the duplicate point straight at the survivor.
    await tx.customer.updateMany({
      where: { mergedIntoCustomerId: source.id },
      data: { mergedIntoCustomerId: target.id },
    });
    return counts;
  }
}

/** The Prisma delegates that all answer count/updateMany by `customerId`. */
function delegate(client: TQueryClient, model: Moved) {
  return client[model] as unknown as {
    count(args: { where: { customerId: string } }): Promise<number>;
    updateMany(args: {
      where: { customerId: string };
      data: { customerId: string };
    }): Promise<{ count: number }>;
  };
}

function view(side: Side) {
  return {
    id: side.id,
    customerCode: side.customerCode,
    nameTh: side.nameTh,
    branchCode: side.branchCode,
    status: side.status,
  };
}

/** What an admin should read twice before confirming. */
export function warningsOf(source: Side, target: Side, kept: Kept): string[] {
  const warnings: string[] = [];
  if (source.taxId && target.taxId && source.taxId !== target.taxId) {
    warnings.push('เลขประจำตัวผู้เสียภาษีไม่ตรงกัน — อาจเป็นคนละนิติบุคคล');
  }
  if (
    source.taxId &&
    source.taxId === target.taxId &&
    (source.branchCode ?? '00000') !== (target.branchCode ?? '00000')
  ) {
    warnings.push('เลขภาษีเดียวกันแต่คนละสาขา — ปกติเป็นลูกค้าคนละราย');
  }
  if (target.headOfficeId === source.id) {
    warnings.push(
      'รายที่จะถูกรวมเป็นสำนักงานใหญ่ของรายหลัก — สาขาอื่นจะย้ายมาอยู่ใต้รายหลัก',
    );
  }
  if (kept.externalCodes.length) {
    warnings.push(
      `ทั้งสองรายมีรหัสใน ${kept.externalCodes.join(', ').toUpperCase()} — รหัสของรายที่ถูกรวมจะถูกปิดใน SAP ให้ฝ่ายบัญชีรวมยอดใน SAP เอง`,
    );
  }
  if (kept.accountPlan) {
    warnings.push(
      'ทั้งสองรายมีแผนบัญชี (Keeper) — ใช้แผนของรายหลัก แผนของรายที่ถูกรวมเก็บไว้เป็นประวัติ',
    );
  }
  if (
    source.accountOwnerUserId &&
    target.accountOwnerUserId &&
    source.accountOwnerUserId !== target.accountOwnerUserId
  ) {
    warnings.push(
      'ผู้ดูแลลูกค้าต่างกัน — หลังรวมใช้ผู้ดูแลของรายหลัก ผู้ดูแลเดิมอาจมองไม่เห็นลูกค้านี้แล้ว',
    );
  }
  return warnings;
}
