import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  BaseRepository,
  Principal,
  PrismaService,
  type TQueryClient,
} from '@request-management/share';
import { DomainEventsService } from '../events/domain-events.service';
import { DOMAIN_EVENTS } from '../events/event-catalog';
import { SolutionVersionRepository } from '../presales/solution.repositories';
import {
  contractAssumptionsText,
  type FeasibilityVerdict,
} from '../presales/solution-rules';
import { RequestRepository } from '../requests/request.repository';
import {
  NegotiationRoundRepository,
  OpportunityRepository,
} from './sales.repositories';
import { CrmConfigRepository } from './segment.repositories';
import type { RecordedTerm } from './trade-terms';

/** CD-145 ข้อมูลการค้าและขอบเขตงานที่แนบคำขอจัดทำสัญญา. */
@Injectable()
export class ContractRequestPackageRepository extends BaseRepository<
  PrismaService['contractRequestPackage']
> {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected delegate(client: TQueryClient) {
    return client.contractRequestPackage;
  }
}

/** A request Legal still works on — the package may be captured again. */
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
  companyId: string;
  typeCode: string;
  status: string;
  refType: string | null;
  refId: string | null;
}

export interface Deliverable {
  title: string;
  description?: string;
  criteria?: string[];
}

export interface PackageRow {
  requestId: string;
  opportunityId: string;
  negotiationRoundNo: number | null;
  tradeTerms: unknown;
  solutionId: string | null;
  solutionTitle: string | null;
  solutionVersionNo: number | null;
  inScope: unknown;
  outOfScope: unknown;
  deliverables: unknown;
  assumptionsText: string | null;
  missing: string[];
  capturedAt: Date;
  capturedBy: string | null;
}

const texts = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

export const readDeliverables = (value: unknown): Deliverable[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Deliverable =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as Deliverable).title === 'string',
      )
    : [];

/**
 * CD-145 — คำขอจัดทำสัญญา. When a contract request (the type CRM settings
 * name, CD-81) raised from a deal is submitted, what Legal needs travels
 * with it: the terms agreed in the deal's latest negotiation round (CD-79)
 * and the approved Solution's scope of work — in and out of scope, the
 * deliverables with their acceptance criteria (CD-134/143) — plus its
 * assumptions (CD-133). It is a snapshot: later edits to the deal do not
 * change what was asked, and Legal captures it again when they need to.
 * The draft (CD-146) fills its variables from it.
 */
@Injectable()
export class ContractRequestPackageService implements OnModuleInit {
  private readonly logger = new Logger(ContractRequestPackageService.name);

  constructor(
    private readonly packages: ContractRequestPackageRepository,
    private readonly requests: RequestRepository,
    private readonly configs: CrmConfigRepository,
    private readonly opportunities: OpportunityRepository,
    private readonly rounds: NegotiationRoundRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly events: DomainEventsService,
    private readonly audit: AuditWriter,
  ) {}

  onModuleInit(): void {
    this.events.on(DOMAIN_EVENTS.requestSubmitted, (event) => {
      const payload = event.payload as { request_id: string };
      return this.captureOnSubmit(payload.request_id).catch((error: Error) =>
        this.logger.warn(`contract request package: ${error.message}`),
      );
    });
  }

  /** The package on a request's page (Legal). */
  async view(requestId: string, actor: Principal) {
    const request = await this.findRequest(requestId, actor.activeCompanyId);
    if (!request || !(await this.isContractRequest(request))) {
      return { eligible: false, editable: false, package: null };
    }
    const row = (await this.packages.findFirst({
      where: { requestId },
    })) as PackageRow | null;
    return {
      eligible: request.refType === 'opportunity',
      editable: OPEN_STATUSES.includes(request.status),
      package: row ? present(row) : null,
    };
  }

  /** Capture it again — the deal moved on after the request was sent. */
  async refresh(requestId: string, actor: Principal) {
    const request = await this.findRequest(requestId, actor.activeCompanyId);
    if (!request || !(await this.isContractRequest(request))) {
      throw new AppError('NOT_FOUND', 'ไม่พบคำขอจัดทำสัญญาที่ระบุ');
    }
    if (request.refType !== 'opportunity' || !request.refId) {
      throw new AppError('CONFLICT', 'คำขอนี้ไม่ได้ยื่นจากโอกาสการขาย');
    }
    if (!OPEN_STATUSES.includes(request.status)) {
      throw new AppError('CONFLICT', 'คำขอนี้ไม่ได้อยู่ระหว่างดำเนินการ');
    }
    const row = await this.capture(request, actor.userId);
    await this.audit.record({
      eventType: 'legal.contract_request.package_refreshed',
      companyId: request.companyId,
      ...auditActor(actor),
      resourceType: 'request',
      resourceId: request.id,
      after: {
        negotiationRoundNo: row?.negotiationRoundNo ?? null,
        solutionVersionNo: row?.solutionVersionNo ?? null,
        missing: row?.missing ?? [],
      },
    });
    return this.view(requestId, actor);
  }

