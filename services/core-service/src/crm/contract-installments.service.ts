import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  Principal,
  PrismaService,
  PrismaTransactionService,
  type TQueryClient,
} from '@request-management/share';
import { contractVisibleWhere } from './contract-visibility';
import { CustomerContractRepository } from './contract.repositories';
import {
  balanceOf,
  KIND_LABEL,
  paymentTermsCheck,
  scheduleProblems,
  shareOf,
} from './contract-installments';
import { SaveInstallmentsDto } from './dto/legal-contract.dto';

/** CD-164 งวดวางบิลของสัญญา. */
@Injectable()
export class ContractInstallmentRepository extends BaseRepository<
  PrismaService['contractInstallment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractInstallment;
  }
}

type Money = { toString(): string } | null;

interface ContractRef {
  id: string;
  companyId: string;
  contractNo: string;
  value: Money;
  currency: string;
  signedOn: Date | null;
  project: { id: string; projectNo: string } | null;
}

interface InstallmentRow {
  id: string;
  seq: number;
  kind: string;
  label: string;
  amount: Money;
  dueOn: Date | null;
  dueNote: string | null;
  milestone: string | null;
  guaranteeType: string | null;
  guaranteeAmount: Money;
  guaranteeRef: string | null;
  guaranteeExpiresOn: Date | null;
  /** CD-182 — the project milestone that unlocks it. */
  projectMilestone?: {
    id: string;
    title: string;
    status: string;
    criteria: unknown;
    dueOn: Date | null;
    achievedOn: Date | null;
  } | null;
}

const MILESTONE_SELECT = {
  select: {
    id: true,
    title: true,
    status: true,
    criteria: true,
    dueOn: true,
    achievedOn: true,
  },
} as const;

const num = (value: Money) =>
  value === null ? null : Number(value.toString());
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;
const asDay = (value: string | null | undefined) =>
  value ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
const text = (value: string | null | undefined) => value?.trim() || null;

/**
 * CD-164 — แผนการวางบิลตามงวด. Legal lays out every payment of a contract,
 * from the deposit through progress installments to the retention, each with
 * its amount, when it is billed and the milestone that unlocks it. The
 * schedule is saved whole, and only when it adds up to the contract value to
 * the satang; a deposit carries the guarantee issued against it.
 *
 * CD-152 — each payment is checked against the project milestone tied to it
 * (CD-182): measurable, due in time, billable once achieved. Billing goes to SAP
 * later — this is the plan it will bill from.
 */
