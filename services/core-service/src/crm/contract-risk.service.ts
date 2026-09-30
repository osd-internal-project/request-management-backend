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
import { CustomerContractRepository } from './contract.repositories';
import { ContractDraftsService } from './contract-drafts.service';
import { approvalStateOf } from './contract-terms';
import {
  opinionKey,
  opinionNeeded,
  riskProblems,
  signReadiness,
  type RiskIssue,
} from './contract-risk';
import { SaveRiskAssessmentDto } from './dto/legal-contract.dto';
import { CrmConfigRepository } from './segment.repositories';

/** CD-158 ประเมินความเสี่ยงกฎหมาย (หนึ่งแถวต่อสัญญา). */
@Injectable()
export class ContractRiskAssessmentRepository extends BaseRepository<
  PrismaService['contractRiskAssessment']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractRiskAssessment;
  }
}

/** What is assessed: a contract in the repository, or — CD-159 — a draft. */
export type RiskSubject = { contractId: string } | { draftId: string };

interface SubjectRef {
  companyId: string;
  key: RiskSubject;
  /** How the executives' request points back at it. */
  refType: string;
  refId: string;
  label: string;
  title: string;
  value: number | null;
  counterparty: string;
  resourceType: string;
  resourceId: string;
}

interface AssessmentRow {
  level: string;
  summary: string | null;
  issues: unknown;
  opinionRequestId: string | null;
  opinionError: string | null;
  assessedBy: string;
  assessedAt: Date;
}

const LEVEL_TH: Record<string, string> = {
  low: 'ต่ำ',
  medium: 'ปานกลาง',
  high: 'สูง',
  critical: 'วิกฤต',
};

function readIssues(value: unknown): RiskIssue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (issue): issue is RiskIssue =>
      typeof issue === 'object' &&
      issue !== null &&
      typeof (issue as RiskIssue).title === 'string',
  );
}

/**
 * CD-158 — ประเมินความเสี่ยงกฎหมาย. Legal rates a contract low → critical
 * and lists the issues behind it, marking those to put to the executives.
 * High or critical, or any issue marked, raises and submits a request of the
 * type CRM settings name ("ขอความเห็นความเสี่ยงทางกฎหมาย") — the same way
 * CD-153 asks about a liability cap — and the contract is not ready to sign
 * until that opinion is given in favour.
 *
 * Nothing signs contracts in this system yet (CD-160); `signing` is what
 * CD-159/160 will read. Re-assessing with the same level and the same issues
 * for the executives keeps the opinion already asked; a change asks again.
 */
@Injectable()
export class ContractRiskService {
  constructor(
    private readonly assessments: ContractRiskAssessmentRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly drafts: ContractDraftsService,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly audit: AuditWriter,
  ) {}

  async view(subject: RiskSubject, actor: Principal) {
    const ref = await this.requireSubject(subject, actor);
    const row = (await this.assessments.findFirst({
      where: ref.key,
    })) as AssessmentRow | null;
    return this.present(row);
  }

