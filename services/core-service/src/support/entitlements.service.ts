import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CustomerRepository } from '../crm/customer.repository';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { thaiToday } from '../crm/vendor-costs';
import { readSeverityTargets } from '../sla/severity';
import {
  coverageOn,
  entitlementProblems,
  entitlementState,
  quotaLeft,
  warrantyEnd,
} from './entitlement-rules';
import {
  CancelEntitlementDto,
  ListEntitlementsQueryDto,
  SaveEntitlementDto,
} from './support.dto';
import {
  ServiceAssetRepository,
  ServiceEntitlementAssetRepository,
  ServiceEntitlementRepository,
} from './support.repositories';

interface EntitlementRow {
  id: string;
  companyId: string;
  customerId: string;
  contractId: string | null;
  projectId: string | null;
  kind: string;
  title: string;
  startOn: Date;
  endOn: Date;
  coverage: string | null;
  severityTargets: unknown;
  correctiveQuota: number | null;
  preventiveQuota: number | null;
  correctiveUsed: number;
  preventiveUsed: number;
  note: string | null;
  source: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: string;
  updatedAt: Date;
}

const day = (value: Date) => value.toISOString().slice(0, 10);
const date = (value: string) => new Date(`${value}T00:00:00Z`);
const addDays = (value: string, days: number) =>
  new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * CD-237 สิทธิ์การรับบริการ — what covers each installed asset: the
 * warranty an accepted project carries (its contract's warranty months from
 * the acceptance date, its service level, CD-151/155), and the service
 * contracts (MA) the service team sets from the contract register. Each
 * holds its period, its service level and its visit quotas — corrective and
 * preventive apart — so a call can be answered at once: covered or not,
 * until when, how fast, how many visits left.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` sets them up.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    private readonly entitlements: ServiceEntitlementRepository,
    private readonly links: ServiceEntitlementAssetRepository,
    private readonly assets: ServiceAssetRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly terms: ContractTermsRepository,
    private readonly customers: CustomerRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /**
   * At acceptance (CD-236 calls it with what it just registered): the
   * project's contract warranty over those assets, from the acceptance date.
   * No warranty months on the contract — no warranty.
   */
  async warrantyFromAcceptance(input: {
    companyId: string;
    projectId: string;
    customerId: string | null;
    contractId: string | null;
    acceptedOn: string;
    label: string;
    assetIds: string[];
    actorId: string;
  }) {
    if (!input.customerId || !input.contractId || !input.assetIds.length) {
      return null;
    }
    const [contract, terms] = await Promise.all([
      this.contracts.findFirst({
        where: { id: input.contractId, companyId: input.companyId },
        select: { contractNo: true },
      }) as Promise<{ contractNo: string } | null>,
      this.terms.findFirst({
        where: { contractId: input.contractId },
        select: {
          warrantyMonths: true,
          serviceCoverage: true,
          serviceLevels: true,
        },
      }) as Promise<{
        warrantyMonths: number | null;
        serviceCoverage: string | null;
        serviceLevels: unknown;
      } | null>,
    ]);
    if (!contract || !terms?.warrantyMonths) return null;
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceEntitlement.create({
        data: {
          companyId: input.companyId,
          customerId: input.customerId!,
          contractId: input.contractId,
          projectId: input.projectId,
          kind: 'warranty',
          title: `ประกัน ${contract.contractNo} (${input.label})`,
          startOn: date(input.acceptedOn),
          endOn: date(warrantyEnd(input.acceptedOn, terms.warrantyMonths!)),
          coverage: (terms.serviceCoverage as never) ?? null,
          severityTargets: readSeverityTargets(terms.serviceLevels)
            ? (terms.serviceLevels as object)
            : Prisma.JsonNull,
          source: input.label,
          createdBy: input.actorId,
        },
        select: { id: true },
      });
      await prisma.serviceEntitlementAsset.createMany({
        data: input.assetIds.map((assetId) => ({
          entitlementId: created.id,
          assetId,
          addedBy: input.actorId,
        })),
      });
      return created;
    });
    await this.audit.record({
      eventType: 'service.entitlement.warranty',
      companyId: input.companyId,
      actorId: null,
      actorUsername: 'system',
      resourceType: 'service_entitlement',
      resourceId: row.id,
      after: {
        projectId: input.projectId,
        contractId: input.contractId,
        months: terms.warrantyMonths,
        assets: input.assetIds.length,
      },
    });
    return row.id;
  }

  /** What covers an asset on a day (the work orders ask this, CD-239). */
  async coverageOf(companyId: string, assetId: string, on = thaiToday()) {
    const rows = await this.rowsFor(companyId, assetId);
    return coverageOn(this.plain(rows), on).map((row) => this.summary(row, on));
  }

  async list(actor: Principal, query: ListEntitlementsQueryDto) {
    const companyId = actor.activeCompanyId;
    const today = thaiToday();
    const rows = (await this.entitlements.findMany({
      where: {
        companyId,
        ...(query.customer_id ? { customerId: query.customer_id } : {}),
      },
      orderBy: [{ endOn: 'asc' }],
      take: 500,
    })) as EntitlementRow[];
    const counts = await this.assetCounts(rows.map((row) => row.id));
    const customers = await this.customerNames(rows.map((r) => r.customerId));
    const state = query.state ?? 'active';
    const within = Number(query.expiring_days) || 0;
    return rows
      .map((row) => ({
        ...this.summary(this.plain([row])[0], today),
        customer: customers.get(row.customerId) ?? null,
        assetCount: counts.get(row.id) ?? 0,
      }))
      .filter((row) => state === 'all' || row.state === state)
      .filter((row) => !within || row.endOn <= addDays(today, within));
  }

  async detail(actor: Principal, id: string) {
    const row = await this.requireRow(actor.activeCompanyId, id);
    const today = thaiToday();
    const links = (await this.links.findMany({
      where: { entitlementId: id, removedAt: null },
      include: {
        asset: {
          select: {
            id: true,
            name: true,
            model: true,
            serialNo: true,
            location: true,
            status: true,
          },
        },
      },
    })) as unknown as {
      asset: {
        id: string;
        name: string;
        model: string | null;
        serialNo: string | null;
        location: string | null;
        status: string;
      };
    }[];
    const contract = row.contractId
      ? ((await this.contracts.findFirst({
          where: { id: row.contractId },
          select: { id: true, contractNo: true, title: true },
        })) as { id: string; contractNo: string; title: string } | null)
      : null;
    const customers = await this.customerNames([row.customerId]);
    return {
      ...this.summary(this.plain([row])[0], today),
      customer: customers.get(row.customerId) ?? null,
      contract,
      note: row.note,
      cancelReason: row.cancelReason,
      assets: links.map((link) => link.asset),
    };
  }

  /** A customer's contracts to set an entitlement from (number and title only). */
  async contractsOf(actor: Principal, customerId: string) {
    return (await this.contracts.findMany({
      where: {
        companyId: actor.activeCompanyId,
        customerId,
        kind: { in: ['standard', 'msa', 'other'] },
      },
      orderBy: { endOn: 'desc' },
      take: 100,
      select: {
        id: true,
        contractNo: true,
        title: true,
        endOn: true,
        status: true,
      },
    })) as {
      id: string;
      contractNo: string;
      title: string;
      endOn: Date;
      status: string;
    }[];
  }

  /**
   * A contract's defaults for a new entitlement: its customer, period,
   * service level and the customer's active assets to pick from.
   */
  async contractDefaults(actor: Principal, contractId: string) {
    const companyId = actor.activeCompanyId;
    const contract = (await this.contracts.findFirst({
      where: { id: contractId, companyId },
      select: {
        id: true,
        contractNo: true,
        title: true,
        customerId: true,
        startOn: true,
        endOn: true,
      },
    })) as {
      id: string;
      contractNo: string;
      title: string;
      customerId: string | null;
      startOn: Date | null;
      endOn: Date;
    } | null;
    if (!contract) throw new AppError('NOT_FOUND', 'ไม่พบสัญญา');
    const terms = (await this.terms.findFirst({
      where: { contractId },
      select: { serviceCoverage: true, serviceLevels: true },
    })) as { serviceCoverage: string | null; serviceLevels: unknown } | null;
    return {
      contractId: contract.id,
      customerId: contract.customerId,
      title: `${contract.contractNo} ${contract.title}`,
      startOn: contract.startOn ? day(contract.startOn) : null,
      endOn: day(contract.endOn),
      coverage: terms?.serviceCoverage ?? null,
      severityTargets: readSeverityTargets(terms?.serviceLevels) ?? null,
    };
  }

  async create(actor: Principal, dto: SaveEntitlementDto) {
    const companyId = actor.activeCompanyId;
    const input = await this.input(companyId, dto, null);
    const assetIds = await this.assetIds(
      companyId,
      input.customerId,
      dto.asset_ids ?? [],
    );
    const id = await this.write(async (prisma) => {
      const row = await prisma.serviceEntitlement.create({
        data: { companyId, ...input, createdBy: actor.userId },
        select: { id: true },
      });
      if (assetIds.length) {
        await prisma.serviceEntitlementAsset.createMany({
          data: assetIds.map((assetId) => ({
            entitlementId: row.id,
            assetId,
            addedBy: actor.userId,
          })),
        });
      }
      await this.audit.record(
        {
          eventType: 'service.entitlement.created',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_entitlement',
          resourceId: row.id,
          after: { ...this.auditable(input), assets: assetIds.length },
        },
        { prisma },
      );
      return row.id;
    });
    return this.detail(actor, id);
  }

  async update(actor: Principal, id: string, dto: SaveEntitlementDto) {
    const companyId = actor.activeCompanyId;
    const current = await this.requireRow(companyId, id);
    if (current.cancelledAt) {
      throw new AppError('CONFLICT', 'สิทธิ์นี้ยกเลิกแล้ว');
    }
    const reason = dto.reason?.trim() ?? '';
    if (!reason) {
      throw new AppError('VALIDATION_FAILED', 'ต้องระบุเหตุผลที่แก้', [
        { field: 'reason', reason: 'required' },
      ]);
    }
    const input = await this.input(companyId, dto, current);
    const assetIds =
      dto.asset_ids === undefined
        ? null
        : await this.assetIds(companyId, input.customerId, dto.asset_ids);
    await this.write(async (prisma) => {
      await prisma.serviceEntitlement.update({
        where: { id },
        data: { ...input, updatedBy: actor.userId },
      });
      if (assetIds) {
        const now = new Date();
        const live = (
          await prisma.serviceEntitlementAsset.findMany({
            where: { entitlementId: id, removedAt: null },
            select: { assetId: true },
          })
        ).map((row) => row.assetId);
        await prisma.serviceEntitlementAsset.updateMany({
          where: {
            entitlementId: id,
            removedAt: null,
            assetId: { notIn: assetIds },
          },
          data: { removedAt: now, removedBy: actor.userId },
        });
        for (const assetId of assetIds.filter((a) => !live.includes(a))) {
          await prisma.serviceEntitlementAsset.upsert({
            where: { entitlementId_assetId: { entitlementId: id, assetId } },
            create: { entitlementId: id, assetId, addedBy: actor.userId },
            update: {
              removedAt: null,
              removedBy: null,
              addedAt: now,
              addedBy: actor.userId,
            },
          });
        }
      }
      await this.audit.record(
        {
          eventType: 'service.entitlement.updated',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_entitlement',
          resourceId: id,
          before: this.auditable(current),
          after: {
            ...this.auditable(input),
            ...(assetIds ? { assets: assetIds.length } : {}),
            reason,
          },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  async cancel(actor: Principal, id: string, dto: CancelEntitlementDto) {
    const companyId = actor.activeCompanyId;
    const current = await this.requireRow(companyId, id);
    if (current.cancelledAt) {
      throw new AppError('CONFLICT', 'สิทธิ์นี้ยกเลิกแล้ว');
    }
    await this.write(async (prisma) => {
      await prisma.serviceEntitlement.update({
        where: { id },
        data: {
          cancelledAt: new Date(),
          cancelledBy: actor.userId,
          cancelReason: dto.reason.trim(),
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.entitlement.cancelled',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_entitlement',
          resourceId: id,
          after: { reason: dto.reason.trim() },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  /** For the asset register: each asset's entitlements and what covers it now. */
  async forAssets(companyId: string, assetIds: string[], on = thaiToday()) {
    const result = new Map<
      string,
      {
        current: ReturnType<EntitlementsService['summary']> | null;
        all: ReturnType<EntitlementsService['summary']>[];
      }
    >();
    if (!assetIds.length) return result;
    const links = (await this.links.findMany({
      where: {
        assetId: { in: assetIds },
        removedAt: null,
        entitlement: { companyId },
      },
      include: { entitlement: true },
    })) as unknown as { assetId: string; entitlement: EntitlementRow }[];
    for (const assetId of assetIds) {
      const rows = this.plain(
        links.filter((l) => l.assetId === assetId).map((l) => l.entitlement),
      );
      const current = coverageOn(rows, on)[0] ?? null;
      result.set(assetId, {
        current: current ? this.summary(current, on) : null,
        all: rows
          .sort((a, b) => b.endOn.localeCompare(a.endOn))
          .map((row) => this.summary(row, on)),
      });
    }
    return result;
  }

  // --- helpers -----------------------------------------------------------------------

  private plain(rows: EntitlementRow[]) {
    return rows.map((row) => ({
      ...row,
      startOn: day(row.startOn),
      endOn: day(row.endOn),
      cancelled: Boolean(row.cancelledAt),
    }));
  }

  private summary(
    row: ReturnType<EntitlementsService['plain']>[number],
    on: string,
  ) {
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      contractId: row.contractId,
      projectId: row.projectId,
      startOn: row.startOn,
      endOn: row.endOn,
      state: entitlementState(row, on),
      coverage: row.coverage,
      severityTargets: readSeverityTargets(row.severityTargets),
      correctiveQuota: row.correctiveQuota,
      preventiveQuota: row.preventiveQuota,
      correctiveUsed: row.correctiveUsed,
      preventiveUsed: row.preventiveUsed,
      correctiveLeft: quotaLeft(row.correctiveQuota, row.correctiveUsed),
      preventiveLeft: quotaLeft(row.preventiveQuota, row.preventiveUsed),
      source: row.source,
    };
  }

  private async input(
    companyId: string,
    dto: SaveEntitlementDto,
    current: EntitlementRow | null,
  ) {
    const pick = <T>(given: T | undefined, was: T) =>
      given === undefined ? was : given;
    const kind = pick(dto.kind, current?.kind ?? 'service_contract');
    const customerId = pick(dto.customer_id, current?.customerId ?? '') ?? '';
    const contractId =
      pick(dto.contract_id, current?.contractId ?? null) || null;
    const title = (pick(dto.title, current?.title ?? '') ?? '').trim();
    const startOn =
      pick(dto.start_on, current ? day(current.startOn) : '') ?? '';
    const endOn = pick(dto.end_on, current ? day(current.endOn) : '') ?? '';
    const coverage = pick(dto.coverage, current?.coverage ?? null) || null;
    const severityTargets = pick<unknown>(
      dto.severity_targets,
      current?.severityTargets ?? null,
    );
    const correctiveQuota = pick(
      dto.corrective_quota,
      current?.correctiveQuota ?? null,
    );
    const preventiveQuota = pick(
      dto.preventive_quota,
      current?.preventiveQuota ?? null,
    );
    const problems = entitlementProblems({
      kind,
      title,
      startOn,
      endOn,
      coverage,
      severityTargets,
      correctiveQuota: correctiveQuota ?? null,
      preventiveQuota: preventiveQuota ?? null,
    });
    if (!customerId) problems.push('ต้องระบุลูกค้า');
    else if (
      !(await this.customers.count({ where: { id: customerId, companyId } }))
    ) {
      problems.push('ไม่พบลูกค้านี้');
    }
    if (contractId) {
      const contract = (await this.contracts.findFirst({
        where: { id: contractId, companyId },
        select: { customerId: true },
      })) as { customerId: string | null } | null;
      if (!contract) problems.push('ไม่พบสัญญานี้');
      else if (contract.customerId && contract.customerId !== customerId) {
        problems.push('สัญญานี้ไม่ใช่ของลูกค้ารายนี้');
      }
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'entitlement', reason })),
      );
    }
    return {
      kind,
      customerId,
      contractId,
      title: title.slice(0, 255),
      startOn: date(startOn),
      endOn: date(endOn),
      coverage: coverage as never,
      severityTargets:
        severityTargets === null || severityTargets === undefined
          ? Prisma.JsonNull
          : severityTargets,
      correctiveQuota: correctiveQuota ?? null,
      preventiveQuota: preventiveQuota ?? null,
      note:
        dto.note === undefined
          ? (current?.note ?? null)
          : dto.note.trim() || null,
    };
  }

  /** The customer's own assets only. */
  private async assetIds(companyId: string, customerId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = (await this.assets.findMany({
      where: { id: { in: unique }, companyId, customerId },
      select: { id: true },
    })) as { id: string }[];
    if (found.length !== unique.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'มีอุปกรณ์ที่ไม่ใช่ของลูกค้ารายนี้',
        [{ field: 'asset_ids', reason: 'not this customer' }],
      );
    }
    return unique;
  }

  private auditable(input: {
    kind: string;
    title: string;
    startOn: Date;
    endOn: Date;
    coverage: unknown;
    correctiveQuota: number | null;
    preventiveQuota: number | null;
  }) {
    return {
      kind: input.kind,
      title: input.title,
      startOn: day(input.startOn),
      endOn: day(input.endOn),
      coverage: (input.coverage as string | null) ?? null,
      correctiveQuota: input.correctiveQuota,
      preventiveQuota: input.preventiveQuota,
    };
  }

  private async write<T>(
    work: (prisma: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.transactions.execute((prisma) => work(prisma));
  }

  private async rowsFor(companyId: string, assetId: string) {
    const links = (await this.links.findMany({
      where: { assetId, removedAt: null, entitlement: { companyId } },
      include: { entitlement: true },
    })) as unknown as { entitlement: EntitlementRow }[];
    return links.map((link) => link.entitlement);
  }

  private async assetCounts(ids: string[]) {
    if (!ids.length) return new Map<string, number>();
    const rows = (await this.links.findMany({
      where: { entitlementId: { in: ids }, removedAt: null },
      select: { entitlementId: true },
    })) as { entitlementId: string }[];
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.entitlementId, (counts.get(row.entitlementId) ?? 0) + 1);
    }
    return counts;
  }

  private async customerNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length)
      return new Map<string, { id: string; code: string; name: string }>();
    const rows = (await this.customers.findMany({
      where: { id: { in: unique } },
      select: { id: true, customerCode: true, nameTh: true },
    })) as { id: string; customerCode: string; nameTh: string }[];
    return new Map(
      rows.map((row) => [
        row.id,
        { id: row.id, code: row.customerCode, name: row.nameTh },
      ]),
    );
  }

  private async requireRow(companyId: string, id: string) {
    const row = (await this.entitlements.findFirst({
      where: { id, companyId },
    })) as EntitlementRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบสิทธิ์บริการ');
    return row;
  }
}
