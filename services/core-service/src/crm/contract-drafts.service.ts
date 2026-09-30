import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
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
import { CompanyMemberRepository } from '../access/company-member.repository';
import { RequestRepository } from '../requests/request.repository';
import {
  fill,
  markClauses,
  readClauses,
  sameClauses,
  termVariable,
  versionProblems,
  type Clause,
} from './contract-drafts';
import { ContractTemplatesService } from './contract-templates.service';
import { CustomerLocationRepository } from './customer-child.repositories';
import { CustomerRepository } from './customer.repository';
import {
  SaveDraftVersionDto,
  StartContractDraftDto,
} from './dto/legal-contract.dto';
import {
  NegotiationRoundRepository,
  OpportunityRepository,
} from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';
import type { RecordedTerm } from './trade-terms';

/** CD-146 ร่างสัญญา (หนึ่งฉบับต่อคำขอจัดทำสัญญา). */
@Injectable()
export class ContractDraftRepository extends BaseRepository<
  PrismaService['contractDraft']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractDraft;
  }
}

/** CD-146 เวอร์ชันของร่าง — เขียนแล้วไม่แก้. */
@Injectable()
export class ContractDraftVersionRepository extends BaseRepository<
  PrismaService['contractDraftVersion']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractDraftVersion;
  }
}

/** A request Legal can still draft on: sent to them and not finished. */
const OPEN_STATUSES = [
  'submitted',
  'returned',
  'pending_approval',
  'approved',
  'in_progress',
  'on_hold',
];

interface RequestRef {
  id: string;
  requestNo: string | null;
  companyId: string;
  typeCode: string;
  status: string;
  refType: string | null;
  refId: string | null;
  formData: unknown;
}

interface DealRef {
  id: string;
  opportunityCode: string;
  title: string;
  amount: { toString(): string } | null;
  currency: string;
  customerId: string | null;
}

interface DraftRow {
  id: string;
  companyId: string;
  requestId: string;
  templateId: string;
  templateClauses: unknown;
  variables: unknown;
  missing: string[];
  latestVersionNo: number;
  createdAt: Date;
  createdBy: string;
  template: { id: string; code: string; name: string };
}

interface VersionRow {
  id: string;
  versionNo: number;
  clauses: unknown;
  note: string | null;
  createdAt: Date;
  createdBy: string;
}

const thaiDate = (value: Date) =>
  value.toLocaleDateString('th-TH', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Bangkok',
  });
const isoDay = (value: unknown) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? new Date(`${value.slice(0, 10)}T00:00:00Z`)
    : null;
const money = (value: number) =>
  value.toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * CD-146 — ร่างสัญญา. Legal starts the draft on a contract request (the
 * type CRM settings name, CD-81) from a template; the template's variables
 * are filled from the request's form, its deal and customer, the latest
 * negotiated terms (CD-79) and the company's letterhead. Each save is a new
 * version, never changed afterwards — CD-147 compares versions and CD-159
 * approves one. Every clause is marked against the template as it was
 * filled: unchanged, edited, or added; clauses taken out are listed.
 *
 * Read with `legal.contract.read`, written with `legal.contract.manage`.
 * Once the request is finished (completed, closed, rejected, cancelled) the
 * draft is read-only.
 */
@Injectable()
export class ContractDraftsService {
  constructor(
    private readonly drafts: ContractDraftRepository,
    private readonly versions: ContractDraftVersionRepository,
    private readonly templateService: ContractTemplatesService,
    private readonly requests: RequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly rounds: NegotiationRoundRepository,
    private readonly customers: CustomerRepository,
    private readonly locations: CustomerLocationRepository,
    private readonly members: CompanyMemberRepository,
    private readonly transactions: PrismaTransactionService,
    private readonly audit: AuditWriter,
  ) {}

  /** The draft card on a request: whether it takes a draft, and the draft. */
  async forRequest(requestId: string, actor: Principal) {
    const request = await this.findRequest(requestId, actor);
    if (!request || !(await this.isContractRequest(request))) {
      return { eligible: false, draft: null, templates: [] };
    }
    const draft = (await this.drafts.findFirst({
      where: { requestId: request.id },
      include: { template: { select: { id: true, code: true, name: true } } },
    })) as DraftRow | null;
    const versions = draft
      ? ((await this.versions.findMany({
          where: { draftId: draft.id },
          orderBy: { versionNo: 'desc' },
          select: {
            versionNo: true,
            note: true,
            createdAt: true,
            createdBy: true,
          },
        })) as Omit<VersionRow, 'id' | 'clauses'>[])
      : [];
    const names = await this.displayNames(versions.map((v) => v.createdBy));
    return {
      eligible: true,
      editable: OPEN_STATUSES.includes(request.status),
      draft: draft
        ? {
            id: draft.id,
            template: draft.template,
            latestVersionNo: draft.latestVersionNo,
            missing: draft.missing,
            versions: versions.map((version) => ({
              ...version,
              createdByName: names.get(version.createdBy) ?? version.createdBy,
            })),
          }
        : null,
      templates: draft ? [] : await this.templateService.list(actor),
    };
  }

