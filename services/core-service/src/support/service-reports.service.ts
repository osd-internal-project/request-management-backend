import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  OBJECT_STORAGE,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import type { ObjectStorage } from '@request-management/share';
import { randomUUID } from 'node:crypto';
import { ContractTermsRepository } from '../crm/contract-terms.service';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { CustomerRepository } from '../crm/customer.repository';
import { CompanyRepository } from '../crm/product.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { RequestRepository } from '../requests/request.repository';
import { serviceReportPdf } from './service-report-pdf';
import {
  lateHours,
  penaltyEstimate,
  periodProblems,
  resolutionOutcome,
  responseOutcome,
  slaFigures,
  type JobClock,
} from './service-report-rules';
import {
  IssueServiceReportDto,
  MarkReportSentDto,
  ServiceReportPreviewDto,
} from './support.dto';
import {
  ServiceEntitlementRepository,
  ServicePmRoundRepository,
  ServiceReportRepository,
  ServiceSlaClockRepository,
  ServiceWorkOrderRepository,
} from './support.repositories';

interface EntitlementRow {
  id: string;
  companyId: string;
  customerId: string;
  contractId: string | null;
  kind: string;
  title: string;
  startOn: Date;
  endOn: Date;
  coverage: string | null;
  severityTargets: unknown;
}

interface ReportRow {
  id: string;
  companyId: string;
  entitlementId: string;
  customerId: string;
  reportNo: string;
  periodFrom: Date;
  periodTo: Date;
  data: unknown;
  penaltyAmount: Prisma.Decimal | null;
  penaltyNote: string | null;
  pdfKey: string;
  issuedAt: Date;
  issuedBy: string;
  sentOn: Date | null;
  sentTo: string | null;
}

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);
const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);

/**
 * CD-247 รายงานผลบริการ — one cover (a service contract or a warranty) over
 * one period: its jobs measured against the levels committed (response and
 * resolution apart, from the SLA clocks — CD-240), the jobs that missed, its
 * PM rounds (CD-244), and the penalty its contract's terms (CD-154) put on
 * the misses — an estimate a person confirms. Viewed live; issued, its
 * figures are frozen with a PDF on the company's letterhead, and when it was
 * sent to the customer is recorded.
 *
 * Who: `service.asset.read` reads; `service.asset.manage` issues and sends.
 */
