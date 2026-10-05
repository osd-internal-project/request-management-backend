import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { CustomerRepository } from '../crm/customer.repository';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestRepository } from '../requests/request.repository';
import {
  matchingProblems,
  PROBLEM_OPEN,
  problemStepProblems,
  repeatGroups,
  scopeProblems,
  stillDismissed,
  type JobFact,
} from './problem-rules';
import {
  DismissGroupDto,
  LinkProblemJobsDto,
  ListProblemsQueryDto,
  OpenProblemDto,
  UpdateProblemDto,
} from './support.dto';
import {
  ServiceAssetRepository,
  ServiceProblemDismissalRepository,
  ServiceProblemLinkRepository,
  ServiceProblemRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';

interface ProblemRow {
  id: string;
  companyId: string;
  problemNo: string;
  title: string;
  scope: string;
  assetId: string | null;
  productCode: string | null;
  customerId: string | null;
  ownerUserId: string;
  status: string;
  workaround: string | null;
  rootCause: string | null;
  permanentFix: string | null;
  techChangeRef: string | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

interface OrderRow {
  id: string;
  requestId: string;
  assetId: string | null;
  customerId: string | null;
  workKind: string;
  createdAt: Date;
}

const DAY_MS = 86_400_000;
const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * CD-246 ปัญหาที่เกิดซ้ำ — repeated faults gathered into a problem and worked
 * to its root cause:
 *
 * - suggestions: corrective jobs inside the company's window, not yet under
 *   a problem, counted per unit, per model and per model at a customer
 *   against the thresholds in CRM settings; a person makes the problem (or
 *   dismisses the group until it grows);
 * - a problem: its scope, owner, jobs; open → investigating → known error
 *   (a workaround the technicians can use now) → resolved (root cause and
 *   permanent fix, a technical change by reference — CD-224) → closed;
 * - a new job matching an open problem says so on its panel, with the
 *   workaround, and is linked by a person.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` writes.
 */
@Injectable()
export class ProblemsService {
  constructor(
    private readonly problems: ServiceProblemRepository,
    private readonly links: ServiceProblemLinkRepository,
    private readonly dismissals: ServiceProblemDismissalRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly assets: ServiceAssetRepository,
    private readonly requestRows: RequestRepository,
    private readonly customers: CustomerRepository,
    private readonly configs: CrmConfigRepository,
    private readonly people: CompanyMemberRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** Groups of repeated corrective jobs that look like one problem. */
  async suggestions(actor: Principal, now = new Date()) {
    const companyId = actor.activeCompanyId;
    const limits = await this.limits(companyId);
    const jobs = await this.unlinkedJobs(
      companyId,
      new Date(now.getTime() - limits.days * DAY_MS),
    );
    const dismissed = new Map(
      (
        (await this.dismissals.findMany({
          where: { companyId },
          select: { groupKey: true, size: true },
        })) as { groupKey: string; size: number }[]
      ).map((row) => [row.groupKey, row.size]),
    );
    const groups = repeatGroups(jobs, limits).filter(
      (group) => !stillDismissed(group, dismissed),
    );
    const views = await this.jobViews(companyId, [
      ...new Set(groups.flatMap((group) => group.jobIds)),
    ]);
    const [assetNames, customerNames] = await Promise.all([
      this.assetNames(groups.flatMap((g) => (g.assetId ? [g.assetId] : []))),
      this.customerNames(
        groups.flatMap((g) => (g.customerId ? [g.customerId] : [])),
      ),
    ]);
    return {
      days: limits.days,
      groups: groups.map((group) => ({
        ...group,
        asset: group.assetId ? (assetNames.get(group.assetId) ?? null) : null,
        customer: group.customerId
          ? (customerNames.get(group.customerId) ?? null)
          : null,
        jobs: group.jobIds.flatMap((id) => {
          const view = views.get(id);
          return view ? [view] : [];
        }),
      })),
    };
  }

  /** Not one problem — hidden until the group grows past this size. */
  async dismiss(actor: Principal, dto: DismissGroupDto) {
    const companyId = actor.activeCompanyId;
    await this.dismissals.upsert({
      where: { companyId_groupKey: { companyId, groupKey: dto.group_key } },
      create: {
        companyId,
        groupKey: dto.group_key,
        size: dto.size,
        dismissedBy: actor.userId,
      },
      update: {
        size: dto.size,
        dismissedBy: actor.userId,
        dismissedAt: new Date(),
      },
    });
    return { groupKey: dto.group_key };
  }

  async open(actor: Principal, dto: OpenProblemDto) {
    const companyId = actor.activeCompanyId;
    const scope = {
      scope: dto.scope,
      assetId: dto.asset_id ?? null,
      productCode: dto.product_code?.trim() || null,
      customerId: dto.customer_id ?? null,
    };
    const problems = scopeProblems(scope);
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    if (!(await this.requestRows.findReceiver(dto.owner_user_id, companyId))) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้รับผิดชอบในบริษัทนี้');
    }
    const jobIds = await this.assertLinkable(
      companyId,
      dto.work_order_ids ?? [],
    );
    const count = await this.problems.count({ where: { companyId } });
    const problemNo = `PRB-${String(count + 1).padStart(6, '0')}`;
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceProblem.create({
        data: {
          companyId,
          problemNo,
          title: dto.title.trim(),
          ...scope,
          ownerUserId: dto.owner_user_id,
          createdBy: actor.userId,
        },
        select: { id: true },
      });
      if (jobIds.length) {
        await prisma.serviceProblemLink.createMany({
          data: jobIds.map((workOrderId) => ({
            problemId: created.id,
            workOrderId,
            linkedBy: actor.userId,
          })),
        });
      }
      await this.audit.record(
        {
          eventType: 'service.problem.opened',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_problem',
          resourceId: created.id,
          after: { problemNo, ...scope, jobs: jobIds.length },
        },
        { prisma },
      );
      return created;
    });
    return this.detail(actor, row.id);
  }

  /** Fields and, optionally, the next status. */
  async update(actor: Principal, id: string, dto: UpdateProblemDto) {
    const before = await this.require(actor.activeCompanyId, id);
    const facts = {
      workaround:
        dto.workaround === undefined ? before.workaround : dto.workaround,
      rootCause:
        dto.root_cause === undefined ? before.rootCause : dto.root_cause,
      permanentFix:
        dto.permanent_fix === undefined
          ? before.permanentFix
          : dto.permanent_fix,
    };
    if (dto.status && dto.status !== before.status) {
      const problems = problemStepProblems(before.status, dto.status, facts);
      if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    }
    if (
      dto.owner_user_id &&
      !(await this.requestRows.findReceiver(
        dto.owner_user_id,
        before.companyId,
      ))
    ) {
      throw new AppError('NOT_FOUND', 'ไม่พบผู้รับผิดชอบในบริษัทนี้');
    }
    const status = dto.status ?? before.status;
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceProblem.update({
        where: { id },
        data: {
          ...(dto.title !== undefined ? { title: dto.title.trim() } : {}),
          ...(dto.owner_user_id ? { ownerUserId: dto.owner_user_id } : {}),
          workaround: facts.workaround?.trim() || null,
          rootCause: facts.rootCause?.trim() || null,
          permanentFix: facts.permanentFix?.trim() || null,
          ...(dto.tech_change_ref !== undefined
            ? { techChangeRef: dto.tech_change_ref?.trim() || null }
            : {}),
          status,
          ...(status === 'resolved' && before.status !== 'resolved'
            ? { resolvedAt: new Date() }
            : {}),
          ...(status === 'closed' ? { closedAt: new Date() } : {}),
          updatedBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.problem.updated',
          companyId: before.companyId,
          ...auditActor(actor),
          resourceType: 'service_problem',
          resourceId: id,
          before: { status: before.status },
          after: { ...dto },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  /** More jobs under the problem (each job under one problem at most). */
  async link(actor: Principal, id: string, dto: LinkProblemJobsDto) {
    const problem = await this.require(actor.activeCompanyId, id);
    if (problem.status === 'closed') {
      throw new AppError('CONFLICT', 'ปัญหานี้ปิดแล้ว');
    }
    const jobIds = await this.assertLinkable(
      actor.activeCompanyId,
      dto.work_order_ids,
    );
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceProblemLink.createMany({
        data: jobIds.map((workOrderId) => ({
          problemId: id,
          workOrderId,
          linkedBy: actor.userId,
        })),
      });
      await this.audit.record(
        {
          eventType: 'service.problem.linked',
          companyId: problem.companyId,
          ...auditActor(actor),
          resourceType: 'service_problem',
          resourceId: id,
          after: { workOrderIds: jobIds },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  async unlink(actor: Principal, id: string, workOrderId: string) {
    const problem = await this.require(actor.activeCompanyId, id);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceProblemLink.deleteMany({
        where: { problemId: id, workOrderId },
      });
      await this.audit.record(
        {
          eventType: 'service.problem.unlinked',
          companyId: problem.companyId,
          ...auditActor(actor),
          resourceType: 'service_problem',
          resourceId: id,
          before: { workOrderId },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  async list(actor: Principal, query: ListProblemsQueryDto) {
    const rows = (await this.problems.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(query.state === 'open'
          ? { status: { in: PROBLEM_OPEN } }
          : query.state === 'resolved'
            ? { status: { in: ['resolved', 'closed'] } }
            : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: 300,
    })) as ProblemRow[];
    const counts = new Map<string, number>();
    for (const link of (await this.links.findMany({
      where: { problemId: { in: rows.map((row) => row.id) } },
      select: { problemId: true },
    })) as { problemId: string }[]) {
      counts.set(link.problemId, (counts.get(link.problemId) ?? 0) + 1);
    }
    const views = await this.views(rows);
    return views.map((view) => ({
      ...view,
      jobCount: counts.get(view.id) ?? 0,
    }));
  }

  async detail(actor: Principal, id: string) {
    const row = await this.require(actor.activeCompanyId, id);
    const [view] = await this.views([row]);
    const jobIds = (
      (await this.links.findMany({
        where: { problemId: id },
        select: { workOrderId: true },
        orderBy: { linkedAt: 'asc' },
      })) as { workOrderId: string }[]
    ).map((link) => link.workOrderId);
    const jobs = await this.jobViews(row.companyId, jobIds);
    return {
      ...view,
      jobs: jobIds.flatMap((jobId) => {
        const job = jobs.get(jobId);
        return job ? [job] : [];
      }),
    };
  }

  /** A job's problem, and the open ones it matches (with their workarounds). */
  async forWorkOrder(actor: Principal, workOrderId: string) {
    const companyId = actor.activeCompanyId;
    const order = (await this.orders.findFirst({
      where: { id: workOrderId, companyId },
    })) as OrderRow | null;
    if (!order) throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบริการ');
    const link = (await this.links.findFirst({
      where: { workOrderId },
      select: { problemId: true },
    })) as { problemId: string } | null;
    const fact = (await this.facts([order]))[0];
    const open = (await this.problems.findMany({
      where: { companyId, status: { in: PROBLEM_OPEN } },
    })) as ProblemRow[];
    const matches = matchingProblems(fact, open).filter(
      (problem) => problem.id !== link?.problemId,
    );
    const linked = link
      ? ((await this.problems.findFirst({
          where: { id: link.problemId },
        })) as ProblemRow | null)
      : null;
    const views = await this.views([...(linked ? [linked] : []), ...matches]);
    return {
      linked: linked ? views[0] : null,
      matches: linked ? views.slice(1) : views,
    };
  }

  // --- helpers ---------------------------------------------------------------

  private async limits(companyId: string) {
    const row = (await this.configs.findFirst({
      where: { companyId },
      select: {
        serviceRepeatDays: true,
        serviceRepeatAsset: true,
        serviceRepeatModel: true,
        serviceRepeatCustomerModel: true,
      },
    })) as {
      serviceRepeatDays: number;
      serviceRepeatAsset: number;
      serviceRepeatModel: number;
      serviceRepeatCustomerModel: number;
    } | null;
    return {
      days: row?.serviceRepeatDays ?? 90,
      asset: row?.serviceRepeatAsset ?? 3,
      model: row?.serviceRepeatModel ?? 5,
      customerModel: row?.serviceRepeatCustomerModel ?? 3,
    };
  }

  /** Corrective jobs since `since`, not yet under a problem. */
  private async unlinkedJobs(companyId: string, since: Date) {
    const rows = (await this.orders.findMany({
      where: { companyId, workKind: 'corrective', createdAt: { gte: since } },
      take: 5000,
    })) as OrderRow[];
    const linked = new Set(
      (
        (await this.links.findMany({
          where: { workOrderId: { in: rows.map((row) => row.id) } },
          select: { workOrderId: true },
        })) as { workOrderId: string }[]
      ).map((row) => row.workOrderId),
    );
    return this.facts(rows.filter((row) => !linked.has(row.id)));
  }

  /** Each job with its asset's model (SAP item code). */
  private async facts(rows: OrderRow[]): Promise<JobFact[]> {
    const models = new Map(
      (
        (await this.assets.findMany({
          where: {
            id: {
              in: rows.flatMap((row) => (row.assetId ? [row.assetId] : [])),
            },
          },
          select: { id: true, productCode: true },
        })) as { id: string; productCode: string | null }[]
      ).map((asset) => [asset.id, asset.productCode]),
    );
    return rows.map((row) => ({
      id: row.id,
      assetId: row.assetId,
      productCode: row.assetId ? (models.get(row.assetId) ?? null) : null,
      customerId: row.customerId,
    }));
  }

  private async assertLinkable(companyId: string, ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const found = (await this.orders.findMany({
      where: { id: { in: unique }, companyId },
      select: { id: true },
    })) as { id: string }[];
    if (found.length !== unique.length) {
      throw new AppError('NOT_FOUND', 'ไม่พบใบสั่งงานบางใบ');
    }
    const taken = await this.links.count({
      where: { workOrderId: { in: unique } },
    });
    if (taken) {
      throw new AppError('CONFLICT', 'มีใบสั่งงานที่ผูกกับปัญหาอื่นอยู่แล้ว');
    }
    return unique;
  }

  private async jobViews(companyId: string, ids: string[]) {
    if (!ids.length) return new Map<string, ReturnType<typeof jobView>>();
    const rows = (await this.orders.findMany({
      where: { id: { in: ids }, companyId },
    })) as (OrderRow & { cause: string | null; resolution: string | null })[];
    const [cases, assetNames, customerNames] = await Promise.all([
      this.requestRows.findMany({
        where: { id: { in: rows.map((row) => row.requestId) } },
        select: { id: true, requestNo: true, status: true, formData: true },
      }) as Promise<
        {
          id: string;
          requestNo: string | null;
          status: string;
          formData: unknown;
        }[]
      >,
      this.assetNames(
        rows.flatMap((row) => (row.assetId ? [row.assetId] : [])),
      ),
      this.customerNames(
        rows.flatMap((row) => (row.customerId ? [row.customerId] : [])),
      ),
    ]);
    const caseById = new Map(cases.map((row) => [row.id, row]));
    return new Map(
      rows.map((row) => [
        row.id,
        jobView(
          row,
          caseById.get(row.requestId),
          row.assetId ? (assetNames.get(row.assetId) ?? null) : null,
          row.customerId ? (customerNames.get(row.customerId) ?? null) : null,
        ),
      ]),
    );
  }

  private async views(rows: ProblemRow[]) {
    const [assetNames, customerNames, names] = await Promise.all([
      this.assetNames(
        rows.flatMap((row) => (row.assetId ? [row.assetId] : [])),
      ),
      this.customerNames(
        rows.flatMap((row) => (row.customerId ? [row.customerId] : [])),
      ),
      this.names(rows.map((row) => row.ownerUserId)),
    ]);
    return rows.map((row) => ({
      id: row.id,
      problemNo: row.problemNo,
      title: row.title,
      scope: row.scope,
      assetId: row.assetId,
      asset: row.assetId ? (assetNames.get(row.assetId) ?? null) : null,
      productCode: row.productCode,
      customerId: row.customerId,
      customer: row.customerId
        ? (customerNames.get(row.customerId) ?? null)
        : null,
      ownerUserId: row.ownerUserId,
      ownerName: names.get(row.ownerUserId) ?? row.ownerUserId,
      status: row.status,
      workaround: row.workaround,
      rootCause: row.rootCause,
      permanentFix: row.permanentFix,
      techChangeRef: row.techChangeRef,
      resolvedAt: iso(row.resolvedAt),
      closedAt: iso(row.closedAt),
      createdAt: row.createdAt.toISOString(),
    }));
  }

  private async assetNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.assets.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true, serialNo: true },
    })) as { id: string; name: string; serialNo: string | null }[];
    return new Map(
      rows.map((row) => [
        row.id,
        [row.name, row.serialNo].filter(Boolean).join(' · '),
      ]),
    );
  }

  private async customerNames(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = (await this.customers.findMany({
      where: { id: { in: unique } },
      select: { id: true, customerCode: true, nameTh: true },
    })) as { id: string; customerCode: string; nameTh: string }[];
    return new Map(
      rows.map((row) => [row.id, `${row.customerCode} · ${row.nameTh}`]),
    );
  }

  private async require(companyId: string, id: string) {
    const row = (await this.problems.findFirst({
      where: { id, companyId },
    })) as ProblemRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบปัญหาที่ระบุ');
    return row;
  }

  private async names(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

function jobView(
  row: OrderRow & { cause: string | null; resolution: string | null },
  request:
    { requestNo: string | null; status: string; formData: unknown } | undefined,
  asset: string | null,
  customer: string | null,
) {
  const form = (request?.formData ?? {}) as { subject?: unknown };
  return {
    workOrderId: row.id,
    requestId: row.requestId,
    requestNo: request?.requestNo ?? null,
    status: request?.status ?? null,
    subject: typeof form.subject === 'string' ? form.subject : '',
    asset,
    customer,
    cause: row.cause,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
  };
}