  async save(
    subject: RiskSubject,
    dto: SaveRiskAssessmentDto,
    actor: Principal,
    authorization: string,
  ) {
    const contract = await this.requireSubject(subject, actor);
    const issues: RiskIssue[] = (dto.issues ?? []).map((issue) => ({
      title: issue.title?.trim() ?? '',
      detail: issue.detail?.trim() || null,
      clause: issue.clause?.trim() || null,
      severity: issue.severity,
      escalate: Boolean(issue.escalate),
    }));
    const problems = riskProblems(dto.level, issues);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'risk', reason })),
      );
    }

    const before = (await this.assessments.findFirst({
      where: contract.key,
    })) as AssessmentRow | null;
    const changed =
      !before ||
      opinionKey(before.level, readIssues(before.issues)) !==
        opinionKey(dto.level, issues);
    const data = {
      level: dto.level,
      summary: dto.summary?.trim() || null,
      issues: issues as unknown as Prisma.InputJsonValue,
      assessedBy: actor.userId,
      assessedAt: new Date(),
      // What the executives were asked no longer matches: ask again.
      ...(changed ? { opinionRequestId: null, opinionError: null } : {}),
    };
    await this.assessments.upsert({
      where: contract.key,
      create: { ...contract.key, companyId: contract.companyId, ...data },
      update: data,
    });
    await this.audit.record({
      eventType: 'legal.contract.risk_assessed',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: contract.resourceType,
      resourceId: contract.resourceId,
      before: before
        ? { level: before.level, issues: readIssues(before.issues).length }
        : { assessed: false },
      after: {
        level: dto.level,
        issues: issues.length,
        escalated: issues.filter((issue) => issue.escalate).length,
      },
    });

    if (changed && opinionNeeded(dto.level, issues)) {
      await this.askOpinion(contract, dto.level, issues, actor, authorization);
    }
    return this.view(subject, actor);
  }

  /** Ask again — after the request type was set up, a failed submit, or a "no". */
  async requestOpinion(
    subject: RiskSubject,
    actor: Principal,
    authorization: string,
  ) {
    const contract = await this.requireSubject(subject, actor);
    const row = (await this.assessments.findFirst({
      where: contract.key,
    })) as AssessmentRow | null;
    const issues = readIssues(row?.issues);
    if (!row || !opinionNeeded(row.level, issues)) {
      throw new AppError(
        'CONFLICT',
        'ความเสี่ยงไม่ถึงระดับที่ต้องเสนอผู้บริหาร — ไม่ต้องขอความเห็น',
      );
    }
    const current = await this.requestOf(row.opinionRequestId);
    if (current && approvalStateOf(true, current) !== 'rejected') {
      throw new AppError('CONFLICT', 'มีคำขอความเห็นผู้บริหารอยู่แล้ว');
    }
    await this.askOpinion(contract, row.level, issues, actor, authorization);
    return this.view(subject, actor);
  }

  // --- helpers -------------------------------------------------------------

  /**
   * Create and submit the request. Every failure is kept on the assessment
   * as the reason — the assessment is already saved and must stay so.
   */
  private async askOpinion(
    contract: SubjectRef,
    level: string,
    issues: RiskIssue[],
    actor: Principal,
    authorization: string,
  ) {
    const record = (requestId: string | null, error: string | null) =>
      this.assessments.update({
        where: contract.key,
        data: { opinionRequestId: requestId, opinionError: error },
      });

    const config = (await this.configs.findFirst({
      where: { companyId: contract.companyId },
      select: { legalRiskOpinionTypeCode: true },
    })) as { legalRiskOpinionTypeCode: string | null } | null;
    const typeCode = config?.legalRiskOpinionTypeCode;
    if (!typeCode) {
      await record(
        null,
        'ยังไม่ได้ตั้งประเภทคำขอความเห็นความเสี่ยงทางกฎหมายในหน้าตั้งค่า CRM — ยังไม่ได้ส่งผู้บริหาร',
      );
      return;
    }

    const escalated = issues.filter((issue) => issue.escalate);
    const put = escalated.length ? escalated : issues;
    const value = contract.value;
    let requestId: string;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: contract.refType,
          ref_id: contract.refId,
          // Generic keys: a company's own form ignores what it does not have
          // and says at submit what it still needs.
          form_data: {
            subject: `ขอความเห็นความเสี่ยงทางกฎหมาย ${contract.label}`,
            contract_no: contract.label,
            counterparty: contract.counterparty,
            ...(value !== null ? { contract_value: value } : {}),
            risk_level: LEVEL_TH[level] ?? level,
            detail:
              `${contract.title} — ความเสี่ยง${LEVEL_TH[level] ?? level}\n` +
              put
                .map(
                  (issue, index) =>
                    `${index + 1}. ${issue.title}` +
                    (issue.clause ? ` (${issue.clause})` : '') +
                    (issue.detail ? ` — ${issue.detail}` : ''),
                )
                .join('\n'),
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
    } catch (error) {
      await record(null, `สร้างคำขอความเห็นไม่ได้: ${messageOf(error)}`);
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
      eventType: 'legal.contract.risk_opinion_requested',
      companyId: contract.companyId,
      ...auditActor(actor),
      resourceType: contract.resourceType,
      resourceId: contract.resourceId,
      after: { requestId, level, escalated: escalated.length },
    });
  }

  private async present(row: AssessmentRow | null) {
    const issues = readIssues(row?.issues);
    const needed = opinionNeeded(row?.level ?? null, issues);
    const request = needed
      ? await this.requestOf(row?.opinionRequestId ?? null)
      : null;
    const state = approvalStateOf(needed, request);
    return {
      assessed: Boolean(row),
      level: row?.level ?? null,
      summary: row?.summary ?? null,
      issues,
      assessedBy: row?.assessedBy ?? null,
      assessedAt: row?.assessedAt ?? null,
      opinion: {
        state,
        request: request
          ? {
              id: request.id,
              requestNo: request.requestNo,
              status: request.status,
            }
          : null,
        error: needed ? (row?.opinionError ?? null) : null,
      },
      signing: signReadiness(Boolean(row), state),
    };
  }

  private async requestOf(id: string | null) {
    if (!id) return null;
    return (await this.requestRows.findFirst({
      where: { id },
      select: { id: true, requestNo: true, status: true },
    })) as { id: string; requestNo: string | null; status: string } | null;
  }

  private async requireSubject(
    subject: RiskSubject,
    actor: Principal,
  ): Promise<SubjectRef> {
    if ('draftId' in subject) {
      const draft = await this.drafts.subjectOf(subject.draftId, actor);
      const label = draft.requestNo ?? draft.requestId.slice(0, 8);
      return {
        companyId: draft.companyId,
        key: { draftId: subject.draftId },
        refType: 'request',
        refId: draft.requestNo ?? draft.requestId,
        label,
        title: draft.title || label,
        value: draft.value,
        counterparty: draft.counterparty,
        resourceType: 'request',
        resourceId: draft.requestId,
      };
    }
    const found = (await this.contracts.findFirst({
      where: {
        id: subject.contractId,
        companyId: actor.activeCompanyId,
        ...contractVisibleWhere(actor),
      },
      select: {
        id: true,
        companyId: true,
        contractNo: true,
        title: true,
        value: true,
        counterpartyName: true,
        customer: { select: { nameTh: true } },
      },
    })) as {
      id: string;
      companyId: string;
      contractNo: string;
      title: string;
      value: { toString(): string } | null;
      counterpartyName: string | null;
      customer: { nameTh: string } | null;
    } | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return {
      companyId: found.companyId,
      key: { contractId: found.id },
      refType: 'contract',
      refId: found.contractNo,
      label: found.contractNo,
      title: found.title,
      value: found.value === null ? null : Number(found.value.toString()),
      counterparty: found.customer?.nameTh ?? found.counterpartyName ?? '',
      resourceType: 'customer_contract',
      resourceId: found.id,
    };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
