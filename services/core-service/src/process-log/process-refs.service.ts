import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppError } from '@request-management/share';
import { CustomerContractRepository } from '../crm/contract.repositories';
import {
  LeadRepository,
  OpportunityRepository,
  QuotationRepository,
  SaleOrderRepository,
} from '../crm/sales.repositories';
import { CrmConfigRepository } from '../crm/segment.repositories';
import { AcceptanceCertificateRepository } from '../delivery/delivery.repositories';
import { ProjectRepository } from '../pm/project.repositories';
import { SolutionRepository } from '../presales/solution.repositories';
import { RequestRepository } from '../requests/request.repository';
import { ProcessRefsDto, ProcessRefsQueryDto } from './dto/process-refs.dto';

/** What a workflow template reads as "none" (see process-refs.dto). */
const NONE = '-';
const LATEST = { createdAt: 'desc' } as const;

type Row = Record<string, unknown> | null;

/**
 * The deal's document numbers and screens, for OSD Workflow (21 ต.ค. 2569).
 *
 * The seven-stage workflow used to ask people to retype OPP / QT / SO / PRJ
 * numbers that CTD had already issued; it now asks here instead, and links
 * each task to the screen where the work is done. Read-only, pinned to the
 * key's company, numbers and states only — no amounts, no customer details
 * beyond the lead's name the workflow was started with.
 *
 * "Latest" wins where a deal has several of a thing (quotation versions, a
 * re-opened sale order): the workflow follows one deal forward, and the
 * newest record is the one its next step is about.
 */
@Injectable()
export class ProcessRefsService {
  constructor(
    private readonly leads: LeadRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly quotations: QuotationRepository,
    private readonly saleOrders: SaleOrderRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly crmConfig: CrmConfigRepository,
    private readonly solutions: SolutionRepository,
    private readonly requests: RequestRepository,
    private readonly projects: ProjectRepository,
    private readonly certificates: AcceptanceCertificateRepository,
    private readonly config: ConfigService,
  ) {}

