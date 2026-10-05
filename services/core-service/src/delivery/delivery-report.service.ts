import { Injectable } from '@nestjs/common';
import {
  AppError,
  hasPermission,
  Principal,
  PrismaService,
} from '@request-management/share';
import { thaiToday } from '../crm/vendor-costs';
import { DEFAULT_CREDIT_DAYS } from '../pm/payment-rules';
import { aging, monthsBack, onTimeRate } from './delivery-report-rules';

interface PhaseRow {
  project_id: string;
  project_no: string;
  project_name: string;
  customer_name: string | null;
  manager_name: string | null;
  milestone_id: string;
  milestone_seq: number;
  milestone_title: string;
  due_on: string | null;
  deliveries: number;
  delivered: number;
  last_delivered_on: string | null;
  rounds: number;
  phase_status: string;
  accepted_on: string | null;
  accepted_month: string | null;
  result: string | null;
  first_round_passed: boolean | null;
  on_time: boolean | null;
  days_late: number | null;
  open_items: number;
  certificate_signed: boolean;
  handover_status: string | null;
}

interface ReceivableRow {
  contract_id: string;
  contract_no: string;
  seq: number;
  label: string;
  project_id: string | null;
  project_no: string | null;
  project_name: string | null;
  customer_name: string | null;
  owner_user_id: string;
  owner_name: string | null;
  amount: number;
  invoice_no: string | null;
  invoiced_on: string;
  due_on: string;
  state: string;
  days_overdue: number | null;
}

const PHASE_COLUMNS = `project_id, project_no, project_name, customer_name,
  manager_name, milestone_id, milestone_seq, milestone_title,
  due_on::text, deliveries, delivered, last_delivered_on::text, rounds,
  phase_status, accepted_on::text, accepted_month, result, first_round_passed,
  on_time, days_late, open_items, certificate_signed, handover_status`;

/**
 * CD-256 รายงานการส่งมอบ — read from the Data Mart (`mart.fact_delivery_phases`
 * and `mart.fact_receivables`, rebuilt hourly with CD-91), the same rows
 * Metabase shows:
 *
 * - where every phase stands, and the share accepted by its milestone's due
 *   day (month by month);
 * - what is still waiting for the customer's acceptance, or for points left
 *   open by a conditional one;
 * - installments billed and past due, not yet paid — finance
 *   (`delivery.receivable.read`) sees every contract, a salesperson their own.
 *
 * Every value reaches SQL as a parameter.
 */
@Injectable()
export class DeliveryReportService {
  constructor(private readonly prisma: PrismaService) {}

