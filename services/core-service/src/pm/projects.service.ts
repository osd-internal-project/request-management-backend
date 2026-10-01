import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AppError,
  AuditWriter,
  auditActor,
  hasPermission,
  paginated,
  Principal,
  PrismaTransactionService,
  toSkipTake,
} from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import { contractVisibleWhere } from '../crm/contract-visibility';
import { CustomerContractRepository } from '../crm/contract.repositories';
import { ContractInstallmentRepository } from '../crm/contract-installments.service';
import { ContractRequestPackageRepository } from '../crm/contract-request-package.service';
import { bangkokDay } from '../crm/kyc-rules';
import { NotificationsService } from '../notifications/notifications.service';
import type { QuoteState } from '../presales/solution-rules';
import {
  SolutionPartnerQuoteRepository,
  SolutionVersionRepository,
} from '../presales/solution.repositories';
import { RunNumberClient } from '../run-number/run-number.client';
import {
  ListProjectsQueryDto,
  OpenProjectDto,
  SaveProjectMembersDto,
  UpdateProjectDto,
} from './dto/project.dto';
import {
  ProjectMemberRepository,
  ProjectRepository,
} from './project.repositories';
import {
  buildBaseline,
  cleanMembers,
  openProblems,
  type MemberInput,
} from './project-rules';

const MANAGER_ROLE = 'ผู้จัดการโครงการ';
const MEMBER_ROLE = 'ทีมโครงการ';

const CONTRACT_SELECT = {
  id: true,
  companyId: true,
  contractNo: true,
  title: true,
  kind: true,
  status: true,
  value: true,
  currency: true,
  startOn: true,
  endOn: true,
  signedOn: true,
  signedVia: true,
  customerId: true,
  counterpartyName: true,
  opportunityId: true,
  requestId: true,
  customer: { select: { id: true, customerCode: true, nameTh: true } },
  project: { select: { id: true, projectNo: true } },
} as const;

interface ContractRow {
  id: string;
  companyId: string;
  contractNo: string;
  title: string;
  kind: string;
  status: string;
  value: Prisma.Decimal | null;
  currency: string;
  startOn: Date | null;
  endOn: Date;
  signedOn: Date | null;
  signedVia: string | null;
  customerId: string | null;
  counterpartyName: string | null;
  opportunityId: string | null;
  requestId: string | null;
  customer: { id: string; customerCode: string; nameTh: string } | null;
  project: { id: string; projectNo: string } | null;
}

const LIST_SELECT = {
  id: true,
  projectNo: true,
  name: true,
  status: true,
  managerUserId: true,
  startOn: true,
  endOn: true,
  contractValue: true,
  currency: true,
  openedAt: true,
  missing: true,
  contract: {
    select: {
      id: true,
      contractNo: true,
      title: true,
      counterpartyName: true,
      customer: { select: { id: true, customerCode: true, nameTh: true } },
    },
  },
  _count: { select: { members: true } },
} as const;

interface ProjectListRow {
  id: string;
  projectNo: string;
  name: string;
  status: string;
  managerUserId: string;
  startOn: Date | null;
  endOn: Date;
  contractValue: Prisma.Decimal | null;
  currency: string;
  openedAt: Date;
  missing: string[];
}

interface ProjectRow {
  id: string;
  companyId: string;
  projectNo: string;
  name: string;
  managerUserId: string;
  status: string;
  contractId: string;
  members: { userId: string; role: string | null }[];
  contract: { contractNo: string; ownerUserId: string };
}

const num = (value: Prisma.Decimal | null) =>
  value === null ? null : Number(value);

