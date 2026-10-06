import { Injectable } from '@nestjs/common';
import { AppError } from '@request-management/share';
import type { Permission, Principal } from '@request-management/share';
import {
  LegalContractsService,
  OpportunitiesService,
  ProjectsService,
  QuotationsService,
  RequestsService,
  SolutionsService,
} from '@request-management/core-service';
import { currentStage, nextSteps } from './flow-stage';

/** One part of the deal's trail, or why this person cannot see it. */
export type FlowSection<T> =
  | { visible: true; data: T }
  | {
      visible: false;
      reason: 'missing_permission' | 'forbidden' | 'not_found';
    };

type Row = Record<string, unknown>;
type Page = { data: Row[] };

/** Enough rows for one deal; a deal with more is not a flow, it is a portfolio. */
const PAGE = 50;

const HANDOFFS = [
  ['solution', 'solutionRequestTypeCode'],
  ['demo', 'demoRequestTypeCode'],
  ['contract', 'contractRequestTypeCode'],
] as const;

/**
 * One deal, followed from the opportunity to the project, in one call.
 *
 * Nothing here reads the database. Every section is the service the
 * equivalent screen calls, with the acting person as the principal, so each
 * applies its own visibility (SCOPE-02) and its own 404 (SCOPE-03). A section
 * the person may not see — a salesperson without `legal.contract.read` looking
 * at contracts — comes back `visible: false` instead of failing the whole
 * answer: the trail stops where *their* screens would stop.
 *
 * Only the deal itself is mandatory. If it is out of reach the call answers
 * 404 like `GET crm/opportunities/{id}`, and nothing about what hangs off it
 * is disclosed.
 */
@Injectable()
export class FlowService {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly requests: RequestsService,
    private readonly solutions: SolutionsService,
    private readonly quotations: QuotationsService,
    private readonly contracts: LegalContractsService,
    private readonly projects: ProjectsService,
  ) {}

  async track(opportunityId: string, actor: Principal) {
    const deal = (await this.opportunities.findOne(
      opportunityId,
      actor,
    )) as Row;
    const opportunityCode = String(deal.opportunityCode);

    const [handoffs, solutions, quotations, contracts, projects] =
      await Promise.all([
        this.handoffs(deal, opportunityCode, actor),
        section(
          actor,
          null,
          () => this.solutions.forDeal(opportunityId, actor) as Promise<Row[]>,
        ),
        section(actor, null, async () => {
          const page = (await this.quotations.list(actor, {
            opportunity_id: opportunityId,
            current: 'true',
            page: 1,
            page_size: PAGE,
          })) as Page;
          return page.data;
        }),
        section(actor, ['legal.contract.read'], async () => {
          const page = (await this.contracts.list(actor, {
            opportunity_id: opportunityId,
            page: 1,
            page_size: PAGE,
          })) as Page;
          return page.data;
        }),
        section(actor, null, async () => {
          const page = (await this.projects.list(actor, {
            opportunity_id: opportunityId,
            page: 1,
            page_size: PAGE,
          })) as Page;
          return page.data;
        }),
      ]);

    const saleOrders = (deal.saleOrders as Row[] | undefined) ?? [];
    const stage = currentStage({
      dealStage: String(deal.stage),
      solutionRequests: countOf(handoffs.solution),
      solutions: countOf(solutions),
      quotations: countOf(quotations),
      saleOrders: saleOrders.length,
      contractRequests: countOf(handoffs.contract),
      contracts: countOf(contracts),
      projects: countOf(projects),
    });

    return {
      stage,
      next_steps: nextSteps(stage, {
        opportunityId,
        opportunityCode,
        solutionTypeCode: (deal.solutionRequestTypeCode as string) ?? null,
        contractTypeCode: (deal.contractRequestTypeCode as string) ?? null,
      }),
      opportunity: {
        id: deal.id,
        opportunityCode,
        title: deal.title,
        stage: deal.stage,
        status: deal.status,
        customer: deal.customer ?? null,
        prospectName: deal.prospectName ?? null,
        ownerUserId: deal.ownerUserId ?? null,
        expectedValue: deal.expectedValue ?? null,
        expectedCloseOn: deal.expectedCloseOn ?? null,
        solutionRequestTypeCode: deal.solutionRequestTypeCode ?? null,
        demoRequestTypeCode: deal.demoRequestTypeCode ?? null,
        contractRequestTypeCode: deal.contractRequestTypeCode ?? null,
      },
      handoffs,
      solutions,
      quotations,
      sale_orders: { visible: true, data: saleOrders } as FlowSection<Row[]>,
      contracts,
      projects,
    };
  }

  /**
   * The requests raised on the deal for each hand-off the company has
   * configured (CD-81 contract, CD-130 solution, CD-139 demo) — the same
   * `ref_type=opportunity` query the deal page makes for its cards. A type the
   * company has not set is `null`, not an empty list: there is no such step.
   */
  private async handoffs(deal: Row, opportunityCode: string, actor: Principal) {
    const entries = await Promise.all(
      HANDOFFS.map(async ([kind, field]) => {
        const typeCode = (deal[field] as string | null) ?? null;
        if (!typeCode) return [kind, null] as const;
        const requests = await section(actor, ['request.read'], async () => {
          const page = (await this.requests.list(actor, {
            ref_type: 'opportunity',
            ref_id: opportunityCode,
            type_code: typeCode,
            page: 1,
            page_size: PAGE,
          })) as Page;
          return page.data.map(handoffRow);
        });
        return [kind, { type_code: typeCode, requests }] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<
      (typeof HANDOFFS)[number][0],
      { type_code: string; requests: FlowSection<Row[]> } | null
    >;
  }
}

/**
 * Runs one read as the person, turning "you may not see this" into a value.
 *
 * `needs` is checked first where the screen gates the whole section on a
 * permission (the contract repository); otherwise the service's own
 * FORBIDDEN / NOT_FOUND is the answer. Anything else is a real fault and
 * propagates — a section that failed must not read as one that is empty.
 */
async function section<T>(
  actor: Principal,
  needs: readonly Permission[] | null,
  read: () => Promise<T>,
): Promise<FlowSection<T>> {
  if (needs && !needs.every((p) => actor.permissions.includes(p))) {
    return { visible: false, reason: 'missing_permission' };
  }
  try {
    return { visible: true, data: await read() };
  } catch (error) {
    if (error instanceof AppError && error.code === 'FORBIDDEN') {
      return { visible: false, reason: 'forbidden' };
    }
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      return { visible: false, reason: 'not_found' };
    }
    throw error;
  }
}

/**
 * A hand-off request as the trail shows it. The list row is the screen's —
 * the type's whole form schema, the private status token's hash — and none of
 * that says where the hand-off stands; `GET request/requests/{requestNo}` has
 * the rest for whoever needs it.
 */
function handoffRow(row: Row) {
  const form = (row.formData as Row | null) ?? {};
  return {
    id: row.id,
    requestNo: row.requestNo,
    typeCode: row.typeCode,
    status: row.status,
    subject: form.subject ?? null,
    requesterId: row.requesterId,
    assigneeUserId: row.assigneeUserId,
    submittedAt: row.submittedAt,
    dueAt: row.dueAt,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
  };
}

function countOf(
  value:
    | FlowSection<readonly unknown[]>
    | { requests: FlowSection<readonly unknown[]> }
    | null,
): number {
  if (!value) return 0;
  const found = 'requests' in value ? value.requests : value;
  return found.visible ? found.data.length : 0;
}