  async phases(actor: Principal, from?: string, to?: string) {
    const company = await this.companyCode(actor);
    const today = thaiToday();
    const last = to ?? today.slice(0, 7);
    const first = from ?? monthsBack(last + '-01', 11);
    if (first > last) {
      throw new AppError(
        'VALIDATION_FAILED',
        'เดือนเริ่มต้องไม่หลังเดือนสิ้นสุด',
      );
    }
    const rows = await this.prisma.$queryRawUnsafe<PhaseRow[]>(
      `SELECT ${PHASE_COLUMNS} FROM mart.fact_delivery_phases
       WHERE company_code = $1 AND project_status <> 'cancelled'
       ORDER BY project_no, milestone_seq`,
      company,
    );
    const inRange = rows.filter(
      (r) =>
        r.accepted_month &&
        r.accepted_month >= first &&
        r.accepted_month <= last,
    );
    const months: string[] = [];
    for (let m = first; m <= last; m = nextMonth(m)) months.push(m);
    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      if (row.phase_status === 'accepted') continue;
      byStatus[row.phase_status] = (byStatus[row.phase_status] ?? 0) + 1;
    }
    const firstRound = inRange.filter((r) => r.first_round_passed !== null);
    return {
      from: first,
      to: last,
      refreshedAt: await this.refreshedAt('fact_delivery_phases'),
      summary: {
        accepted: inRange.length,
        ...onTimeRate(inRange.map((r) => ({ onTime: r.on_time }))),
        firstRoundPct: firstRound.length
          ? Math.round(
              (1000 * firstRound.filter((r) => r.first_round_passed).length) /
                firstRound.length,
            ) / 10
          : null,
        byStatus,
      },
      monthly: months.map((month) => ({
        month,
        ...onTimeRate(
          inRange
            .filter((r) => r.accepted_month === month)
            .map((r) => ({ onTime: r.on_time })),
        ),
      })),
      accepted: inRange.map(phase),
      pending: rows
        .filter(
          (r) =>
            r.phase_status === 'delivered' ||
            r.phase_status === 'in_acceptance' ||
            (r.phase_status !== 'accepted' && (r.days_late ?? 0) > 0),
        )
        .sort((a, b) => (b.days_late ?? -1) - (a.days_late ?? -1))
        .map(phase),
      openPoints: rows
        .filter((r) => r.phase_status === 'accepted' && r.open_items > 0)
        .map(phase),
    };
  }

  async receivables(actor: Principal) {
    const company = await this.companyCode(actor);
    const all = hasPermission(actor, 'delivery.receivable.read');
    const rows = await this.prisma.$queryRawUnsafe<ReceivableRow[]>(
      `SELECT contract_id, contract_no, seq, label, project_id, project_no,
              project_name, customer_name, owner_user_id, owner_name,
              amount::float8 AS amount, invoice_no, invoiced_on::text,
              due_on::text, state, days_overdue
       FROM mart.fact_receivables
       WHERE company_code = $1 AND state <> 'paid'
         AND ($2::boolean OR owner_user_id = $3)
       ORDER BY days_overdue DESC NULLS LAST, due_on`,
      company,
      all,
      actor.userId,
    );
    const overdue = rows.filter((r) => r.state === 'overdue');
    const open = rows.filter((r) => r.state === 'open');
    const sum = (list: ReceivableRow[]) =>
      list.reduce((s, r) => s + r.amount, 0);
    return {
      scope: all ? 'all' : 'own',
      creditDays: DEFAULT_CREDIT_DAYS,
      refreshedAt: await this.refreshedAt('fact_receivables'),
      summary: {
        overdue: { count: overdue.length, amount: sum(overdue) },
        open: { count: open.length, amount: sum(open) },
        aging: aging(
          overdue.map((r) => ({
            daysOverdue: r.days_overdue ?? 0,
            amount: r.amount,
          })),
        ),
      },
      overdue: overdue.map(receivable),
      open: open.map(receivable),
    };
  }

  private async companyCode(actor: Principal) {
    const company = await this.prisma.company.findUnique({
      where: { id: actor.activeCompanyId },
      select: { code: true },
    });
    if (!company) throw new AppError('NOT_FOUND', 'ไม่พบบริษัท');
    return company.code;
  }

  private async refreshedAt(table: string): Promise<Date | null> {
    const [row] = await this.prisma.$queryRawUnsafe<{ refreshed_at: Date }[]>(
      `SELECT refreshed_at FROM mart.refresh_log WHERE table_name = $1`,
      table,
    );
    return row?.refreshed_at ?? null;
  }
}

function nextMonth(month: string) {
  const at = new Date(`${month}-01T00:00:00Z`);
  at.setUTCMonth(at.getUTCMonth() + 1);
  return at.toISOString().slice(0, 7);
}

const phase = (r: PhaseRow) => ({
  projectId: r.project_id,
  project: `${r.project_no} · ${r.project_name}`,
  customer: r.customer_name,
  manager: r.manager_name,
  milestoneId: r.milestone_id,
  phase: `${r.milestone_seq}. ${r.milestone_title}`,
  dueOn: r.due_on,
  deliveries: r.deliveries,
  delivered: r.delivered,
  lastDeliveredOn: r.last_delivered_on,
  rounds: r.rounds,
  status: r.phase_status,
  acceptedOn: r.accepted_on,
  result: r.result,
  firstRoundPassed: r.first_round_passed,
  onTime: r.on_time,
  daysLate: r.days_late,
  openItems: r.open_items,
  certificateSigned: r.certificate_signed,
  handover: r.handover_status,
});

const receivable = (r: ReceivableRow) => ({
  contractId: r.contract_id,
  contractNo: r.contract_no,
  installment: `${r.seq}. ${r.label}`,
  projectId: r.project_id,
  project: r.project_no ? `${r.project_no} · ${r.project_name}` : null,
  customer: r.customer_name,
  owner: r.owner_name,
  amount: r.amount,
  invoiceNo: r.invoice_no,
  invoicedOn: r.invoiced_on,
  dueOn: r.due_on,
  daysOverdue: r.days_overdue,
});