/**
 * CD-175 เปิดโครงการ — PM turns a signed contract into a project without
 * typing anything twice: the contract, the approved Solution's scope,
 * deliverables, BOQ, labour and cost, and the billing schedule are copied
 * into the project's baseline when it opens. It opens only on a contract
 * every party has signed (CD-160 e-sign, or Legal's record of a paper one).
 *
 * Who sees a project: `pm.project.read` every one of the company; its
 * manager and team their own. `pm.project.manage` opens and runs them; a
 * project's manager also keeps its team.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly projects: ProjectRepository,
    private readonly members: ProjectMemberRepository,
    private readonly contracts: CustomerContractRepository,
    private readonly installments: ContractInstallmentRepository,
    private readonly packages: ContractRequestPackageRepository,
    private readonly versions: SolutionVersionRepository,
    private readonly quotes: SolutionPartnerQuoteRepository,
    private readonly people: CompanyMemberRepository,
    private readonly runNumbers: RunNumberClient,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditWriter,
    private readonly transactions: PrismaTransactionService,
  ) {}

  // --- opening -------------------------------------------------------------------

  /** Signed contracts of the company still without a project. */
  async openable(actor: Principal, now = new Date()) {
    const rows = (await this.contracts.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: 'active',
        kind: { in: ['standard', 'other'] },
        signedOn: { not: null },
        endOn: { gte: new Date(`${bangkokDay(now)}T00:00:00Z`) },
        project: { is: null },
        ...contractVisibleWhere(actor),
      },
      orderBy: { signedOn: 'desc' },
      take: 200,
      select: CONTRACT_SELECT,
    })) as unknown as ContractRow[];
    return rows.map((row) => ({
      id: row.id,
      contractNo: row.contractNo,
      title: row.title,
      party: row.customer?.nameTh ?? row.counterpartyName ?? '',
      value: num(row.value),
      currency: row.currency,
      signedOn: row.signedOn,
      endOn: row.endOn,
    }));
  }

  /** What opening a project from this contract would give — and what stops it. */
  async preview(contractId: string, actor: Principal, now = new Date()) {
    const contract = await this.requireContract(contractId, actor);
    const problems = openProblems(
      { ...contract, projectNo: contract.project?.projectNo ?? null },
      bangkokDay(now),
    );
    const { baseline, missing, versionId } = await this.baselineOf(
      contract,
      now,
    );
    return {
      contract: {
        id: contract.id,
        contractNo: contract.contractNo,
        title: contract.title,
        signedOn: contract.signedOn,
        signedVia: contract.signedVia,
      },
      project: contract.project,
      canOpen: problems.length === 0,
      problems,
      missing,
      solutionVersionId: versionId,
      baseline,
    };
  }

  async open(dto: OpenProjectDto, actor: Principal, now = new Date()) {
    const contract = await this.requireContract(dto.contract_id, actor);
    const problems = openProblems(
      { ...contract, projectNo: contract.project?.projectNo ?? null },
      bangkokDay(now),
    );
    if (problems.length) {
      throw new AppError('CONFLICT', problems.join(' · '));
    }
    const team = cleanMembers(dto.members ?? [], dto.manager_user_id);
    await this.assertPeople(contract.companyId, [
      dto.manager_user_id,
      ...team.map((member) => member.userId),
    ]);
    const { baseline, missing, versionId } = await this.baselineOf(
      contract,
      now,
    );
    const projectNo = await this.runNumbers.issueUnused(
      {
        companyId: contract.companyId,
        docType: 'PROJECT',
        idempotencyKey: `project:${contract.id}`,
      },
      async (code) =>
        (await this.projects.count({
          where: { companyId: contract.companyId, projectNo: code },
        })) > 0,
    );
    const name = dto.name?.trim() || contract.title;

    const project = await this.transactions.execute(async (prisma) => {
      const row = (await this.projects.create(
        {
          data: {
            companyId: contract.companyId,
            projectNo,
            name,
            contractId: contract.id,
            customerId: contract.customerId,
            opportunityId: contract.opportunityId,
            solutionVersionId: versionId,
            managerUserId: dto.manager_user_id,
            startOn: contract.startOn,
            endOn: contract.endOn,
            contractValue: contract.value,
            currency: contract.currency,
            baseline: baseline as Prisma.InputJsonValue,
            missing,
            note: dto.note?.trim() || null,
            openedBy: actor.userId,
            members: {
              create: team.map((member) => ({
                userId: member.userId,
                role: member.role,
                addedBy: actor.userId,
              })),
            },
          },
          select: { id: true, projectNo: true, name: true },
        },
        { prisma },
      )) as { id: string; projectNo: string; name: string };
      await this.audit.record(
        {
          eventType: 'pm.project.opened',
          companyId: contract.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: row.id,
          after: {
            projectNo,
            contractId: contract.id,
            contractNo: contract.contractNo,
            managerUserId: dto.manager_user_id,
            members: team.map((member) => member.userId),
            solutionVersionId: versionId,
            missing,
          },
        },
        { prisma },
      );
      return row;
    });

    await this.tell(
      contract.companyId,
      project,
      contract.contractNo,
      [{ userId: dto.manager_user_id, role: MANAGER_ROLE }, ...team],
      actor.userId,
    );
    return this.detail(project.id, actor);
  }

  // --- reading -------------------------------------------------------------------

  async list(actor: Principal, query: ListProjectsQueryDto) {
    const { skip, take } = toSkipTake(query);
    const q = query.q?.trim();
    const where: Prisma.ProjectWhereInput = {
      companyId: actor.activeCompanyId,
      AND: [
        this.visibleWhere(actor, query.scope === 'mine'),
        ...(query.status ? [{ status: query.status as never }] : []),
        ...(q
          ? [
              {
                OR: [
                  { projectNo: { contains: q, mode: 'insensitive' as const } },
                  { name: { contains: q, mode: 'insensitive' as const } },
                  {
                    contract: {
                      contractNo: { contains: q, mode: 'insensitive' as const },
                    },
                  },
                ],
              },
            ]
          : []),
      ],
    };
    const [rows, total] = await Promise.all([
      this.projects.findMany({
        where,
        select: LIST_SELECT,
        orderBy: [{ openedAt: 'desc' }],
        skip,
        take,
      }) as Promise<ProjectListRow[]>,
      this.projects.count({ where }),
    ]);
    const names = await this.displayNames(rows.map((row) => row.managerUserId));
    return paginated(
      rows.map((row) => ({
        ...row,
        contractValue: num(row.contractValue),
        managerName: names.get(row.managerUserId) ?? null,
      })),
      query,
      total,
    );
  }

  async detail(id: string, actor: Principal) {
    const found = (await this.projects.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...this.visibleWhere(actor, false),
      },
      select: {
        ...LIST_SELECT,
        companyId: true,
        contractId: true,
        customerId: true,
        opportunityId: true,
        solutionVersionId: true,
        baseline: true,
        note: true,
        openedBy: true,
        updatedAt: true,
        contract: {
          select: {
            id: true,
            contractNo: true,
            title: true,
            counterpartyName: true,
            signedOn: true,
            signedVia: true,
            customer: {
              select: { id: true, customerCode: true, nameTh: true },
            },
          },
        },
        members: {
          orderBy: { addedAt: 'asc' },
          select: { userId: true, role: true, addedAt: true },
        },
      },
    })) as
      | ({
          managerUserId: string;
          openedBy: string;
          contractValue: Prisma.Decimal | null;
          members: { userId: string; role: string | null; addedAt: Date }[];
        } & Omit<ProjectListRow, 'contractValue'> & {
            baseline: unknown;
            note: string | null;
            contractId: string;
          })
      | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    const names = await this.displayNames([
      found.managerUserId,
      found.openedBy,
      ...found.members.map((member) => member.userId),
    ]);
    const manage = hasPermission(actor, 'pm.project.manage');
    return {
      ...found,
      contractValue: num(found.contractValue),
      managerName: names.get(found.managerUserId) ?? null,
      openedByName: names.get(found.openedBy) ?? null,
      members: found.members.map((member) => ({
        ...member,
        displayName: names.get(member.userId) ?? member.userId,
      })),
      canManage: manage,
      canEditTeam: manage || found.managerUserId === actor.userId,
    };
  }

  /** The project opened from a contract, for the contract's page. */
  async forContract(contractId: string, actor: Principal) {
    const found = (await this.projects.findFirst({
      where: {
        contractId,
        companyId: actor.activeCompanyId,
        ...this.visibleWhere(actor, false),
      },
      select: { id: true, projectNo: true, name: true, status: true },
    })) as Record<string, unknown> | null;
    return { project: found };
  }

  // --- running -------------------------------------------------------------------

  async update(id: string, dto: UpdateProjectDto, actor: Principal) {
    const project = await this.requireProject(id, actor);
    if (dto.manager_user_id && dto.manager_user_id !== project.managerUserId) {
      await this.assertPeople(project.companyId, [dto.manager_user_id]);
    }
    if (
      dto.status &&
      (project.status === 'closed' || project.status === 'cancelled')
    ) {
      throw new AppError('CONFLICT', 'โครงการปิดหรือยกเลิกแล้ว');
    }
    const data: Prisma.ProjectUpdateInput = { updatedBy: actor.userId };
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.manager_user_id !== undefined) {
      data.managerUserId = dto.manager_user_id;
    }
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.note !== undefined) data.note = dto.note.trim() || null;
    await this.transactions.execute(async (prisma) => {
      await this.projects.update({ where: { id }, data }, { prisma });
      // the new manager is not also a plain member
      if (dto.manager_user_id) {
        await prisma.projectMember.deleteMany({
          where: { projectId: id, userId: dto.manager_user_id },
        });
      }
      await this.audit.record(
        {
          eventType: 'pm.project.updated',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: id,
          before: {
            name: project.name,
            managerUserId: project.managerUserId,
            status: project.status,
          },
          after: dto as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
    });
    if (dto.manager_user_id && dto.manager_user_id !== project.managerUserId) {
      await this.tell(
        project.companyId,
        project,
        project.contract.contractNo,
        [{ userId: dto.manager_user_id, role: MANAGER_ROLE }],
        actor.userId,
      );
    }
    return this.detail(id, actor);
  }

  /** The whole team at once — `pm.project.manage`, or the project's manager. */
  async saveMembers(id: string, dto: SaveProjectMembersDto, actor: Principal) {
    const project = await this.requireProject(id, actor);
    if (
      !hasPermission(actor, 'pm.project.manage') &&
      project.managerUserId !== actor.userId
    ) {
      throw new AppError(
        'FORBIDDEN',
        'จัดทีมได้เฉพาะผู้จัดการโครงการ หรือผู้มีสิทธิ์จัดการโครงการ',
      );
    }
    const team = cleanMembers(dto.members, project.managerUserId);
    await this.assertPeople(
      project.companyId,
      team.map((member) => member.userId),
    );
    const before = new Set(project.members.map((member) => member.userId));
    await this.transactions.execute(async (prisma) => {
      await prisma.projectMember.deleteMany({ where: { projectId: id } });
      if (team.length) {
        await this.members.createMany(
          {
            data: team.map((member) => ({
              projectId: id,
              userId: member.userId,
              role: member.role,
              addedBy: actor.userId,
            })),
          },
          { prisma },
        );
      }
      await this.audit.record(
        {
          eventType: 'pm.project.team_saved',
          companyId: project.companyId,
          ...auditActor(actor),
          resourceType: 'project',
          resourceId: id,
          before: { members: project.members },
          after: { members: team } as unknown as Prisma.InputJsonValue,
        },
        { prisma },
      );
    });
    await this.tell(
      project.companyId,
      project,
      project.contract.contractNo,
      team.filter((member) => !before.has(member.userId)),
      actor.userId,
    );
    return this.detail(id, actor);
  }

  /** Number and name, for messages — no access check; callers have one. */
  async summary(id: string) {
    return (await this.projects.findFirst({
      where: { id },
      select: { id: true, projectNo: true, name: true },
    })) as { id: string; projectNo: string; name: string } | null;
  }

  /** CD-192 — every running project the caller may see: the portfolio. */
  async runningVisible(actor: Principal) {
    return (await this.projects.findMany({
      where: {
        companyId: actor.activeCompanyId,
        status: { in: ['active', 'on_hold'] },
        ...this.visibleWhere(actor, false),
      },
      select: {
        id: true,
        projectNo: true,
        name: true,
        status: true,
        managerUserId: true,
        endOn: true,
        contractValue: true,
        contract: {
          select: {
            contractNo: true,
            counterpartyName: true,
            customer: { select: { nameTh: true } },
          },
        },
      },
      orderBy: { projectNo: 'asc' },
    })) as unknown as {
      id: string;
      projectNo: string;
      name: string;
      status: string;
      managerUserId: string;
      endOn: Date;
      contractValue: Prisma.Decimal | null;
      contract: {
        contractNo: string;
        counterpartyName: string | null;
        customer: { nameTh: string } | null;
      };
    }[];
  }

  /** CD-192 — every running project of every company, for the weekly drafts. */
  async allRunning() {
    return (await this.projects.findMany({
      where: { status: { in: ['active', 'on_hold'] } },
      select: { id: true, companyId: true, managerUserId: true },
    })) as { id: string; companyId: string; managerUserId: string }[];
  }

  /**
   * For the project's own parts (milestones, …): the project if the caller
   * may see it (404 otherwise), and whether they may change its plan —
   * `pm.project.manage` or its manager, while it runs.
   */
  async access(id: string, actor: Principal) {
    const project = await this.requireProject(id, actor);
    const running = project.status === 'active' || project.status === 'on_hold';
    return {
      project,
      canEdit:
        running &&
        (hasPermission(actor, 'pm.project.manage') ||
          project.managerUserId === actor.userId),
    };
  }

  // --- helpers -------------------------------------------------------------------

  /** Everything with `pm.project.read`; otherwise the projects I run, am on, or hold a task in. */
  private visibleWhere(
    actor: Principal,
    mineOnly: boolean,
  ): Prisma.ProjectWhereInput {
    if (!mineOnly && hasPermission(actor, 'pm.project.read')) return {};
    return {
      OR: [
        { managerUserId: actor.userId },
        { members: { some: { userId: actor.userId } } },
        // CD-181 — whoever is handed a task sees the project it is in
        {
          tasks: {
            some: { ownerUserId: actor.userId, status: { not: 'cancelled' } },
          },
        },
      ],
    };
  }

  private async baselineOf(contract: ContractRow, now: Date) {
    const version = contract.opportunityId
      ? ((await this.versions.findFirst({
          where: {
            solution: { opportunityId: contract.opportunityId },
            approvalStatus: 'approved',
          },
          orderBy: { approvedAt: 'desc' },
          select: {
            id: true,
            versionNo: true,
            solutionId: true,
            inScope: true,
            outOfScope: true,
            deliverables: true,
            assumptions: true,
            boq: true,
            labor: true,
            solution: { select: { title: true } },
          },
        })) as {
          id: string;
          versionNo: number;
          solutionId: string;
          inScope: unknown;
          outOfScope: unknown;
          deliverables: unknown;
          assumptions: unknown;
          boq: unknown;
          labor: unknown;
          solution: { title: string };
        } | null)
      : null;
    const quotes = version
      ? ((await this.quotes.findMany({
          where: { versionId: version.id },
          select: {
            id: true,
            vendorName: true,
            quoteNo: true,
            quoteDate: true,
            validUntil: true,
            createdAt: true,
            lines: true,
          },
        })) as QuoteState[])
      : [];
    const requestPackage =
      !version && contract.requestId
        ? ((await this.packages.findFirst({
            where: { requestId: contract.requestId },
            select: {
              solutionTitle: true,
              solutionVersionNo: true,
              inScope: true,
              outOfScope: true,
              deliverables: true,
            },
          })) as {
            solutionTitle: string | null;
            solutionVersionNo: number | null;
            inScope: unknown;
            outOfScope: unknown;
            deliverables: unknown;
          } | null)
        : null;
    const installments = (await this.installments.findMany({
      where: { contractId: contract.id },
      orderBy: { seq: 'asc' },
      select: {
        seq: true,
        kind: true,
        label: true,
        amount: true,
        dueOn: true,
        dueNote: true,
        milestone: true,
      },
    })) as {
      seq: number;
      kind: string;
      label: string;
      amount: Prisma.Decimal;
      dueOn: Date | null;
      dueNote: string | null;
      milestone: string | null;
    }[];
    const built = buildBaseline(
      {
        contract: {
          contractNo: contract.contractNo,
          title: contract.title,
          value: num(contract.value),
          currency: contract.currency,
          startOn: contract.startOn,
          endOn: contract.endOn,
          signedOn: contract.signedOn,
          party: contract.customer?.nameTh ?? contract.counterpartyName ?? '',
        },
        version: version
          ? { ...version, solutionTitle: version.solution.title }
          : null,
        quotes,
        requestPackage,
        installments: installments.map((row) => ({
          ...row,
          amount: Number(row.amount),
        })),
      },
      now,
    );
    return { ...built, versionId: version?.id ?? null };
  }

  private async requireContract(id: string, actor: Principal) {
    const found = (await this.contracts.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...contractVisibleWhere(actor),
      },
      select: CONTRACT_SELECT,
    })) as ContractRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบสัญญาที่ระบุ');
    return found;
  }

  private async requireProject(id: string, actor: Principal) {
    const found = (await this.projects.findFirst({
      where: {
        id,
        companyId: actor.activeCompanyId,
        ...this.visibleWhere(actor, false),
      },
      select: {
        id: true,
        companyId: true,
        projectNo: true,
        name: true,
        managerUserId: true,
        status: true,
        contractId: true,
        members: { select: { userId: true, role: true } },
        contract: { select: { contractNo: true, ownerUserId: true } },
      },
    })) as ProjectRow | null;
    if (!found) throw new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ');
    return found;
  }

  /** Everyone named must be a person of this company. */
  private async assertPeople(companyId: string, userIds: string[]) {
    const unique = [...new Set(userIds)];
    if (!unique.length) return;
    const known = (await this.people.findMany({
      where: { id: { in: unique }, companies: { some: { companyId } } },
      select: { id: true },
    })) as { id: string }[];
    const unknown = unique.filter(
      (userId) => !known.some((row) => row.id === userId),
    );
    if (unknown.length) {
      throw new AppError(
        'VALIDATION_FAILED',
        'ผู้ใช้บางคนไม่ได้อยู่ในบริษัทนี้',
        unknown.map((userId) => ({ field: 'user_id', reason: userId })),
      );
    }
  }

  /** Tell the people just put on the project — not whoever did it. */
  private async tell(
    companyId: string,
    project: { id: string; projectNo: string; name: string },
    contractNo: string,
    people: readonly (MemberInput | { userId: string; role: string })[],
    actorId: string,
  ) {
    for (const person of people) {
      if (person.userId === actorId) continue;
      await this.notifications
        .projectAssigned(
          person.userId,
          companyId,
          project,
          contractNo,
          person.role === MANAGER_ROLE ? MANAGER_ROLE : MEMBER_ROLE,
        )
        .catch((error: Error) =>
          this.logger.warn(`project notice not sent: ${error.message}`),
        );
    }
  }

  private async displayNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, string>();
    const users = (await this.people.findMany({
      where: { id: { in: unique } },
      select: { id: true, displayName: true },
    })) as { id: string; displayName: string }[];
    return new Map(users.map((user) => [user.id, user.displayName]));
  }
}
