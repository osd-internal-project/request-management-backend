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
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestRepository } from '../requests/request.repository';
import { RequestsService } from '../requests/requests.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractReviewRoundRepository } from './contract-reviews.service';
import { ContractRiskService } from './contract-risk.service';
import { approvalStateOf } from './contract-terms';
import { CrmConfigRepository } from './segment.repositories';

/** CD-159 การขออนุมัติร่างสัญญา รายฉบับ. */
@Injectable()
export class ContractDraftApprovalRepository extends BaseRepository<
  PrismaService['contractDraftApproval']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractDraftApproval;
  }
}

interface ApprovalRow {
  id: string;
  companyId: string;
  draftId: string;
  versionNo: number;
  requestId: string | null;
  error: string | null;
  riskLevel: string | null;
  requestedBy: string;
  requestedAt: Date;
  voidedAt: Date | null;
  voidReason: string | null;
}

const LEVEL_TH: Record<string, string> = {
  low: 'ต่ำ',
  medium: 'ปานกลาง',
  high: 'สูง',
  critical: 'วิกฤต',
};

/**
 * CD-159 — อนุมัติสัญญา. Legal asks for one version of the draft to be
 * approved: a Platform Request of the type CRM settings name, whose approval
 * matrix routes it — `contract_value` and `risk_level` are in its form, so
 * a level can be conditioned on the value (`gt`) or the risk (`in`) without
 * code (configuration over code). The workflow engine owns the decision;
 * nothing here re-implements an approval ladder.
 *
 * It may be asked when the request is still open, no review round (CD-147)
 * is open, and the draft's risk assessment (CD-158, on the draft) allows
 * signing — assessed, and a high risk has the executives' opinion in favour.
 *
 * The approval belongs to the version asked about: saving a later version
 * voids it (in `ContractDraftsService.saveVersion`, same transaction), so
 * what was approved is always the text that exists.
 */
@Injectable()
export class ContractDraftApprovalService {
  constructor(
    private readonly approvals: ContractDraftApprovalRepository,
    private readonly rounds: ContractReviewRoundRepository,
    private readonly drafts: ContractDraftsService,
    private readonly risk: ContractRiskService,
    private readonly configs: CrmConfigRepository,
    private readonly requestRows: RequestRepository,
    private readonly requests: RequestsService,
    private readonly members: CompanyMemberRepository,
    private readonly audit: AuditWriter,
  ) {}

  async view(draftId: string, actor: Principal) {
    const subject = await this.drafts.subjectOf(draftId, actor);
    const rows = (await this.approvals.findMany({
      where: { draftId },
      orderBy: { requestedAt: 'desc' },
    })) as ApprovalRow[];
    const current = rows.find((row) => !row.voidedAt) ?? null;
    const request = await this.requestOf(current?.requestId ?? null);
    const state = current ? approvalStateOf(true, request) : null;
    const blockers = await this.blockers(draftId, subject, actor);
    const names = await this.displayNames(rows.map((row) => row.requestedBy));
    const config = (await this.configs.findFirst({
      where: { companyId: subject.companyId },
      select: { contractApprovalTypeCode: true },
    })) as { contractApprovalTypeCode: string | null } | null;
    const pendingOrDone =
      current &&
      current.versionNo === subject.latestVersionNo &&
      state !== 'rejected' &&
      state !== 'missing';
    return {
      typeConfigured: Boolean(config?.contractApprovalTypeCode),
      latestVersionNo: subject.latestVersionNo,
      blockers,
      canRequest: !blockers.length && !pendingOrDone,
      approvedVersionNo:
        current && state === 'approved' ? current.versionNo : null,
      current: current
        ? {
            id: current.id,
            versionNo: current.versionNo,
            riskLevel: current.riskLevel,
            state,
            request: request
              ? {
                  id: request.id,
                  requestNo: request.requestNo,
                  status: request.status,
                }
              : null,
            error: current.error,
            requestedAt: current.requestedAt,
            requestedByName:
              names.get(current.requestedBy) ?? current.requestedBy,
          }
        : null,
      voided: rows
        .filter((row) => row.voidedAt)
        .map((row) => ({
          id: row.id,
          versionNo: row.versionNo,
          requestId: row.requestId,
          voidedAt: row.voidedAt,
          voidReason: row.voidReason,
        })),
    };
  }