  /** The package of a request, if captured — for the draft's variables. */
  async of(requestId: string): Promise<PackageRow | null> {
    return await this.packages.findFirst({
      where: { requestId },
    });
  }

  async captureOnSubmit(requestId: string): Promise<void> {
    const request = (await this.requests.findFirst({
      where: { id: requestId },
      select: {
        id: true,
        companyId: true,
        typeCode: true,
        status: true,
        refType: true,
        refId: true,
      },
    })) as RequestRef | null;
    if (!request || request.refType !== 'opportunity' || !request.refId) {
      return;
    }
    if (!(await this.isContractRequest(request))) return;
    await this.capture(request, null);
  }

  private async capture(request: RequestRef, actorId: string | null) {
    const deal = (await this.opportunities.findFirst({
      where: {
        companyId: request.companyId,
        OR: [{ opportunityCode: request.refId! }, { id: request.refId! }],
      },
      select: { id: true },
    })) as { id: string } | null;
    if (!deal) return null;

    const round = (await this.rounds.findFirst({
      where: { opportunityId: deal.id },
      orderBy: { roundNo: 'desc' },
      select: { roundNo: true, terms: true },
    })) as { roundNo: number; terms: unknown } | null;
    const version = (await this.versions.findFirst({
      where: {
        solution: { opportunityId: deal.id },
        approvalStatus: 'approved',
      },
      orderBy: { approvedAt: 'desc' },
      select: {
        versionNo: true,
        inScope: true,
        outOfScope: true,
        deliverables: true,
        assumptions: true,
        feasibility: true,
        feasibilityNote: true,
        solution: { select: { id: true, title: true } },
      },
    })) as {
      versionNo: number;
      inScope: unknown;
      outOfScope: unknown;
      deliverables: unknown;
      assumptions: unknown;
      feasibility: FeasibilityVerdict;
      feasibilityNote: string;
      solution: { id: string; title: string };
    } | null;

    const missing: string[] = [];
    if (!round) missing.push('ดีลนี้ยังไม่มีการบันทึกการต่อรองเงื่อนไข');
    if (!version) missing.push('ดีลนี้ยังไม่มี Solution ที่อนุมัติแล้ว');
    const data = {
      companyId: request.companyId,
      opportunityId: deal.id,
      negotiationRoundNo: round?.roundNo ?? null,
      tradeTerms: (Array.isArray(round?.terms)
        ? round.terms
        : []) as Prisma.InputJsonValue,
      solutionId: version?.solution.id ?? null,
      solutionTitle: version?.solution.title ?? null,
      solutionVersionNo: version?.versionNo ?? null,
      inScope: texts(version?.inScope) as Prisma.InputJsonValue,
      outOfScope: texts(version?.outOfScope) as Prisma.InputJsonValue,
      deliverables: readDeliverables(
        version?.deliverables,
      ) as unknown as Prisma.InputJsonValue,
      assumptionsText: version
        ? contractAssumptionsText(version) || null
        : null,
      missing,
      capturedAt: new Date(),
      capturedBy: actorId,
    };
    return (await this.packages.upsert({
      where: { requestId: request.id },
      create: { requestId: request.id, ...data },
      update: data,
    })) as PackageRow;
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

  private async findRequest(id: string, companyId: string) {
    return (await this.requests.findFirst({
      where: { id, companyId },
      select: {
        id: true,
        companyId: true,
        typeCode: true,
        status: true,
        refType: true,
        refId: true,
      },
    })) as RequestRef | null;
  }
}

/** The package as the screen reads it. */
export function present(row: PackageRow) {
  return {
    capturedAt: row.capturedAt,
    capturedOnSubmit: row.capturedBy === null,
    negotiationRoundNo: row.negotiationRoundNo,
    tradeTerms: (Array.isArray(row.tradeTerms)
      ? row.tradeTerms
      : []) as RecordedTerm[],
    solution: row.solutionId
      ? {
          id: row.solutionId,
          title: row.solutionTitle,
          versionNo: row.solutionVersionNo,
        }
      : null,
    inScope: texts(row.inScope),
    outOfScope: texts(row.outOfScope),
    deliverables: readDeliverables(row.deliverables),
    assumptionsText: row.assumptionsText,
    missing: row.missing,
  };
}
