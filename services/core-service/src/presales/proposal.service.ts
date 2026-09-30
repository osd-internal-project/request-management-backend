import { Injectable } from '@nestjs/common';
import {
  AppError,
  AuditWriter,
  auditActor,
  Principal,
} from '@request-management/share';
import { OpportunityRepository } from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { SolutionVersionRepository } from './solution.repositories';
import { SolutionsService } from './solutions.service';
import {
  ASSUMPTION_CATEGORY_LABELS,
  BOQ_KIND_LABELS,
  DEPENDENCY_CATEGORIES,
  readAssumptions,
  readBoq,
  readDeliverables,
  readLines,
} from './solution-rules';

interface ProposalVersionRow {
  versionNo: number;
  status: string;
  approvalStatus: string;
  approvedAt: Date | null;
  lockedAt: Date | null;
  summary: string;
  design: string;
  assumptions: unknown;
  inScope: unknown;
  outOfScope: unknown;
  deliverables: unknown;
  boq: unknown;
}

interface ProposalDealRow {
  opportunityCode: string;
  title: string;
  prospectName: string | null;
  prospectContactName: string | null;
  customer: { customerCode: string; nameTh: string } | null;
  company: { name: string };
}

/**
 * CD-137 — ข้อเสนอทางเทคนิค (user decisions 30 ก.ย. 2569): a print page on
 * the company letterhead, like the quotation, put together live from an
 * **approved** Solution version — nothing is stored, the approved version is
 * already frozen, so printing it again gives the same document.
 *
 * It goes to the customer, so it carries **no cost at all**: the BOQ loses
 * its reference unit cost here, in the query result, not by masking — the
 * same rule as the quotation print. Nor does it carry the internal registers
 * (requirements, risks, clarifications, TOR compliance).
 *
 * Readable by whoever may read the Solution (Pre-Sales, or the salesperson
 * on the deal); each print is audited.
 */
@Injectable()
export class ProposalService {
  constructor(
    private readonly solutions: SolutionsService,
    private readonly versions: SolutionVersionRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly configs: CrmConfigRepository,
    private readonly audit: AuditWriter,
  ) {}

  async printView(id: string, versionNo: number, actor: Principal) {
    const solution = await this.solutions.requireReadable(id, actor);
    const version = (await this.versions.findFirst({
      where: { solutionId: id, versionNo },
      select: {
        versionNo: true,
        status: true,
        approvalStatus: true,
        approvedAt: true,
        lockedAt: true,
        summary: true,
        design: true,
        assumptions: true,
        inScope: true,
        outOfScope: true,
        deliverables: true,
        boq: true,
      },
    })) as ProposalVersionRow | null;
    if (!version) throw new AppError('NOT_FOUND', 'ไม่พบเวอร์ชันที่ระบุ');
    if (version.approvalStatus !== 'approved') {
      throw new AppError(
        'CONFLICT',
        `พิมพ์ข้อเสนอทางเทคนิคได้เฉพาะเวอร์ชันที่อนุมัติแล้ว — เวอร์ชัน ${versionNo} ยังไม่อนุมัติ`,
      );
    }

    const [deal, config] = await Promise.all([
      this.opportunities.findFirst({
        where: { id: solution.opportunityId },
        select: {
          opportunityCode: true,
          title: true,
          prospectName: true,
          prospectContactName: true,
          customer: { select: { customerCode: true, nameTh: true } },
          company: { select: { name: true } },
        },
      }) as Promise<ProposalDealRow | null>,
      this.configs.findFirst({
        where: { companyId: solution.companyId },
      }) as Promise<Record<string, string | null> | null>,
    ]);

    await this.audit.record({
      eventType: 'presales.solution.proposal_printed',
      companyId: solution.companyId,
      ...auditActor(actor),
      resourceType: 'solution',
      resourceId: id,
      after: { versionNo },
    });

    const assumptions = readAssumptions(version.assumptions).map((item) => ({
      ...item,
      categoryLabel: ASSUMPTION_CATEGORY_LABELS[item.category],
      isDependency: DEPENDENCY_CATEGORIES.includes(item.category),
    }));
    return {
      /** Same letterhead fields as the quotation print. */
      letterhead: {
        nameTh:
          config?.letterheadNameTh ?? deal?.company.name ?? solution.title,
        nameEn: config?.letterheadNameEn ?? null,
        taxId: config?.letterheadTaxId ?? null,
        branch: config?.letterheadBranch ?? null,
        address: config?.letterheadAddress ?? null,
        phone: config?.letterheadPhone ?? null,
        email: config?.letterheadEmail ?? null,
        website: config?.letterheadWebsite ?? null,
        logo: config?.letterheadLogo ?? null,
      },
      solution: { id: solution.id, title: solution.title },
      deal: deal
        ? {
            opportunityCode: deal.opportunityCode,
            title: deal.title,
            partyName: deal.customer?.nameTh ?? deal.prospectName,
            customerCode: deal.customer?.customerCode ?? null,
            contactName: deal.prospectContactName,
          }
        : null,
      version: {
        versionNo: version.versionNo,
        approvedAt: version.approvedAt,
        lockedAt: version.lockedAt,
        /** A newer version replaced it — the page marks the copy as old. */
        superseded: version.status === 'superseded',
        summary: version.summary,
        design: version.design,
        inScope: readLines(version.inScope),
        outOfScope: readLines(version.outOfScope),
        deliverables: readDeliverables(version.deliverables),
      },
      // No reference cost — this is the customer's copy.
      boq: readBoq(version.boq).map((line, index) => ({
        lineNo: index + 1,
        kind: line.kind,
        kindLabel: BOQ_KIND_LABELS[line.kind],
        productCode: line.productCode,
        name: line.name,
        description: line.description,
        model: line.model,
        quantity: line.quantity,
        unit: line.unit,
      })),
      assumptions: assumptions.filter((item) => !item.isDependency),
      dependencies: assumptions.filter((item) => item.isDependency),
    };
  }
}