@Injectable()
export class ContractInstallmentsService {
  constructor(
    private readonly installments: ContractInstallmentRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  async view(contractId: string, actor: Principal) {
    const contract = await this.requireContract(contractId, actor);
    const rows = (await this.installments.findMany({
      where: { contractId },
      orderBy: { seq: 'asc' },
      include: { projectMilestone: MILESTONE_SELECT },
    })) as unknown as InstallmentRow[];
    return this.present(contract, rows);
  }

  async save(contractId: string, dto: SaveInstallmentsDto, actor: Principal) {
    const contract = await this.requireContract(contractId, actor);
    const value = num(contract.value);
    const input = dto.installments.map((row) => ({
      kind: row.kind,
      label: text(row.label) ?? KIND_LABEL[row.kind],
      amount: row.amount,
      dueOn: row.due_on ?? null,
      dueNote: text(row.due_note),
      milestone: text(row.milestone),
      guaranteeType: row.guarantee_type ?? null,
      guaranteeAmount: row.guarantee_amount ?? null,
      guaranteeRef: text(row.guarantee_ref),
      guaranteeExpiresOn: row.guarantee_expires_on ?? null,
    }));
    const problems = scheduleProblems(input, value);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'installments', reason })),
      );
    }

    const { before, after } = await this.transactions.execute(async (tx) => {
      const old = (await tx.contractInstallment.findMany({
        where: { contractId },
        orderBy: { seq: 'asc' },
      })) as InstallmentRow[];
      // CD-182 — the project milestones tied to an installment, by its
      // number: the rows are rewritten below, the ties must survive.
      const ties = (await tx.projectMilestone.findMany({
        where: { installmentId: { in: old.map((row) => row.id) } },
        select: { id: true, installmentId: true },
      })) as { id: string; installmentId: string }[];
      const seqOf = new Map(old.map((row) => [row.id, row.seq]));
      await tx.contractInstallment.deleteMany({ where: { contractId } });
      if (input.length) {
        await tx.contractInstallment.createMany({
          data: input.map((row, index) => ({
            companyId: contract.companyId,
            contractId,
            seq: index + 1,
            kind: row.kind,
            label: row.label,
            amount: row.amount,
            dueOn: asDay(row.dueOn),
            dueNote: row.dueNote,
            milestone: row.milestone,
            // a guarantee is kept only with its type
            guaranteeType: row.guaranteeType,
            guaranteeAmount: row.guaranteeType ? row.guaranteeAmount : null,
            guaranteeRef: row.guaranteeType ? row.guaranteeRef : null,
            guaranteeExpiresOn: row.guaranteeType
              ? asDay(row.guaranteeExpiresOn)
              : null,
          })),
        });
      }
      const fresh = (await tx.contractInstallment.findMany({
        where: { contractId },
        orderBy: { seq: 'asc' },
      })) as InstallmentRow[];
      for (const tie of ties) {
        const seq = seqOf.get(tie.installmentId);
        const now = fresh.find((row) => row.seq === seq);
        if (now) {
          await tx.projectMilestone.update({
            where: { id: tie.id },
            data: { installmentId: now.id },
          });
        }
      }
      return { before: old, after: fresh };
    });

    const summary = (rows: InstallmentRow[]) =>
      rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        amount: num(row.amount),
        dueOn: day(row.dueOn),
        milestone: row.milestone,
      }));
    await this.audit.record({
      eventType: 'legal.installments.saved',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: contractId,
      before: { installments: summary(before) },
      after: { installments: summary(after) },
    });
    // CD-182 — shown with the milestones the ties followed to
    return this.view(contractId, actor);
  }

  private present(contract: ContractRef, rows: InstallmentRow[]) {
    const value = num(contract.value);
    const amounts = rows.map((row) => num(row.amount) ?? 0);
    const terms = paymentTermsCheck(
      rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        dueOn: day(row.dueOn),
        milestone: row.projectMilestone
          ? {
              title: row.projectMilestone.title,
              status: row.projectMilestone.status,
              criteria: Array.isArray(row.projectMilestone.criteria)
                ? row.projectMilestone.criteria.length
                : 0,
              dueOn: day(row.projectMilestone.dueOn),
              achievedOn: day(row.projectMilestone.achievedOn),
            }
          : null,
      })),
      {
        signed: Boolean(contract.signedOn),
        projectOpen: Boolean(contract.project),
      },
    );
    return {
      // CD-152 — each payment against the project's milestones
      project: contract.project,
      paymentCheck: {
        problems: terms.problems,
        pending: terms.pending,
        billable: terms.billable,
      },
      contractValue: value,
      currency: contract.currency,
      ...balanceOf(amounts, value),
      installments: rows.map((row, index) => ({
        id: row.id,
        seq: row.seq,
        kind: row.kind,
        label: row.label,
        amount: amounts[index],
        sharePct: shareOf(amounts[index], value),
        dueOn: day(row.dueOn),
        dueNote: row.dueNote,
        milestone: row.milestone,
        guaranteeType: row.guaranteeType,
        guaranteeAmount: num(row.guaranteeAmount),
        guaranteeRef: row.guaranteeRef,
        guaranteeExpiresOn: day(row.guaranteeExpiresOn),
        projectMilestone: row.projectMilestone
          ? {
              id: row.projectMilestone.id,
              title: row.projectMilestone.title,
              status: row.projectMilestone.status,
              dueOn: day(row.projectMilestone.dueOn),
              achievedOn: day(row.projectMilestone.achievedOn),
            }
          : null,
        check: terms.rows[index],
      })),
    };
  }

  private async requireContract(id: string, actor: Principal) {
    const found = (await this.contracts.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...contractVisibleWhere(actor),
      },
      select: {
        id: true,
        companyId: true,
        contractNo: true,
        value: true,
        currency: true,
        signedOn: true,
        project: { select: { id: true, projectNo: true } },
      },
    })) as ContractRef | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return found;
  }
}