  /** Ask for the latest version to be approved. */
  async request(draftId: string, actor: Principal, authorization: string) {
    const subject = await this.drafts.subjectOf(draftId, actor);
    const blockers = await this.blockers(draftId, subject, actor);
    if (blockers.length) {
      throw new AppError(
        'CONFLICT',
        blockers[0],
        blockers.map((reason) => ({ field: 'approval', reason })),
      );
    }
    const current = await this.approvals.findFirst({
      where: { draftId, voidedAt: null },
      orderBy: { requestedAt: 'desc' },
    });
    if (current && current.versionNo === subject.latestVersionNo) {
      const request = await this.requestOf(current.requestId);
      const state = approvalStateOf(true, request);
      if (state !== 'rejected' && state !== 'missing') {
        throw new AppError(
          'CONFLICT',
          `ขออนุมัติร่างฉบับที่ ${current.versionNo} แล้ว`,
        );
      }
    }
    const risk = await this.risk.view({ draftId }, actor);

    // a new ask replaces a refused or failed one on the same version
    if (current) {
      await this.approvals.update({
        where: { id: current.id },
        data: {
          voidedAt: new Date(),
          voidReason: 'ขออนุมัติใหม่',
        },
      });
    }
    const row = await this.approvals.create({
      data: {
        companyId: subject.companyId,
        draftId,
        versionNo: subject.latestVersionNo,
        riskLevel: risk.level,
        requestedBy: actor.userId,
      },
    });
    const record = (requestId: string | null, error: string | null) =>
      this.approvals.update({
        where: { id: row.id },
        data: { requestId, error },
      });

    const config = (await this.configs.findFirst({
      where: { companyId: subject.companyId },
      select: { contractApprovalTypeCode: true },
    })) as { contractApprovalTypeCode: string | null } | null;
    const typeCode = config?.contractApprovalTypeCode;
    if (!typeCode) {
      await record(
        null,
        'ยังไม่ได้ตั้งประเภทคำขออนุมัติสัญญาในหน้าตั้งค่า CRM — ยังไม่ได้ส่งอนุมัติ',
      );
      return this.view(draftId, actor);
    }

    const version = await this.drafts.view(
      draftId,
      actor,
      subject.latestVersionNo,
    );
    const label = subject.requestNo ?? subject.requestId.slice(0, 8);
    const marks = version.clauses.length;
    let requestId: string;
    try {
      const created = (await this.requests.create(
        {
          type_code: typeCode,
          ref_type: 'request',
          ref_id: subject.requestNo ?? subject.requestId,
          // `contract_value` and `risk_level` are what a matrix level's
          // condition can route on; the rest is for the approver to read.
          form_data: {
            subject: `อนุมัติสัญญา ${label} ฉบับที่ ${subject.latestVersionNo}`,
            contract_no: label,
            counterparty: subject.counterparty,
            ...(subject.value !== null
              ? { contract_value: subject.value }
              : {}),
            risk_level: risk.level ?? '',
            risk_level_th: risk.level ? LEVEL_TH[risk.level] : '',
            version_no: subject.latestVersionNo,
            detail:
              `${subject.title || label} — ร่างฉบับที่ ${subject.latestVersionNo} ` +
              `(${marks} ข้อ: แก้จากแม่แบบ ${version.counts.edited} · เพิ่ม ${version.counts.added} · ตัดออก ${version.counts.removed})` +
              (risk.level ? ` · ความเสี่ยง${LEVEL_TH[risk.level]}` : ''),
          },
        },
        actor,
      )) as { id: string };
      requestId = created.id;
    } catch (error) {
      await record(null, `สร้างคำขออนุมัติไม่ได้: ${messageOf(error)}`);
      return this.view(draftId, actor);
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
      eventType: 'legal.draft.approval_requested',
      companyId: subject.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: subject.requestId,
      after: {
        draftId,
        versionNo: subject.latestVersionNo,
        requestId,
        riskLevel: risk.level,
      },
    });
    return this.view(draftId, actor);
  }

  /** What stands between the draft and asking for approval, in Thai. */
  private async blockers(
    draftId: string,
    subject: { editable: boolean },
    actor: Principal,
  ): Promise<string[]> {
    const reasons: string[] = [];
    if (!subject.editable) {
      reasons.push('คำขอนี้ไม่ได้อยู่ระหว่างดำเนินการ');
    }
    const open = (await this.rounds.findFirst({
      where: { draftId, status: 'open' },
      select: { roundNo: true },
    })) as { roundNo: number } | null;
    if (open) {
      reasons.push(
        `รอบตรวจที่ ${open.roundNo} ยังเปิดอยู่ — ปิดรอบก่อนขออนุมัติ`,
      );
    }
    const risk = await this.risk.view({ draftId }, actor);
    if (!risk.assessed) {
      reasons.push('ยังไม่ได้ประเมินความเสี่ยงของร่าง');
    } else if (risk.signing.ready === false && risk.signing.reason) {
      reasons.push(risk.signing.reason);
    }
    return reasons;
  }

  private async requestOf(id: string | null) {
    if (!id) return null;
    return (await this.requestRows.findFirst({
      where: { id },
      select: { id: true, requestNo: true, status: true },
    })) as { id: string; requestNo: string | null; status: string } | null;
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.members.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