  async start(dto: StartContractDraftDto, actor: Principal) {
    const request = await this.findRequest(dto.request_id, actor);
    if (!request || !(await this.isContractRequest(request))) {
      throw new AppError('NOT_FOUND', 'ไม่พบคำขอจัดทำสัญญาที่ระบุ');
    }
    this.assertOpen(request);
    const template = await this.templateService.usable(dto.template_id, actor);
    const values = await this.valuesFor(request);

    const missing = new Set<string>();
    const rendered: Clause[] = template.clauses.map((clause) => {
      const heading = fill(clause.heading, values);
      const body = fill(clause.body, values);
      [...heading.missing, ...body.missing].forEach((name) =>
        missing.add(name),
      );
      return { key: clause.key, heading: heading.text, body: body.text };
    });

    const draft = await this.transactions.execute(async (tx) => {
      const taken = await tx.contractDraft.findUnique({
        where: { requestId: request.id },
        select: { id: true },
      });
      if (taken) {
        throw new AppError('CONFLICT', 'คำขอนี้มีร่างสัญญาแล้ว');
      }
      const created = await tx.contractDraft.create({
        data: {
          companyId: request.companyId,
          requestId: request.id,
          templateId: template.id,
          templateClauses: rendered as unknown as Prisma.InputJsonValue,
          variables: values,
          missing: [...missing],
          latestVersionNo: 1,
          createdBy: actor.userId,
        },
      });
      await tx.contractDraftVersion.create({
        data: {
          draftId: created.id,
          versionNo: 1,
          clauses: rendered as unknown as Prisma.InputJsonValue,
          note: `เริ่มจากแม่แบบ ${template.code}`,
          createdBy: actor.userId,
        },
      });
      return created;
    });
    await this.audit.record({
      eventType: 'legal.draft.started',
      companyId: request.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: request.id,
      after: {
        draftId: draft.id,
        template: template.code,
        missing: [...missing],
      },
    });
    return this.view(draft.id, actor);
  }

  /** One version, each clause marked against the template. */
  async view(draftId: string, actor: Principal, versionNo?: number) {
    const { draft, request } = await this.requireDraft(draftId, actor);
    const no = versionNo ?? draft.latestVersionNo;
    const version = (await this.versions.findFirst({
      where: { draftId, versionNo: no },
    })) as VersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', `ไม่พบร่างฉบับที่ ${no}`);
    const marked = markClauses(
      readClauses(version.clauses),
      readClauses(draft.templateClauses),
    );
    const names = await this.displayNames([version.createdBy]);
    return {
      id: draft.id,
      request: {
        id: request.id,
        requestNo: request.requestNo,
        status: request.status,
      },
      template: draft.template,
      editable: OPEN_STATUSES.includes(request.status),
      latestVersionNo: draft.latestVersionNo,
      missing: draft.missing,
      version: {
        versionNo: version.versionNo,
        note: version.note,
        createdAt: version.createdAt,
        createdBy: version.createdBy,
        createdByName: names.get(version.createdBy) ?? version.createdBy,
      },
      clauses: marked.clauses,
      removed: marked.removed,
      counts: {
        edited: marked.clauses.filter((c) => c.mark === 'edited').length,
        added: marked.clauses.filter((c) => c.mark === 'added').length,
        removed: marked.removed.length,
      },
    };
  }

  /**
   * Save the text as the next version. Refused when someone saved a newer
   * one since the editor opened (`base_version`), or nothing changed.
   */
  async saveVersion(
    draftId: string,
    dto: SaveDraftVersionDto,
    actor: Principal,
  ) {
    const { draft, request } = await this.requireDraft(draftId, actor);
    this.assertOpen(request);
    const clauses: Clause[] = dto.clauses.map((clause) => ({
      key: clause.key?.trim() || `new-${randomUUID().slice(0, 8)}`,
      heading: clause.heading?.trim() ?? '',
      body: clause.body ?? '',
    }));
    const problems = versionProblems(clauses);
    if (problems.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        problems[0],
        problems.map((reason) => ({ field: 'clauses', reason })),
      );
    }