  async resolve(
    query: ProcessRefsQueryDto,
    companyId: string | null | undefined,
  ): Promise<ProcessRefsDto> {
    if (!companyId) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ไม่ทราบบริษัท — ผูกบริษัทกับ API key หรือส่ง X-Company-Id',
        [{ field: 'X-Company-Id', reason: 'required' }],
      );
    }
    if (!query.lead_id && !query.opportunity_no) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ต้องระบุ lead_id หรือ opportunity_no',
        [{ field: 'lead_id', reason: 'required' }],
      );
    }

    // An unknown lead is not an error: a run started from a test, or before
    // the lead synced, still gets an answer — every field `-`.
    const lead = query.lead_id
      ? ((await this.leads.findFirst({
          where: { id: query.lead_id, companyId },
          select: {
            id: true,
            name: true,
            status: true,
            convertedOpportunityId: true,
          },
        })) as Row)
      : null;

    const opportunityWhere = lead?.convertedOpportunityId
      ? { id: lead.convertedOpportunityId as string, companyId }
      : query.opportunity_no
        ? { opportunityCode: query.opportunity_no, companyId }
        : null;
    const deal = opportunityWhere
      ? ((await this.opportunities.findFirst({
          where: opportunityWhere,
          select: { id: true, opportunityCode: true, stage: true },
        })) as Row)
      : null;

    const dealId = deal?.id as string | undefined;
    const [config, quotation, saleOrder, contract, nda, solution, project] =
      await Promise.all([
        this.crmConfig.findFirst({
          where: { companyId },
          select: {
            solutionRequestTypeCode: true,
            contractRequestTypeCode: true,
          },
        }) as Promise<Row>,
        dealId
          ? (this.quotations.findFirst({
              where: { companyId, opportunityId: dealId },
              orderBy: LATEST,
              select: {
                id: true,
                quotationNo: true,
                version: true,
                status: true,
              },
            }) as Promise<Row>)
          : null,
        dealId
          ? (this.saleOrders.findFirst({
              where: { companyId, opportunityId: dealId },
              orderBy: LATEST,
              select: { saleOrderCode: true, status: true, erpOrderNo: true },
            }) as Promise<Row>)
          : null,
        dealId
          ? (this.contracts.findFirst({
              where: { companyId, opportunityId: dealId, kind: { not: 'nda' } },
              orderBy: LATEST,
              select: { id: true, contractNo: true, status: true },
            }) as Promise<Row>)
          : null,
        dealId
          ? (this.contracts.findFirst({
              where: { companyId, opportunityId: dealId, kind: 'nda' },
              orderBy: LATEST,
              select: { id: true, contractNo: true },
            }) as Promise<Row>)
          : null,
        dealId
          ? (this.solutions.findFirst({
              where: { companyId, opportunityId: dealId },
              orderBy: LATEST,
              select: { id: true },
            }) as Promise<Row>)
          : null,
        dealId
          ? (this.projects.findFirst({
              where: { companyId, opportunityId: dealId },
              orderBy: { openedAt: 'desc' },
              select: { id: true, projectNo: true, status: true },
            }) as Promise<Row>)
          : null,
      ]);

    const dealCode = deal?.opportunityCode as string | undefined;
    const [solutionRequest, contractRequest, certificate] = await Promise.all([
      this.handoff(companyId, dealCode, config?.solutionRequestTypeCode),
      this.handoff(companyId, dealCode, config?.contractRequestTypeCode),
      project
        ? (this.certificates.findFirst({
            where: { companyId, projectId: project.id as string },
            orderBy: LATEST,
            select: { certificateNo: true, status: true },
          }) as Promise<Row>)
        : null,
    ]);

    const leadUrl = lead ? this.url(`leads/${lead.id}`) : this.url('leads');
    return {
      lead_id: text(lead?.id),
      lead_name: text(lead?.name),
      lead_status: text(lead?.status),
      lead_url: leadUrl,

      opportunity_id: text(deal?.id),
      opportunity_no: text(dealCode),
      opportunity_stage: text(deal?.stage),
      // Before the lead is converted, the lead's page is where that happens.
      opportunity_url: deal ? this.url(`opportunities/${deal.id}`) : leadUrl,

      solution_request_no: text(solutionRequest?.requestNo),
      solution_request_status: text(solutionRequest?.status),
      solution_request_url: this.dealOr(
        solutionRequest && `requests/${solutionRequest.id}`,
        deal,
      ),
      solution_url: this.dealOr(solution && `solutions/${solution.id}`, deal),

      quotation_no: text(quotation?.quotationNo),
      quotation_version: text(quotation?.version),
      quotation_status: text(quotation?.status),
      quotation_url: this.dealOr(
        quotation && `quotations/${quotation.id}`,
        deal,
      ),

      sale_order_no: text(saleOrder?.saleOrderCode),
      sale_order_status: text(saleOrder?.status),
      sale_order_erp_no: text(saleOrder?.erpOrderNo),
      // Sale orders have a list, not a page of their own; the deal shows its SO.
      sale_order_url: this.dealOr(null, deal),

      contract_request_no: text(contractRequest?.requestNo),
      contract_request_url: this.dealOr(
        contractRequest && `requests/${contractRequest.id}`,
        deal,
      ),
      contract_no: text(contract?.contractNo),
      contract_status: text(contract?.status),
      contract_url: this.dealOr(contract && `contracts/${contract.id}`, deal),
      nda_no: text(nda?.contractNo),
      nda_url: nda ? this.url(`contracts/${nda.id}`) : this.url('contracts'),

      project_no: text(project?.projectNo),
      project_status: text(project?.status),
      project_url: project
        ? this.url(`projects/${project.id}`)
        : this.url('projects'),
      acceptance_no: text(certificate?.certificateNo),
      acceptance_status: text(certificate?.status),
    };
  }

  /** The newest hand-off request of a configured type raised on the deal. */
  private handoff(
    companyId: string,
    dealCode: string | undefined,
    typeCode: unknown,
  ): Promise<Row> | null {
    if (!dealCode || typeof typeCode !== 'string' || !typeCode) return null;
    return this.requests.findFirst({
      where: { companyId, refType: 'opportunity', refId: dealCode, typeCode },
      orderBy: LATEST,
      select: { id: true, requestNo: true, status: true },
    }) as Promise<Row>;
  }

  /** The record's own page, else the deal's (where it gets made), else the list. */
  private dealOr(path: string | null | false | undefined, deal: Row): string {
    if (path) return this.url(path);
    return deal
      ? this.url(`opportunities/${deal.id}`)
      : this.url('opportunities');
  }

  /** `<PUBLIC_WEB_URL>/pages/<path>`; unset base = the path alone. */
  private url(path: string): string {
    const base = (this.config.get<string>('publicWebUrl') ?? '').replace(
      /\/$/,
      '',
    );
    return `${base}/pages/${path}`;
  }
}

function text(value: unknown): string {
  if (value === null || value === undefined || value === '') return NONE;
  return String(value);
}
