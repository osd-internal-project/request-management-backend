import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
  PrismaTransactionService,
} from '@request-management/share';
import { ContractInstallmentRepository } from '../crm/contract-installments.service';
import { bangkokDay } from '../crm/kyc-rules';
import { RecordBillingDto } from './dto/project.dto';
import {
  billingProblems,
  cashForecast,
  DEFAULT_CREDIT_DAYS,
  paymentStatus,
} from './payment-rules';
import { PlanService } from './plan.service';
import {
  InstallmentBillingRepository,
  ProjectRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';

const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);
const asDay = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;

interface BillingRow {
  seq: number;
  invoiceNo: string | null;
  invoicedOn: Date | null;
  invoicedAmount: Prisma.Decimal | null;
  paidOn: Date | null;
  paidAmount: Prisma.Decimal | null;
  source: string;
  note: string | null;
  recordedAt: Date;
}

/**
 * CD-193 ติดตามงวดชำระ — every installment of the project's contract on one
 * page: billed, paid, billable or still waiting, and late; each tied to the
 * milestone that unlocks it (CD-182, its forecast from the plan CD-178);
 * and the cash it should bring in, month by month. Billing and payment are
 * recorded here by hand until the SAP connector (CD-89) reads them.
 *
 * Who: whoever sees the project reads it; `pm.project.manage` or the
 * project's manager records billing.
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly projects: ProjectsService,
    private readonly plan: PlanService,
    private readonly projectRows: ProjectRepository,
    private readonly installments: ContractInstallmentRepository,
    private readonly billings: InstallmentBillingRepository,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  async view(projectId: string, actor: Principal, now = new Date()) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    const today = bangkokDay(now);
    const contract = (await this.projectRows.findFirst({
      where: { id: projectId },
      select: { contract: { select: { signedOn: true } } },
    })) as { contract: { signedOn: Date | null } } | null;
    const [schedule, billing, planned] = await Promise.all([
      this.installments.findMany({
        where: { contractId: project.contractId },
        orderBy: { seq: 'asc' },
        select: {
          seq: true,
          kind: true,
          label: true,
          amount: true,
          dueOn: true,
          projectMilestone: {
            select: { id: true, title: true, status: true, achievedOn: true },
          },
        },
      }) as unknown as Promise<
        {
          seq: number;
          kind: string;
          label: string;
          amount: Prisma.Decimal;
          dueOn: Date | null;
          projectMilestone: {
            id: string;
            title: string;
            status: string;
            achievedOn: Date | null;
          } | null;
        }[]
      >,
      this.billings.findMany({
        where: { contractId: project.contractId },
      }) as Promise<BillingRow[]>,
      this.plan.view(projectId, actor),
    ]);
    const forecastOf = new Map(
      planned.milestones.map((row) => [row.id, row.forecast]),
    );
    const rows = schedule.map((row) => {
      const record = billing.find((item) => item.seq === row.seq) ?? null;
      const milestone = row.projectMilestone;
      const amount = Number(row.amount);
      const status = paymentStatus(
        {
          seq: row.seq,
          kind: row.kind,
          amount,
          dueOn: day(row.dueOn),
          milestone: milestone
            ? {
                status: milestone.status,
                achievedOn: day(milestone.achievedOn),
                forecast: forecastOf.get(milestone.id) ?? null,
              }
            : null,
          billing: record
            ? {
                invoicedOn: day(record.invoicedOn),
                invoicedAmount: num(record.invoicedAmount),
                paidOn: day(record.paidOn),
                paidAmount: num(record.paidAmount),
              }
            : null,
        },
        { signed: Boolean(contract?.contract.signedOn), today },
      );
      return {
        seq: row.seq,
        kind: row.kind,
        label: row.label,
        amount,
        dueOn: day(row.dueOn),
        milestone: milestone
          ? {
              id: milestone.id,
              title: milestone.title,
              status: milestone.status,
              forecast: forecastOf.get(milestone.id) ?? null,
            }
          : null,
        ...status,
        billing: record
          ? {
              invoiceNo: record.invoiceNo,
              invoicedOn: day(record.invoicedOn),
              invoicedAmount: num(record.invoicedAmount),
              paidOn: day(record.paidOn),
              paidAmount: num(record.paidAmount),
              source: record.source,
              note: record.note,
              recordedAt: record.recordedAt,
            }
          : null,
      };
    });
    const sum = (values: number[]) =>
      Math.round(values.reduce((acc, value) => acc + value, 0) * 100) / 100;
    return {
      canEdit,
      today,
      creditDays: DEFAULT_CREDIT_DAYS,
      totals: {
        scheduled: sum(rows.map((row) => row.amount)),
        invoiced: sum(
          rows
            .filter((row) => row.state === 'invoiced' || row.state === 'paid')
            .map((row) => row.billing?.invoicedAmount ?? row.amount),
        ),
        received: sum(rows.map((row) => row.received)),
        outstanding: sum(
          rows.filter((row) => row.state !== 'paid').map((row) => row.amount),
        ),
        overdue: sum(
          rows.filter((row) => row.overdue).map((row) => row.amount),
        ),
        billable: sum(
          rows
            .filter((row) => row.state === 'billable')
            .map((row) => row.amount),
        ),
      },
      installments: rows,
      forecast: cashForecast(rows),
    };
  }

  /** Billed and/or paid, recorded by hand until SAP reads it. */
  async record(
    projectId: string,
    seq: number,
    dto: RecordBillingDto,
    actor: Principal,
    now = new Date(),
  ) {
    const { project, canEdit } = await this.projects.access(projectId, actor);
    if (!canEdit) {
      throw new AppError(
        'FORBIDDEN',
        'บันทึกการวางบิลได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const installment = await this.installments.count({
      where: { contractId: project.contractId, seq },
    });
    if (!installment) throw new AppError('NOT_FOUND', 'ไม่พบงวดนี้ในสัญญา');
    const input = {
      invoicedOn: dto.invoiced_on?.slice(0, 10) ?? null,
      invoicedAmount: dto.invoiced_amount ?? null,
      paidOn: dto.paid_on?.slice(0, 10) ?? null,
      paidAmount: dto.paid_amount ?? null,
      today: bangkokDay(now),
    };
    const problems = billingProblems(input);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'billing', reason })),
      );
    }
    const data = {
      invoiceNo: dto.invoice_no?.trim() || null,
      invoicedOn: asDay(input.invoicedOn),
      invoicedAmount: input.invoicedAmount,
      paidOn: asDay(input.paidOn),
      paidAmount: input.paidAmount,
      note: dto.note?.trim() || null,
      source: 'manual',
      recordedBy: actor.userId,
    };
    await this.transactions.execute(async (prisma) => {
      await prisma.contractInstallmentBilling.upsert({
        where: { contractId_seq: { contractId: project.contractId, seq } },
        create: {
          companyId: project.companyId,
          contractId: project.contractId,
          seq,
          ...data,
        },
        update: { ...data, recordedAt: now },
      });
      await this.audit.record(
        {
          eventType: 'pm.installment.billing_recorded',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'customer_contract',
          resourceId: project.contractId,
          after: { seq, ...input, invoiceNo: data.invoiceNo },
        },
        { prisma },
      );
    });
    return this.view(projectId, actor, now);
  }
}
