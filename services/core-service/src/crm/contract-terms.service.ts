import { Prisma } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  Principal,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { contractVisibleWhere } from './contract-visibility';
import { ContractMasterNotifier } from './contract-master-notifier';
import { CustomerContractRepository } from './contract.repositories';
import {
  approvalStateOf,
  liabilityKey,
  liabilityNeedsApproval,
  penaltyCeiling,
  termProblems,
  warrantyPeriod,
} from './contract-terms';
import { SaveContractTermsDto } from './dto/legal-contract.dto';
import { CrmConfigRepository } from './segment.repositories';
import { readSeverityTargets, severityTargetProblems } from '../sla/severity';

/** CD-153..156 ข้อกำหนดของสัญญา (หนึ่งแถวต่อสัญญา). */
@Injectable()
export class ContractTermsRepository extends BaseRepository<
  PrismaService['contractTerms']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractTerms;
  }
}

interface ContractRef {
  id: string;
  companyId: string;
  kind: string;
  contractNo: string;
  title: string;
  value: { toString(): string } | null;
  counterpartyName: string | null;
  customer: { nameTh: string } | null;
}

interface TermsRow {
  liabilityUnlimited: boolean;
  liabilityCapAmount: { toString(): string } | null;
  liabilityNote: string | null;
  liabilityApprovalRequestId: string | null;
  liabilityApprovalError: string | null;
  penaltyRatePct: { toString(): string } | null;
  penaltyPeriod: string | null;
  penaltyBasis: string | null;
  penaltyBasisNote: string | null;
  penaltyCapPct: { toString(): string } | null;
  penaltyCapAmount: { toString(): string } | null;
  warrantyMonths: number | null;
  warrantyScope: string | null;
  warrantyExclusions: string | null;
  acceptedOn: Date | null;
  terminationNoticeDays: number | null;
  terminationConditions: string | null;
  terminationConsequences: string | null;
  terminationSteps: string[];
  serviceLevels: unknown;
  serviceCoverage: string | null;
  availabilityPct: { toString(): string } | null;
  serviceReportEvery: string | null;
  updatedAt: Date;
  updatedBy: string | null;
}

const num = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? null : Number(value.toString());
const day = (value: Date | null) =>
  value ? value.toISOString().slice(0, 10) : null;

/**
 * CD-153..156 — ข้อกำหนดที่วัดได้ของสัญญา, one card on the contract page:
 *
 * - ความรับผิด (CD-153): a cap in money, or unlimited. A cap above the
 *   contract value — or none — needs executives: saving it raises a request
 *   of the type CRM settings name (`liabilityApprovalRequestTypeCode`) and
 *   submits it; the card shows the request's outcome. A different cap later
 *   raises a new request — the old approval was for the old number.
 * - ค่าปรับ (CD-154): rate per period of a stated basis, capped by a
 *   percentage of the contract or an amount — the ceiling in money is shown.
 *   Tying a penalty to a milestone waits for PM (CD-18).
 * - การรับประกัน (CD-155): months, scope, exclusions, counted from the real
 *   acceptance date (entered here until Delivery records it).
 * - การยกเลิก (CD-156): notice days, conditions, consequences, and the steps
 *   to follow when it happens.
 *
 * Read with `legal.contract.read`, written with `legal.contract.manage`;
 * a confidential contract's terms follow the contract's own visibility.
 */
@Injectable()
export class ContractTermsService {
  constructor(
    private readonly terms: ContractTermsRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly audit: AuditWriter,
    private readonly master: ContractMasterNotifier,
  ) {}

  async view(contractId: string, actor: Principal) {
    const contract = await this.requireContract(contractId, actor);
    const row = (await this.terms.findFirst({
      where: { contractId },
    })) as TermsRow | null;
    return this.present(contract, row);
  }