    let voided = 0;
    const versionNo = await this.transactions.execute(async (tx) => {
      const fresh = await tx.contractDraft.findUniqueOrThrow({
        where: { id: draftId },
        select: { latestVersionNo: true },
      });
      if (fresh.latestVersionNo !== dto.base_version) {
        throw new AppError(
          'CONFLICT',
          `มีผู้บันทึกร่างฉบับที่ ${fresh.latestVersionNo} ไปแล้ว — เปิดฉบับล่าสุดแล้วแก้อีกครั้ง`,
        );
      }
      const latest = await tx.contractDraftVersion.findUniqueOrThrow({
        where: {
          draftId_versionNo: { draftId, versionNo: fresh.latestVersionNo },
        },
        select: { clauses: true },
      });
      if (sameClauses(readClauses(latest.clauses), clauses)) {
        throw new AppError('CONFLICT', 'ไม่มีข้อความที่เปลี่ยนจากฉบับล่าสุด');
      }
      const next = fresh.latestVersionNo + 1;
      // guarded on the number read: two saves at once cannot both land
      const claimed = await tx.contractDraft.updateMany({
        where: { id: draftId, latestVersionNo: fresh.latestVersionNo },
        data: { latestVersionNo: next },
      });
      if (claimed.count !== 1) {
        throw new AppError('CONFLICT', 'มีผู้บันทึกร่างพร้อมกัน — ลองอีกครั้ง');
      }
      // CD-159 — what was approved (or asked about) is no longer the text
      voided = (
        await tx.contractDraftApproval.updateMany({
          where: { draftId, voidedAt: null },
          data: {
            voidedAt: new Date(),
            voidReason: `แก้ร่างเป็นฉบับที่ ${next} หลังขออนุมัติ`,
          },
        })
      ).count;
      await tx.contractDraftVersion.create({
        data: {
          draftId,
          versionNo: next,
          clauses: clauses as unknown as Prisma.InputJsonValue,
          note: dto.note?.trim() || null,
          createdBy: actor.userId,
        },
      });
      return next;
    });
    const marked = markClauses(clauses, readClauses(draft.templateClauses));
    await this.audit.record({
      eventType: 'legal.draft.version_saved',
      companyId: draft.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: request.id,
      after: {
        draftId,
        versionNo,
        edited: marked.clauses.filter((c) => c.mark === 'edited').length,
        added: marked.clauses.filter((c) => c.mark === 'added').length,
        removed: marked.removed.length,
        approvalsVoided: voided,
      },
    });
    return this.view(draftId, actor, versionNo);
  }

  // --- helpers -------------------------------------------------------------

  /**
   * The values for the variables. Blank when not found, so the draft keeps
   * `{{name}}` and says it is missing.
   */
  async valuesFor(request: RequestRef): Promise<Record<string, string>> {
    const form = (request.formData ?? {}) as Record<string, unknown>;
    const values: Record<string, string> = {
      today: thaiDate(new Date()),
      request_no: request.requestNo ?? '',
    };

    const config = (await this.configs.findFirst({
      where: { companyId: request.companyId },
      select: {
        letterheadNameTh: true,
        letterheadTaxId: true,
        letterheadAddress: true,
      },
    })) as {
      letterheadNameTh: string | null;
      letterheadTaxId: string | null;
      letterheadAddress: string | null;
    } | null;
    values.our_name = config?.letterheadNameTh ?? '';
    values.our_tax_id = config?.letterheadTaxId ?? '';
    values.our_address = config?.letterheadAddress ?? '';

    let customerId: string | null =
      request.refType === 'customer' ? request.refId : null;
    let deal: DealRef | null = null;
    if (request.refType === 'opportunity' && request.refId) {
      deal = await this.opportunities.findFirst({
        where: {
          companyId: request.companyId,
          OR: [{ opportunityCode: request.refId }, { id: request.refId }],
        },
        select: {
          id: true,
          opportunityCode: true,
          title: true,
          amount: true,
          currency: true,
          customerId: true,
        },
      });
      customerId = deal?.customerId ?? null;
    }
    values.deal_code = deal?.opportunityCode ?? '';
    values.deal_title = deal?.title ?? '';
    values.currency = deal?.currency ?? 'THB';

    const formValue = Number(form.contract_value);
    const value =
      Number.isFinite(formValue) && formValue > 0
        ? formValue
        : deal?.amount
          ? Number(deal.amount.toString())
          : null;
    values.contract_value = value === null ? '' : money(value);
    const start = isoDay(form.start_date);
    const end = isoDay(form.end_date);
    values.start_date = start ? thaiDate(start) : '';
    values.end_date = end ? thaiDate(end) : '';

    if (customerId) {
      const customer = (await this.customers.findFirst({
        where: { id: customerId, companyId: request.companyId },
        select: { nameTh: true, taxId: true, branchName: true },
      })) as {
        nameTh: string;
        taxId: string | null;
        branchName: string | null;
      } | null;
      values.party_name = customer?.nameTh ?? '';
      values.party_tax_id = customer?.taxId ?? '';
      values.party_branch = customer?.branchName ?? '';
      const location = (await this.locations.findFirst({
        where: { customerId, active: true },
        orderBy: [{ isBilling: 'desc' }, { isPrimary: 'desc' }],
      })) as {
        line1: string;
        line2: string | null;
        subDistrict: string | null;
        district: string | null;
        province: string | null;
        postalCode: string | null;
      } | null;
      values.party_address = location
        ? [
            location.line1,
            location.line2,
            location.subDistrict,
            location.district,
            location.province,
            location.postalCode,
          ]
            .filter(Boolean)
            .join(' ')
        : '';
    }
    if (!values.party_name && typeof form.counterparty === 'string') {
      values.party_name = form.counterparty.trim();
    }

    if (deal) {
      const round = (await this.rounds.findFirst({
        where: { opportunityId: deal.id },
        orderBy: { roundNo: 'desc' },
        select: { terms: true },
      })) as { terms: unknown } | null;
      const terms = (
        Array.isArray(round?.terms) ? round.terms : []
      ) as RecordedTerm[];
      values.trade_terms = terms
        .map((term) => `${term.name}: ${term.agreed}`)
        .join('\n');
      for (const term of terms) {
        if (term.code) values[termVariable(term.code)] = term.agreed;
      }
    }
    return values;
  }

  private async isContractRequest(request: RequestRef) {
    const config = (await this.configs.findFirst({
      where: { companyId: request.companyId },
      select: { contractRequestTypeCode: true },
    })) as { contractRequestTypeCode: string | null } | null;
    return Boolean(
      config?.contractRequestTypeCode &&
      config.contractRequestTypeCode === request.typeCode,
    );
  }

  private assertOpen(request: RequestRef) {
    if (!OPEN_STATUSES.includes(request.status)) {
      throw new AppError(
        'CONFLICT',
        'คำขอนี้ไม่ได้อยู่ระหว่างดำเนินการ — แก้ร่างไม่ได้',
      );
    }
  }

  private async findRequest(id: string, actor: Principal) {
    return (await this.requests.findFirst({
      where: { id, companyId: actor.activeCompanyId },
      select: {
        id: true,
        requestNo: true,
        companyId: true,
        typeCode: true,
        status: true,
        refType: true,
        refId: true,
        formData: true,
      },
    })) as RequestRef | null;
  }

  /**
   * CD-147 — a draft the actor may see, whether it can still change, and
   * one version's clauses (the latest when `versionNo` is not given).
   */
  async access(id: string, actor: Principal) {
    const { draft, request } = await this.requireDraft(id, actor);
    return {
      draft,
      request,
      editable: OPEN_STATUSES.includes(request.status),
    };
  }

  /**
   * CD-159 — what a draft's risk assessment and approval say about it: its
   * request, the deal's title, the value (the request's form, else the
   * deal's amount) and the party.
   */
  async subjectOf(draftId: string, actor: Principal) {
    const { draft, request } = await this.requireDraft(draftId, actor);
    const values = await this.valuesFor(request);
    const value = Number(values.contract_value.replace(/,/g, ''));
    return {
      companyId: draft.companyId,
      draftId: draft.id,
      requestId: request.id,
      requestNo: request.requestNo,
      title: values.deal_title,
      value: values.contract_value && Number.isFinite(value) ? value : null,
      counterparty: values.party_name ?? '',
      latestVersionNo: draft.latestVersionNo,
      editable: OPEN_STATUSES.includes(request.status),
    };
  }

  async clausesOf(draftId: string, versionNo: number): Promise<Clause[]> {
    const version = (await this.versions.findFirst({
      where: { draftId, versionNo },
      select: { clauses: true },
    })) as { clauses: unknown } | null;
    if (!version) {
      throw new AppError('NOT_FOUND', `ไม่พบร่างฉบับที่ ${versionNo}`);
    }
    return readClauses(version.clauses);
  }

  private async requireDraft(id: string, actor: Principal) {
    const draft = (await this.drafts.findFirst({
      where: { id, companyId: actor.activeCompanyId },
      include: { template: { select: { id: true, code: true, name: true } } },
    })) as DraftRow | null;
    if (!draft) throw new AppError('NOT_FOUND', 'ไม่พบร่างสัญญา');
    const request = await this.findRequest(draft.requestId, actor);
    if (!request) throw new AppError('NOT_FOUND', 'ไม่พบร่างสัญญา');
    return { draft, request };
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