@Injectable()
export class ServiceReportsService {
  constructor(
    private readonly reports: ServiceReportRepository,
    private readonly entitlements: ServiceEntitlementRepository,
    private readonly orders: ServiceWorkOrderRepository,
    private readonly clocks: ServiceSlaClockRepository,
    private readonly rounds: ServicePmRoundRepository,
    private readonly requestRows: RequestRepository,
    private readonly customers: CustomerRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly terms: ContractTermsRepository,
    private readonly companies: CompanyRepository,
    private readonly configs: CrmConfigRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  /** The period's figures, live. */
  async preview(
    actor: Principal,
    dto: ServiceReportPreviewDto,
    now = new Date(),
  ) {
    const problems = periodProblems(dto.from, dto.to);
    if (problems.length) throw new AppError('VALIDATION_FAILED', problems[0]);
    const entitlement = await this.requireEntitlement(
      actor.activeCompanyId,
      dto.entitlement_id,
    );
    const from = asDate(dto.from);
    const toEnd = new Date(asDate(dto.to).getTime() + 86_400_000);

    const orders = (await this.orders.findMany({
      where: {
        companyId: entitlement.companyId,
        entitlementId: entitlement.id,
        createdAt: { gte: from, lt: toEnd },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, requestId: true, workKind: true, createdAt: true },
    })) as {
      id: string;
      requestId: string;
      workKind: string;
      createdAt: Date;
    }[];
    const requestIds = orders.map((row) => row.requestId);
    const [cases, clocks] = await Promise.all([
      this.requestRows.findMany({
        where: { id: { in: requestIds } },
        select: {
          id: true,
          requestNo: true,
          status: true,
          severity: true,
          completedAt: true,
          formData: true,
        },
      }) as Promise<
        {
          id: string;
          requestNo: string | null;
          status: string;
          severity: string | null;
          completedAt: Date | null;
          formData: unknown;
        }[]
      >,
      this.clocks.findMany({
        where: { requestId: { in: requestIds } },
      }) as Promise<
        {
          requestId: string;
          dueAt: Date;
          breachedAt: Date | null;
          responseDueAt: Date | null;
          respondedAt: Date | null;
          responseBreachedAt: Date | null;
        }[]
      >,
    ]);
    const caseById = new Map(cases.map((row) => [row.id, row]));
    const clockById = new Map(clocks.map((row) => [row.requestId, row]));
    const jobs = orders.flatMap((order) => {
      const request = caseById.get(order.requestId);
      if (!request) return [];
      const clock = clockById.get(order.requestId);
      const facts: JobClock = {
        severity: request.severity,
        status: request.status,
        doneAt: request.completedAt,
        responseDueAt: clock?.responseDueAt ?? null,
        respondedAt: clock?.respondedAt ?? null,
        responseBreachedAt: clock?.responseBreachedAt ?? null,
        dueAt: clock?.dueAt ?? null,
        breachedAt: clock?.breachedAt ?? null,
      };
      const form = (request.formData ?? {}) as { subject?: unknown };
      return [
        {
          facts,
          view: {
            requestId: request.id,
            requestNo: request.requestNo,
            subject: typeof form.subject === 'string' ? form.subject : '',
            severity: request.severity,
            workKind: order.workKind,
            status: request.status,
            openedAt: order.createdAt.toISOString(),
            respondedAt: clock?.respondedAt?.toISOString() ?? null,
            doneAt: request.completedAt?.toISOString() ?? null,
            response: responseOutcome(facts, now),
            resolution: resolutionOutcome(facts, now),
            lateHours: lateHours(facts, now),
          },
        },
      ];
    });

    const roundRows = (await this.rounds.findMany({
      where: {
        entitlementId: entitlement.id,
        dueOn: { gte: from, lt: toEnd },
      },
      orderBy: { roundNo: 'asc' },
      select: { roundNo: true, dueOn: true, status: true },
    })) as { roundNo: number; dueOn: Date; status: string }[];
    const todayIso = now.toISOString().slice(0, 10);
    const pm = {
      due: roundRows.length,
      done: roundRows.filter((r) => r.status === 'done').length,
      skipped: roundRows.filter((r) => r.status === 'skipped').length,
      overdue: roundRows.filter(
        (r) =>
          !['done', 'skipped'].includes(r.status) && day(r.dueOn)! < todayIso,
      ).length,
      rounds: roundRows.map((r) => ({
        roundNo: r.roundNo,
        dueOn: day(r.dueOn),
        status: r.status,
      })),
    };

    const [customer, contract, contractTerms] = await Promise.all([
      this.customers.findFirst({
        where: { id: entitlement.customerId },
        select: { customerCode: true, nameTh: true },
      }) as Promise<{ customerCode: string; nameTh: string } | null>,
      entitlement.contractId
        ? (this.contracts.findFirst({
            where: { id: entitlement.contractId },
            select: { contractNo: true, title: true, value: true },
          }) as Promise<{
            contractNo: string;
            title: string;
            value: Prisma.Decimal | null;
          } | null>)
        : Promise.resolve(null),
      entitlement.contractId
        ? (this.terms.findFirst({
            where: { contractId: entitlement.contractId },
            select: {
              penaltyRatePct: true,
              penaltyPeriod: true,
              penaltyBasis: true,
              penaltyCapPct: true,
              penaltyCapAmount: true,
            },
          }) as Promise<{
            penaltyRatePct: Prisma.Decimal | null;
            penaltyPeriod: string | null;
            penaltyBasis: string | null;
            penaltyCapPct: Prisma.Decimal | null;
            penaltyCapAmount: Prisma.Decimal | null;
          } | null>)
        : Promise.resolve(null),
    ]);
    const penaltyTerms = {
      ratePct: num(contractTerms?.penaltyRatePct ?? null),
      period: contractTerms?.penaltyPeriod ?? null,
      basis: contractTerms?.penaltyBasis ?? null,
      capPct: num(contractTerms?.penaltyCapPct ?? null),
      capAmount: num(contractTerms?.penaltyCapAmount ?? null),
      contractValue: num(contract?.value ?? null),
    };
    const misses = jobs
      .filter((job) => job.view.resolution === 'missed')
      .map((job) => ({ lateHours: job.view.lateHours }));
    const basisAmount =
      dto.basis_amount ??
      (penaltyTerms.basis === 'contract_value'
        ? penaltyTerms.contractValue
        : null);

    return {
      entitlement: {
        id: entitlement.id,
        title: entitlement.title,
        kind: entitlement.kind,
        coverage: entitlement.coverage,
        startOn: day(entitlement.startOn),
        endOn: day(entitlement.endOn),
        severityTargets: entitlement.severityTargets ?? null,
      },
      customer: customer
        ? {
            id: entitlement.customerId,
            code: customer.customerCode,
            name: customer.nameTh,
          }
        : null,
      contract: contract
        ? { contractNo: contract.contractNo, title: contract.title }
        : null,
      period: { from: dto.from, to: dto.to },
      generatedAt: now.toISOString(),
      figures: slaFigures(
        jobs.map((job) => job.facts),
        now,
      ),
      jobs: jobs.map((job) => job.view),
      pm,
      penalty: {
        terms: penaltyTerms,
        basisAmount,
        estimate: penaltyEstimate(penaltyTerms, basisAmount, misses),
      },
    };
  }

  /** Frozen: the figures as they are now, the PDF, the penalty confirmed. */
  async issue(actor: Principal, dto: IssueServiceReportDto) {
    const companyId = actor.activeCompanyId;
    const data = await this.preview(actor, dto);
    const count = await this.reports.count({ where: { companyId } });
    const reportNo = `SVR-${String(count + 1).padStart(6, '0')}`;
    const [company, letterhead] = await Promise.all([
      this.companies.findFirst({
        where: { id: companyId },
        select: { name: true },
      }) as Promise<{ name: string } | null>,
      this.configs.findFirst({
        where: { companyId },
        select: { letterheadNameTh: true },
      }) as Promise<{ letterheadNameTh: string | null } | null>,
    ]);
    const penaltyAmount =
      dto.penalty_amount === undefined ? null : dto.penalty_amount;
    const pdf = await serviceReportPdf({
      companyName: letterhead?.letterheadNameTh || company?.name || '',
      reportNo,
      customerName: data.customer
        ? `${data.customer.code} · ${data.customer.name}`
        : '—',
      coverTitle: data.entitlement.title,
      contractNo: data.contract?.contractNo ?? null,
      periodFrom: dto.from,
      periodTo: dto.to,
      coverage: data.entitlement.coverage,
      figures: data.figures,
      missed: data.jobs
        .filter((job) => job.resolution === 'missed')
        .map((job) => ({
          requestNo: job.requestNo,
          subject: job.subject,
          severity: job.severity,
          lateHours: job.lateHours,
        })),
      pm: data.pm,
      penaltyAmount,
      penaltyNote: dto.penalty_note?.trim() || null,
    });
    const pdfKey = `service-reports/${companyId}/${reportNo}-${randomUUID().slice(0, 8)}.pdf`;
    await this.storage.put(pdfKey, pdf, {
      contentType: 'application/pdf',
      size: pdf.length,
    });
    const row = await this.transactions.execute(async (prisma) => {
      const created = await prisma.serviceReport.create({
        data: {
          companyId,
          entitlementId: dto.entitlement_id,
          customerId: data.customer?.id ?? '',
          reportNo,
          periodFrom: asDate(dto.from),
          periodTo: asDate(dto.to),
          data: data as unknown as Prisma.InputJsonValue,
          penaltyAmount,
          penaltyNote: dto.penalty_note?.trim() || null,
          pdfKey,
          issuedBy: actor.userId,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          eventType: 'service.report.issued',
          companyId,
          ...auditActor(actor),
          resourceType: 'service_report',
          resourceId: created.id,
          after: {
            reportNo,
            entitlementId: dto.entitlement_id,
            from: dto.from,
            to: dto.to,
            penaltyAmount,
            penaltyEstimate: data.penalty.estimate.amount,
          },
        },
        { prisma },
      );
      return created;
    });
    return this.detail(actor, row.id);
  }

  async list(actor: Principal, entitlementId?: string) {
    const rows = (await this.reports.findMany({
      where: {
        companyId: actor.activeCompanyId,
        ...(entitlementId ? { entitlementId } : {}),
      },
      orderBy: [{ issuedAt: 'desc' }],
      take: 300,
    })) as ReportRow[];
    return rows.map((row) => this.view(row, false));
  }

  async detail(actor: Principal, id: string) {
    return this.view(await this.require(actor.activeCompanyId, id), true);
  }

  async file(actor: Principal, id: string) {
    const row = await this.require(actor.activeCompanyId, id);
    return {
      stream: await this.storage.get(row.pdfKey),
      fileName: `${row.reportNo}.pdf`,
    };
  }

  async markSent(actor: Principal, id: string, dto: MarkReportSentDto) {
    const row = await this.require(actor.activeCompanyId, id);
    await this.transactions.execute(async (prisma) => {
      await prisma.serviceReport.update({
        where: { id },
        data: {
          sentOn: asDate(dto.sent_on),
          sentTo: dto.sent_to.trim(),
          sentBy: actor.userId,
        },
      });
      await this.audit.record(
        {
          eventType: 'service.report.sent',
          companyId: row.companyId,
          ...auditActor(actor),
          resourceType: 'service_report',
          resourceId: id,
          after: { sentOn: dto.sent_on, sentTo: dto.sent_to.trim() },
        },
        { prisma },
      );
    });
    return this.detail(actor, id);
  }

  // --- helpers ---------------------------------------------------------------

  private view(row: ReportRow, withData: boolean) {
    const data = row.data as {
      entitlement?: { title?: string };
      customer?: { code: string; name: string } | null;
      figures?: {
        severity: string;
        responsePct: number | null;
        resolutionPct: number | null;
        jobs: number;
      }[];
    };
    const total = data.figures?.find((f) => f.severity === 'all') ?? null;
    return {
      id: row.id,
      reportNo: row.reportNo,
      entitlementId: row.entitlementId,
      entitlementTitle: data.entitlement?.title ?? '',
      customer: data.customer ?? null,
      periodFrom: day(row.periodFrom),
      periodTo: day(row.periodTo),
      jobs: total?.jobs ?? 0,
      responsePct: total?.responsePct ?? null,
      resolutionPct: total?.resolutionPct ?? null,
      penaltyAmount: num(row.penaltyAmount),
      penaltyNote: row.penaltyNote,
      issuedAt: row.issuedAt.toISOString(),
      sentOn: day(row.sentOn),
      sentTo: row.sentTo,
      ...(withData ? { data: row.data } : {}),
    };
  }

  private async requireEntitlement(companyId: string, id: string) {
    const row = (await this.entitlements.findFirst({
      where: { id, companyId },
    })) as EntitlementRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบสิทธิ์บริการ');
    return row;
  }

  private async require(companyId: string, id: string) {
    const row = (await this.reports.findFirst({
      where: { id, companyId },
    })) as ReportRow | null;
    if (!row) throw new AppError('NOT_FOUND', 'ไม่พบรายงาน');
    return row;
  }
}