  async save(
    contractId: string,
    dto: SaveContractTermsDto,
    actor: Principal,
    authorization: string,
  ) {
    const contract = await this.requireContract(contractId, actor);
    const problems = termProblems({
      liabilityUnlimited: dto.liability_unlimited,
      liabilityCapAmount: dto.liability_cap_amount,
      penaltyRatePct: dto.penalty_rate_pct,
      penaltyPeriod: dto.penalty_period,
      penaltyBasis: dto.penalty_basis,
      penaltyBasisNote: dto.penalty_basis_note,
      penaltyCapPct: dto.penalty_cap_pct,
      penaltyCapAmount: dto.penalty_cap_amount,
      warrantyMonths: dto.warranty_months,
      acceptedOn: dto.accepted_on,
      terminationNoticeDays: dto.termination_notice_days,
      terminationSteps: dto.termination_steps,
    });
    // CD-151 — the same checks a case type's targets get (CD-67)
    if (dto.service_levels) {
      problems.push(
        ...severityTargetProblems(dto.service_levels).map(
          (problem) => `ระดับบริการ: ${problem}`,
        ),
      );
    }
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'terms', reason })),
      );
    }

    const before = (await this.terms.findFirst({
      where: { contractId },
    })) as TermsRow | null;
    const liability = {
      liabilityUnlimited: dto.liability_unlimited ?? false,
      liabilityCapAmount: dto.liability_unlimited
        ? null
        : (dto.liability_cap_amount ?? null),
    };
    const liabilityChanged =
      liabilityKey(liability) !==
      liabilityKey({
        liabilityUnlimited: before?.liabilityUnlimited ?? false,
        liabilityCapAmount: num(before?.liabilityCapAmount),
      });

    const data = {
      ...liability,
      liabilityNote: dto.liability_note?.trim() || null,
      penaltyRatePct: dto.penalty_rate_pct ?? null,
      penaltyPeriod: dto.penalty_period || null,
      penaltyBasis: dto.penalty_basis || null,
      penaltyBasisNote: dto.penalty_basis_note?.trim() || null,
      penaltyCapPct: dto.penalty_cap_pct ?? null,
      penaltyCapAmount: dto.penalty_cap_amount ?? null,
      warrantyMonths: dto.warranty_months ?? null,
      warrantyScope: dto.warranty_scope?.trim() || null,
      warrantyExclusions: dto.warranty_exclusions?.trim() || null,
      acceptedOn: dto.accepted_on
        ? new Date(`${dto.accepted_on.slice(0, 10)}T00:00:00Z`)
        : null,
      terminationNoticeDays: dto.termination_notice_days ?? null,
      terminationConditions: dto.termination_conditions?.trim() || null,
      terminationConsequences: dto.termination_consequences?.trim() || null,
      terminationSteps: (dto.termination_steps ?? []).map((step) =>
        step.trim(),
      ),
      serviceLevels: dto.service_levels
        ? (readSeverityTargets(
            dto.service_levels,
          ) as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      serviceCoverage: dto.service_levels
        ? (dto.service_coverage ?? null)
        : null,
      availabilityPct: dto.availability_pct ?? null,
      serviceReportEvery: dto.service_report_every ?? null,
      // A new cap voids the approval asked for the old one.
      ...(liabilityChanged
        ? { liabilityApprovalRequestId: null, liabilityApprovalError: null }
        : {}),
      updatedBy: actor.userId,
    };
    await this.terms.upsert({
      where: { contractId },
      create: { contractId, companyId: contract.companyId, ...data },
      update: data,
    });
    await this.audit.record({
      eventType: 'legal.contract.terms_saved',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: contractId,
      before: before
        ? {
            liability: liabilityKey({
              liabilityUnlimited: before.liabilityUnlimited,
              liabilityCapAmount: num(before.liabilityCapAmount),
            }),
          }
        : { recorded: false },
      after: {
        liability: liabilityKey(liability),
        penaltyRatePct: dto.penalty_rate_pct ?? null,
        warrantyMonths: dto.warranty_months ?? null,
        acceptedOn: dto.accepted_on ?? null,
        terminationNoticeDays: dto.termination_notice_days ?? null,
      },
    });

    if (
      liabilityChanged &&
      liabilityNeedsApproval(liability, num(contract.value))
    ) {
      await this.askApproval(contract, liability, actor, authorization);
    }
    if (contract.kind === 'msa') {
      await this.master.changed(
        contractId,
        'แก้ไขข้อกำหนดของข้อตกลงหลัก',
        actor,
      );
    }
    return this.view(contractId, actor);
  }

  /** Ask again — after the request type was set up, or a submit failed. */
  async requestLiabilityApproval(
    contractId: string,
    actor: Principal,
    authorization: string,
  ) {
    const contract = await this.requireContract(contractId, actor);
    const row = (await this.terms.findFirst({
      where: { contractId },
    })) as TermsRow | null;
    const liability = {
      liabilityUnlimited: row?.liabilityUnlimited ?? false,
      liabilityCapAmount: num(row?.liabilityCapAmount),
    };
    if (!row || !liabilityNeedsApproval(liability, num(contract.value))) {
      throw new AppError(
        'CONFLICT',
        'เพดานความรับผิดไม่เกินมูลค่าสัญญา — ไม่ต้องขออนุมัติ',
      );
    }
    const current = await this.requestOf(row.liabilityApprovalRequestId);
    if (current && approvalStateOf(true, current) !== 'rejected') {
      throw new AppError('CONFLICT', 'มีคำขออนุมัติเพดานนี้อยู่แล้ว');
    }
    await this.askApproval(contract, liability, actor, authorization);
    return this.view(contractId, actor);
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Create and submit the executives' request. Every failure is kept on the
   * terms as the reason — the terms are already saved and must stay so.
   */
  private async askApproval(
    contract: ContractRef,
    liability: {
      liabilityUnlimited: boolean;
      liabilityCapAmount: number | null;
    },
    actor: Principal,
    authorization: string,
  ) {
    const record = (requestId: string | null, error: string | null) =>
      this.terms.update({
        where: { contractId: contract.id },
        data: {
          liabilityApprovalRequestId: requestId,
          liabilityApprovalError: error,
        },
      });

    const config = (await this.configs.findFirst({
      where: { companyId: contract.companyId },
      select: { liabilityApprovalRequestTypeCode: true },
    })) as { liabilityApprovalRequestTypeCode: string | null } | null;
    const typeCode = config?.liabilityApprovalRequestTypeCode;
    if (!typeCode) {
      await record(
        null,
        'ยังไม่ได้ตั้งประเภทคำขออนุมัติเพดานความรับผิดในหน้าตั้งค่า CRM — ยังไม่ได้ส่งผู้บริหาร',
      );
      return;
    }

    const value = num(contract.value);
    const cap = liability.liabilityUnlimited
      ? 'ไม่จำกัด'
      : (liability.liabilityCapAmount ?? 0).toLocaleString('th-TH');
    let requestId: string;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'contract',
          ref_id: contract.contractNo,
          // Generic keys: a company's own form ignores what it does not have
          // and says at submit what it still needs.
          form_data: {
            subject: `อนุมัติเพดานความรับผิด ${contract.contractNo}`,
            contract_no: contract.contractNo,
            counterparty:
              contract.customer?.nameTh ?? contract.counterpartyName ?? '',
            ...(value !== null ? { contract_value: value } : {}),
            liability_cap: cap,
            detail:
              `${contract.title} — เพดานความรับผิด ${cap}` +
              (value !== null
                ? ` เทียบมูลค่าสัญญา ${value.toLocaleString('th-TH')}`
                : ''),
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
    } catch (error) {
      await record(null, `สร้างคำขออนุมัติไม่ได้: ${messageOf(error)}`);
      return;
    }
    try {
      await this.requests.submit(requestId, actor, authorization);
      await record(requestId, null);
    } catch (error) {
      await record(
        requestId,
        `สร้างร่างคำขอแล้วแต่ยื่นไม่ผ่าน: ${messageOf(error)} — เปิดร่างเพื่อกรอกให้ครบแล้วยื่น`,
      );
    }
    await this.audit.record({
      eventType: 'legal.contract.liability_approval_requested',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: 'customer_contract',
      resourceId: contract.id,
      after: { requestId, cap },
    });
  }

  private async present(contract: ContractRef, row: TermsRow | null) {
    const value = num(contract.value);
    const liability = {
      liabilityUnlimited: row?.liabilityUnlimited ?? false,
      liabilityCapAmount: num(row?.liabilityCapAmount),
    };
    const needed = liabilityNeedsApproval(liability, value);
    const request = needed
      ? await this.requestOf(row?.liabilityApprovalRequestId ?? null)
      : null;
    const penaltyCap = {
      penaltyCapPct: num(row?.penaltyCapPct),
      penaltyCapAmount: num(row?.penaltyCapAmount),
    };
    return {
      contractValue: value,
      recorded: Boolean(row),
      liability: {
        unlimited: liability.liabilityUnlimited,
        capAmount: liability.liabilityCapAmount,
        note: row?.liabilityNote ?? null,
        approval: {
          state: approvalStateOf(needed, request),
          request: request
            ? {
                id: request.id,
                requestNo: request.requestNo,
                status: request.status,
              }
            : null,
          error: needed ? (row?.liabilityApprovalError ?? null) : null,
        },
      },
      penalty: {
        ratePct: num(row?.penaltyRatePct),
        period: row?.penaltyPeriod ?? null,
        basis: row?.penaltyBasis ?? null,
        basisNote: row?.penaltyBasisNote ?? null,
        capPct: penaltyCap.penaltyCapPct,
        capAmount: penaltyCap.penaltyCapAmount,
        ceiling: penaltyCeiling(penaltyCap, value),
      },
      warranty: {
        months: row?.warrantyMonths ?? null,
        scope: row?.warrantyScope ?? null,
        exclusions: row?.warrantyExclusions ?? null,
        acceptedOn: day(row?.acceptedOn ?? null),
        period: warrantyPeriod(
          day(row?.acceptedOn ?? null),
          row?.warrantyMonths ?? null,
        ),
      },
      termination: {
        noticeDays: row?.terminationNoticeDays ?? null,
        conditions: row?.terminationConditions ?? null,
        consequences: row?.terminationConsequences ?? null,
        steps: row?.terminationSteps ?? [],
      },
      service: {
        levels: readSeverityTargets(row?.serviceLevels),
        coverage: row?.serviceCoverage ?? null,
        availabilityPct: num(row?.availabilityPct),
        reportEvery: row?.serviceReportEvery ?? null,
      },
      updatedAt: row?.updatedAt ?? null,
    };
  }

  private async requestOf(id: string | null) {
    if (!id) return null;
    return (await this.requestRows.findFirst({
      where: { id },
      select: { id: true, requestNo: true, status: true },
    })) as { id: string; requestNo: string | null; status: string } | null;
  }

  private async requireContract(
    id: string,
    actor: Principal,
  ): Promise<ContractRef> {
    const found = (await this.contracts.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...contractVisibleWhere(actor),
      },
      select: {
        id: true,
        companyId: true,
        kind: true,
        contractNo: true,
        title: true,
        value: true,
        counterpartyName: true,
        customer: { select: { nameTh: true } },
      },
    })) as ContractRef | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return found;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
