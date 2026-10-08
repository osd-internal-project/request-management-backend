import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  ContractAccessRepository,
  ContractDocumentRepository,
  CustomerContractRepository,
} from '../crm/contract.repositories';
import { ContractInstallmentRepository } from '../crm/contract-installments.service';
import { ContractRequestPackageRepository } from '../crm/contract-request-package.service';
import { CustomerRepository } from '../crm/customer.repository';
import { LegalContractsService } from '../crm/legal-contracts.service';
import {
  SolutionPartnerQuoteRepository,
  SolutionVersionRepository,
} from '../presales/solution.repositories';
import {
  ProjectIntakeRepository,
  ProjectMemberRepository,
  ProjectRepository,
  ProjectBudgetRepository,
  ProjectChangeRequestRepository,
  ProjectCustomerLogRepository,
  ProjectIssueRepository,
  ProjectProgressRepository,
  ProjectRiskRepository,
  ProjectRiskReviewRepository,
  ProjectTaskFileRepository,
  ProjectTaskLinkRepository,
  ProjectTaskRepository,
  ProjectTaskUpdateRepository,
  WorkCalendarRepository,
  InstallmentBillingRepository,
  ProjectCloseDocumentRepository,
  ProjectCloseoutRepository,
  ProjectLessonRepository,
  ProjectStatusReportRepository,
  ProjectTestItemRepository,
  ProjectTestRunRepository,
  ProjectReadinessItemRepository,
  ProjectAsBuiltDocumentRepository,
  ProjectAsBuiltDeviationRepository,
  ProjectAcceptanceRepository,
  ProjectAcceptanceItemRepository,
  ProjectUatFindingRepository,
  ProjectInstallationRepository,
  ProjectSurveyPhotoRepository,
  ProjectSurveyRepository,
  ProjectDefectRepository,
  ProjectDeploymentRepository,
  ProjectEnvironmentRepository,
  ProjectReleaseRepository,
  ProjectSoftwareDocumentRepository,
  ProjectConfigHistoryRepository,
  ProjectConfigItemRepository,
  ProjectIntegrationRepository,
  ProjectTechChangeRepository,
  ProjectCostAlertRepository,
  ProjectCostRepository,
  ProjectBookingPriorityRepository,
  ProjectResourceRequestRepository,
  ProjectDesignRepository,
  ProjectDesignFileRepository,
  ProjectTaskEquipmentRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { TaskWorkService } from './task-work.service';
import { ProgressService } from './progress.service';
import { BudgetService } from './budget.service';
import { ChangeRequestsService } from './change-requests.service';
import { ProjectRisksService } from './project-risks.service';
import { ProjectIssuesService } from './project-issues.service';
import { CustomerLogsService } from './customer-logs.service';
import { PaymentsService } from './payments.service';
import { CloseoutService } from './closeout.service';
import { StatusReportsService } from './status-reports.service';
import { TestsService } from './tests.service';
import { ReadinessService } from './readiness.service';
import { AsBuiltService } from './as-built.service';
import { AcceptanceService } from './acceptance.service';
import { UatService } from './uat.service';
import { InstallationsService } from './installations.service';
import { SurveysService } from './surveys.service';
import { DevPlanService } from './dev-plan.service';
import { DefectsService } from './defects.service';
import { ReleasesService } from './releases.service';
import { SoftwareDocsService } from './software-docs.service';
import { ConfigsService } from './configs.service';
import { IntegrationsService } from './integrations.service';
import { TechChangesService } from './tech-changes.service';
import { ProjectCostsService } from './project-costs.service';
import { ResourcesService } from './resources.service';
import { ServiceAssetsService } from '../support/service-assets.service';
import { EntitlementsService } from '../support/entitlements.service';
import {
  ServiceAssetHistoryRepository,
  ServiceAssetRepository,
  ServiceEntitlementAssetRepository,
  ServiceEntitlementRepository,
} from '../support/support.repositories';
import { HrBookingRepository } from '../hr/hr.repositories';
import type { DayAvailability } from '../hr/leave-rules';
import { CompanyRepository } from '../crm/product.repositories';
import { CustomerContactRepository } from '../crm/customer-child.repositories';
import { TaskEvidenceService } from './task-evidence.service';
import { DesignsService } from './designs.service';
import { TechPlanService } from './tech-plan.service';
import { ContractRiskAssessmentRepository } from '../crm/contract-risk.service';
import { ContractObligationRepository } from '../crm/contract-obligations.service';
import {
  SolutionRiskRepository,
  SolutionVersionRepository as VersionRepository,
} from '../presales/solution.repositories';
import { ProjectMilestoneRepository } from './project.repositories';
import { ContractInstallmentsService } from '../crm/contract-installments.service';
import {
  ContractTermsRepository,
  ContractTermsService,
} from '../crm/contract-terms.service';
import { Readable } from 'node:stream';

/**
 * CD-175 — opening a project runs on a relation filter (`project: null`),
 * a unique contract per project, nested member writes and visibility through
 * the team: none of which a mocked Prisma checks. Against a real database:
 * a contract is refused until Legal records its signed copy, then opens
 * with its billing schedule copied in, once only, and is seen by its team
 * but not by an outsider. Skipped without a database:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test projects.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)(
  'CD-175 open a project (real Postgres)',
  () => {
    let prisma: PrismaClient;
    let projects: ProjectsService;
    let legal: LegalContractsService;
    let companyId: string;
    let pm: string;
    let engineer: string;
    let outsider: string;
    let contractId: string;
    let projectId = '';
    let milestones: MilestonesService;
    let schedule: ContractInstallmentsService;
    const billable: { userId: string; milestone: string }[] = [];
    const stored = new Map<string, Buffer>();
    const tag = randomUUID().slice(0, 8);
    const told: { userId: string; role: string }[] = [];

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      const company = await prisma.company.findFirstOrThrow({
        select: { id: true },
      });
      companyId = company.id;
      // three people of this company, made for the test and removed after
      [pm, engineer, outsider] = await Promise.all(
        ['pm', 'eng', 'out'].map(async (who) => {
          const user = await prisma.user.create({
            data: {
              keycloakId: `t175-${who}-${tag}`,
              username: `t175-${who}-${tag}`,
              displayName: `ทดสอบ ${who}`,
              companies: { create: { companyId } },
            },
            select: { id: true },
          });
          return String(user.id);
        }),
      );
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      projects = new ProjectsService(
        new ProjectRepository(client),
        new ProjectMemberRepository(client),
        new CustomerContractRepository(client),
        new ContractInstallmentRepository(client),
        new ContractRequestPackageRepository(client),
        new SolutionVersionRepository(client),
        new SolutionPartnerQuoteRepository(client),
        new CompanyMemberRepository(client),
        {
          issueUnused: () => Promise.resolve(`PRJ-T175-${tag}`),
        } as never,
        {
          projectAssigned: (
            userId: string,
            _company: string,
            _project: unknown,
            _contractNo: string,
            role: string,
          ) => {
            told.push({ userId, role });
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
        new ProjectIntakeRepository(client),
      );
      milestones = new MilestonesService(
        projects,
        new ProjectMilestoneRepository(client),
        new ProjectRepository(client),
        new ContractInstallmentRepository(client),
        new CompanyMemberRepository(client),
        {
          milestoneAchieved: (
            userId: string,
            _company: string,
            input: { milestone: string },
          ) => {
            billable.push({ userId, milestone: input.milestone });
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
        {
          put: (key: string, body: Buffer) => {
            stored.set(key, body);
            return Promise.resolve();
          },
          get: (key: string) =>
            Promise.resolve(Readable.from([stored.get(key)!])),
          remove: (key: string) => {
            stored.delete(key);
            return Promise.resolve();
          },
        },
      );
      schedule = new ContractInstallmentsService(
        new ContractInstallmentRepository(client),
        new CustomerContractRepository(client),
        transactions,
        audit,
      );
      legal = new LegalContractsService(
        new CustomerContractRepository(client),
        new ContractDocumentRepository(client),
        new ContractAccessRepository(client),
        new CustomerRepository(client),
        new CompanyMemberRepository(client),
        audit,
        transactions,
        {} as never,
        { changed: () => Promise.resolve(0) } as never,
      );

      const contract = await prisma.customerContract.create({
        data: {
          companyId,
          contractNo: `CTR-T175-${tag}`,
          title: 'ติดตั้งระบบกล้อง อาคาร A',
          counterpartyName: 'บริษัท ทดสอบโครงการ จำกัด',
          startOn: new Date('2026-10-01T00:00:00Z'),
          endOn: new Date('2027-09-30T00:00:00Z'),
          value: 150000,
          ownerUserId: pm,
          installments: {
            create: [
              {
                companyId,
                seq: 1,
                kind: 'deposit',
                label: 'มัดจำ',
                amount: 45000,
                dueNote: 'เมื่อลงนาม',
              },
              {
                companyId,
                seq: 2,
                kind: 'final',
                label: 'งวดสุดท้าย',
                amount: 105000,
                milestone: 'ตรวจรับงาน',
              },
            ],
          },
          documents: {
            create: {
              companyId,
              fileName: 'signed.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 1,
              storageKey: `test/${tag}`,
              textStatus: 'empty',
              uploadedBy: pm,
            },
          },
        },
        select: { id: true, documents: { select: { id: true } } },
      });
      contractId = contract.id;
    });

    afterAll(async () => {
      await prisma.projectTask.updateMany({
        where: { projectId },
        data: { parentId: null },
      });
      await prisma.projectIntake.deleteMany({ where: { projectId } });
      await prisma.projectTask.deleteMany({ where: { projectId } });
      await prisma.projectMilestone.deleteMany({ where: { projectId } });
      await prisma.serviceEntitlementAsset.deleteMany({
        where: { asset: { projectId } },
      });
      await prisma.serviceEntitlement.deleteMany({ where: { projectId } });
      await prisma.serviceAssetHistory.deleteMany({
        where: { asset: { projectId } },
      });
      await prisma.serviceAsset.deleteMany({ where: { projectId } });
      await prisma.projectBookingPriority.deleteMany({ where: { projectId } });
      await prisma.projectResourceRequest.deleteMany({ where: { projectId } });
      await prisma.projectCostAlert.deleteMany({ where: { projectId } });
      await prisma.projectCost.deleteMany({ where: { projectId } });
      await prisma.projectTechChange.deleteMany({ where: { projectId } });
      await prisma.projectIntegration.deleteMany({ where: { projectId } });
      await prisma.projectConfigHistory.deleteMany({
        where: { item: { projectId } },
      });
      await prisma.projectConfigItem.deleteMany({ where: { projectId } });
      await prisma.projectSoftwareDocument.deleteMany({ where: { projectId } });
      await prisma.projectDeployment.deleteMany({
        where: { release: { projectId } },
      });
      await prisma.projectRelease.deleteMany({ where: { projectId } });
      await prisma.projectEnvironment.deleteMany({ where: { projectId } });
      await prisma.projectDefect.deleteMany({ where: { projectId } });
      await prisma.projectSurveyPhoto.deleteMany({
        where: { survey: { projectId } },
      });
      await prisma.projectSurvey.deleteMany({ where: { projectId } });
      await prisma.projectDesignFile.deleteMany({
        where: { design: { projectId } },
      });
      await prisma.projectDesign.deleteMany({ where: { projectId } });
      await prisma.projectInstallation.deleteMany({ where: { projectId } });
      await prisma.projectUatFinding.deleteMany({ where: { projectId } });
      await prisma.projectAcceptanceItem.deleteMany({
        where: { acceptance: { projectId } },
      });
      await prisma.projectAcceptance.deleteMany({ where: { projectId } });
      await prisma.projectReadinessItem.deleteMany({ where: { projectId } });
      await prisma.projectAsBuiltDeviation.deleteMany({ where: { projectId } });
      await prisma.projectAsBuiltDocument.deleteMany({ where: { projectId } });
      await prisma.projectTestRun.deleteMany({
        where: { item: { projectId } },
      });
      await prisma.projectTestItem.deleteMany({ where: { projectId } });
      await prisma.projectStatusReport.deleteMany({ where: { projectId } });
      await prisma.projectCloseout.deleteMany({ where: { projectId } });
      await prisma.projectCloseDocument.deleteMany({ where: { projectId } });
      await prisma.projectLesson.deleteMany({ where: { projectId } });
      await prisma.projectIssue.deleteMany({ where: { projectId } });
      await prisma.projectCustomerLog.deleteMany({ where: { projectId } });
      await prisma.projectChangeRequest.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { contractId } });
      await prisma.contractInstallmentBilling.deleteMany({
        where: { contractId },
      });
      await prisma.contractInstallment.deleteMany({ where: { contractId } });
      await prisma.contractTerms.deleteMany({ where: { contractId } });
      await prisma.contractRiskAssessment.deleteMany({ where: { contractId } });
      await prisma.contractDocument.deleteMany({ where: { contractId } });
      await prisma.customerContract.deleteMany({ where: { id: contractId } });
      const people = [pm, engineer, outsider];
      await prisma.userCompany.deleteMany({
        where: { userId: { in: people } },
      });
      await prisma.user.deleteMany({ where: { id: { in: people } } });
      await prisma.$disconnect();
    });

    const as = (userId: string, permissions: string[]) =>
      ({
        userId,
        activeCompanyId: companyId,
        displayName: 'ทดสอบ',
        permissions,
      }) as unknown as Principal;
    const manager = () =>
      as(pm, ['pm.project.read', 'pm.project.manage', 'notification.read']);
    const lawyer = () =>
      as(pm, ['legal.contract.read', 'legal.contract.manage']);

    it('CD-175: refused until signed; Legal records the paper copy; opens once with its schedule; seen by the team only', async () => {
      // not signed yet: not offered, and refused
      const before = await projects.preview(contractId, manager());
      expect(before.canOpen).toBe(false);
      expect(before.problems.join()).toContain('ยังไม่ได้ลงนามครบ');
      expect(
        (await projects.openable(manager())).map((row) => row.id),
      ).not.toContain(contractId);
      await expect(
        projects.open(
          { contract_id: contractId, manager_user_id: pm },
          manager(),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // Legal records it signed on paper — not in the future, with its own file
      const document = await prisma.contractDocument.findFirstOrThrow({
        where: { contractId },
        select: { id: true },
      });
      await expect(
        legal.recordSigned(
          contractId,
          { signed_on: '2099-01-01', document_id: document.id },
          lawyer(),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        legal.recordSigned(
          contractId,
          { signed_on: '2026-09-29', document_id: randomUUID() },
          lawyer(),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await legal.recordSigned(
        contractId,
        { signed_on: '2026-09-29', document_id: document.id },
        lawyer(),
        new Date('2026-09-30T03:00:00Z'),
      );

      const offered = await projects.openable(
        manager(),
        new Date('2026-09-30T03:00:00Z'),
      );
      expect(offered.map((row) => row.id)).toContain(contractId);
      const preview = await projects.preview(contractId, manager());
      expect(preview.canOpen).toBe(true);
      expect(preview.missing.join('|')).toContain('ไม่พบ Solution');

      // opens, with the schedule copied and the engineer on the team
      const opened = await projects.open(
        {
          contract_id: contractId,
          manager_user_id: pm,
          members: [{ user_id: engineer, role: 'วิศวกร' }],
        },
        manager(),
      );
      projectId = opened.id;
      expect(opened).toMatchObject({
        projectNo: `PRJ-T175-${tag}`,
        name: 'ติดตั้งระบบกล้อง อาคาร A',
        status: 'active',
        contractValue: 150000,
        managerUserId: pm,
      });
      const baseline = opened.baseline as {
        contract: { signedOn: string };
        installments: {
          seq: number;
          amount: number;
          milestone: string | null;
        }[];
      };
      expect(baseline.contract.signedOn).toBe('2026-09-29');
      expect(baseline.installments).toEqual([
        expect.objectContaining({ seq: 1, amount: 45000 }),
        expect.objectContaining({ seq: 2, milestone: 'ตรวจรับงาน' }),
      ]);
      expect(opened.members.map((member) => member.userId)).toEqual([engineer]);
      // the manager opened it themselves — only the engineer is told
      expect(told).toEqual([{ userId: engineer, role: 'ทีมโครงการ' }]);

      // once only
      await expect(
        projects.open(
          { contract_id: contractId, manager_user_id: pm },
          manager(),
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(
        (await projects.openable(manager())).map((row) => row.id),
      ).not.toContain(contractId);
      expect(await projects.forContract(contractId, lawyer())).toMatchObject({
        project: { id: opened.id },
      });

      // the engineer sees it without pm.project.read; an outsider does not
      const onTeam = as(engineer, ['notification.read']);
      const seen = (await projects.detail(opened.id, onTeam)) as { id: string };
      expect(seen.id).toBe(opened.id);
      expect(
        (await projects.list(onTeam, { page: 1, limit: 20 } as never)).data.map(
          (row) => (row as { id: string }).id,
        ),
      ).toContain(opened.id);
      {
        const stranger = as(outsider, ['notification.read']);
        await expect(
          projects.detail(opened.id, stranger),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(
          projects.saveMembers(opened.id, { members: [] }, stranger),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      }
      // a team member may not rearrange the team
      await expect(
        projects.saveMembers(opened.id, { members: [] }, onTeam),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // the manager keeps the team; the new member is told
      {
        told.length = 0;
        const saved = await projects.saveMembers(
          opened.id,
          {
            members: [
              { user_id: engineer, role: 'วิศวกร' },
              { user_id: outsider },
            ],
          },
          as(pm, ['notification.read']),
        );
        expect(saved.members.map((member) => member.userId).sort()).toEqual(
          [engineer, outsider].sort(),
        );
        expect(told).toEqual([{ userId: outsider, role: 'ทีมโครงการ' }]);
      }

      // handing it to the engineer: they leave the team and become manager
      const handed = await projects.update(
        opened.id,
        { manager_user_id: engineer, status: 'on_hold' },
        manager(),
      );
      expect(handed).toMatchObject({
        managerUserId: engineer,
        status: 'on_hold',
      });
      expect(handed.members.map((member) => member.userId)).not.toContain(
        engineer,
      );
    });

    it('CD-182: milestones from the schedule, measurable, ticked, survive a schedule edit, achieved with evidence', async () => {
      // after CD-175's test the engineer manages the (paused) project
      const managerNow = as(engineer, ['notification.read']);
      const member = as(outsider, ['notification.read']);
      await expect(
        milestones.create(projectId, { title: 'แอบเพิ่ม' }, member),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // the deposit waits on no work; the final payment names "ตรวจรับงาน"
      // CD-154 — the contract's delay penalty: 0.1% of its value a day,
      // at most 10% of it
      await prisma.contractTerms.create({
        data: {
          contractId,
          companyId,
          penaltyRatePct: 0.1,
          penaltyPeriod: 'day',
          penaltyBasis: 'contract_value',
          penaltyCapPct: 10,
        },
      });
      const drawn = await milestones.fromSchedule(projectId, managerNow);
      expect(drawn.milestones[0].penaltyApplies).toBe(true);
      expect(drawn.milestones).toHaveLength(1);
      const first = drawn.milestones[0];
      expect(first).toMatchObject({
        title: 'ตรวจรับงาน',
        status: 'planned',
        installment: { seq: 2, amount: 105000 },
      });
      expect(drawn.installments.find((row) => row.seq === 2)?.milestoneId).toBe(
        first.id,
      );
      await expect(
        milestones.fromSchedule(projectId, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // tied to a payment, it must say how it is measured
      await expect(
        milestones.update(projectId, first.id, { criteria: [] }, managerNow),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await milestones.update(
        projectId,
        first.id,
        {
          criteria: ['ลูกค้าลงนามใบตรวจรับ', 'ส่งคู่มือการใช้งาน'],
          due_on: '2026-09-20',
        },
        managerNow,
      );
      // a second milestone cannot take the same installment
      const installmentId = first.installment!.id;
      await expect(
        milestones.create(
          projectId,
          { title: 'ซ้ำ', criteria: ['ก'], installment_id: installmentId },
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // not all ticked: refused
      await milestones.tick(projectId, first.id, 0, true, managerNow);
      const evidence = {
        achieved_on: '2026-09-30',
        evidence_note: 'ลูกค้าลงนามใบตรวจรับแล้ว',
      };
      await expect(
        milestones.achieve(
          projectId,
          first.id,
          evidence,
          undefined,
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await milestones.tick(projectId, first.id, 1, true, managerNow);

      // Legal rewrites the schedule: the tie follows installment 2
      await schedule.save(
        contractId,
        {
          installments: [
            {
              kind: 'progress',
              label: 'งวดแรก',
              amount: 30000,
              due_on: '2026-12-31',
            },
            {
              kind: 'final',
              label: 'งวดสุดท้าย',
              amount: 120000,
              milestone: 'ตรวจรับงาน',
            },
          ],
        } as never,
        lawyer(),
      );
      const relinked = await milestones.list(projectId, managerNow);
      expect(relinked.milestones[0].installment).toMatchObject({
        seq: 2,
        amount: 120000,
      });
      expect(relinked.milestones[0].installment!.id).not.toBe(installmentId);
      expect(relinked.milestones[0].criteriaMet).toBe(2);

      // achieved, with a file; the contract's owner hears the payment is due
      const done = await milestones.achieve(
        projectId,
        first.id,
        evidence,
        {
          originalname: 'ใบตรวจรับ.pdf',
          mimetype: 'application/pdf',
          size: 4,
          buffer: Buffer.from('%PDF'),
        },
        managerNow,
        new Date('2026-09-30T05:00:00Z'),
      );
      expect(done.milestone).toMatchObject({
        status: 'achieved',
        achievedOn: '2026-09-30',
        evidenceFile: { name: 'ใบตรวจรับ.pdf' },
      });
      expect(billable).toEqual([{ userId: pm, milestone: 'ตรวจรับงาน' }]);
      await expect(
        milestones.achieve(
          projectId,
          first.id,
          evidence,
          undefined,
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const file = await milestones.evidence(projectId, first.id, member);
      expect(file.fileName).toBe('ใบตรวจรับ.pdf');

      // CD-152 — Legal sees each payment against the project's milestones:
      // the first progress payment is tied to nothing, the last one is due
      // CD-154 — achieved ten days after it was due: 10 × 0.1% × 150,000
      const withPenalty = await milestones.list(
        projectId,
        managerNow,
        new Date('2026-10-05T05:00:00Z'),
      );
      expect(withPenalty.milestones[0].penalty).toMatchObject({
        daysLate: 10,
        amount: 1_500,
      });
      expect(withPenalty.penalty).toMatchObject({
        ceiling: 15_000,
        exposure: { total: 1_500, capped: false },
      });
      const legalTerms = await new ContractTermsService(
        new ContractTermsRepository(prisma as never),
        new CustomerContractRepository(prisma as never),
        {} as never,
        {} as never,
        {} as never,
        { record: () => Promise.resolve() } as never,
        {} as never,
      ).view(contractId, lawyer());
      expect(legalTerms.penalty).toMatchObject({
        project: { id: projectId },
        milestones: [{ title: 'ตรวจรับงาน', daysLate: 10, amount: 1_500 }],
        exposure: { total: 1_500 },
      });

      const terms = await schedule.view(contractId, lawyer());
      expect(terms.paymentCheck).toEqual({
        problems: 1,
        pending: 0,
        billable: 1,
      });
      expect(terms.installments.map((row) => row.check.verdict)).toEqual([
        'problem',
        'ok',
      ]);
      expect(terms.installments[1]).toMatchObject({
        projectMilestone: { title: 'ตรวจรับงาน', status: 'achieved' },
        check: { billable: true },
      });
    });

    it('CD-177: the breakdown, links that must not loop or touch a summary, dates from the calendar', async () => {
      const client = prisma as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        {
          milestoneSlipped: (
            userId: string,
            _company: string,
            input: { milestone: string; from: string | null; to: string },
          ) => {
            slips.push({ userId, ...input });
            return Promise.resolve();
          },
        } as never,
        { record: () => Promise.resolve() } as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
      );
      const slips: {
        userId: string;
        milestone: string;
        from: string | null;
        to: string;
      }[] = [];
      const managerNow = as(engineer, ['notification.read']);
      await expect(
        plan.create(
          projectId,
          { title: 'แอบเพิ่ม' },
          as(outsider, ['notification.read']),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // no Solution behind this contract: nothing to draw from
      await expect(
        plan.fromDeliverables(projectId, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      const idOf = (
        view: { tasks: { id: string; title: string }[] },
        title: string,
      ) => view.tasks.find((row) => row.title === title)!.id;
      let view: Awaited<ReturnType<PlanService['view']>> = await plan.create(
        projectId,
        { title: 'สำรวจหน้างาน', duration_days: 3, owner_user_id: engineer },
        managerNow,
      );
      view = await plan.create(
        projectId,
        { title: 'ติดตั้ง', duration_days: 2 },
        managerNow,
      );
      view = await plan.create(
        projectId,
        { title: 'เอกสาร', duration_days: 0 },
        managerNow,
      );
      const survey = idOf(view, 'สำรวจหน้างาน');
      const install = idOf(view, 'ติดตั้ง');
      const docs = idOf(view, 'เอกสาร');
      view = await plan.create(
        projectId,
        { title: 'คู่มือ', duration_days: 1, parent_id: docs },
        managerNow,
      );
      const manual = idOf(view, 'คู่มือ');
      expect(view.tasks.map((row) => [row.wbs, row.title])).toEqual([
        ['1', 'สำรวจหน้างาน'],
        ['2', 'ติดตั้ง'],
        ['3', 'เอกสาร'],
        ['3.1', 'คู่มือ'],
      ]);

      // installing waits for the survey
      view = await plan.setPredecessors(
        projectId,
        install,
        { predecessors: [{ task_id: survey }] },
        managerNow,
      );
      const byTitle = (title: string) =>
        view.tasks.find((row) => row.title === title)!;
      expect(byTitle('ติดตั้ง').start! > byTitle('สำรวจหน้างาน').finish!).toBe(
        true,
      );
      expect(byTitle('สำรวจหน้างาน').critical).toBe(true);
      expect(byTitle('คู่มือ').floatDays).toBeGreaterThan(0);
      expect(byTitle('เอกสาร')).toMatchObject({ summary: true });
      expect(view.finish).toBe(byTitle('ติดตั้ง').finish);
      expect(view.projectStart).toBe('2026-10-01');

      // CD-178 — installing delivers a milestone that unlocks a payment
      const firstPayment = (await schedule.view(contractId, lawyer()))
        .installments[0];
      const handover = await milestones.create(
        projectId,
        {
          title: 'ติดตั้งเสร็จ',
          criteria: ['ระบบเปิดใช้งานได้'],
          installment_id: firstPayment.id,
        },
        managerNow,
      );
      await plan.update(
        projectId,
        install,
        { milestone_id: handover.milestone!.id },
        managerNow,
      );
      const forecastOf = (v: typeof view) =>
        v.milestones.find((row) => row.title === 'ติดตั้งเสร็จ')!.forecast;
      view = await plan.view(projectId, managerNow);
      const before = forecastOf(view);
      expect(before).toBe(byTitle('ติดตั้ง').finish);

      // what a longer survey would move — nothing saved
      const impact = await plan.preview(
        projectId,
        { task_id: survey, duration_days: 6 },
        managerNow,
      );
      expect(impact.moved.map((row) => row.title).sort()).toEqual(
        ['ติดตั้ง', 'สำรวจหน้างาน'].sort(),
      );
      expect(impact.finish.to! > impact.finish.from!).toBe(true);
      expect(impact.milestones).toEqual([
        expect.objectContaining({ title: 'ติดตั้งเสร็จ', from: before }),
      ]);
      expect(forecastOf(await plan.view(projectId, managerNow))).toBe(before);
      expect(slips).toEqual([]);

      // saved: the contract's owner hears the payment milestone slipped
      view = await plan.update(
        projectId,
        survey,
        { duration_days: 6 },
        managerNow,
      );
      expect(forecastOf(view)! > before!).toBe(true);
      expect(slips).toContainEqual(
        expect.objectContaining({
          userId: pm,
          milestone: 'ติดตั้งเสร็จ',
          from: before,
          to: forecastOf(view),
        }),
      );
      expect(slips.some((row) => row.userId === engineer)).toBe(false);

      // a loop, a summary, and splitting a linked task are all refused
      await expect(
        plan.setPredecessors(
          projectId,
          survey,
          { predecessors: [{ task_id: install }] },
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        plan.setPredecessors(
          projectId,
          install,
          { predecessors: [{ task_id: docs }] },
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        plan.create(
          projectId,
          { title: 'ย่อย', parent_id: survey },
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // moved to the top; a task cannot go under its own child
      view = await plan.update(
        projectId,
        manual,
        { parent_id: null, position: 1 },
        managerNow,
      );
      expect(view.tasks.map((row) => [row.wbs, row.title])).toEqual([
        ['1', 'คู่มือ'],
        ['2', 'สำรวจหน้างาน'],
        ['3', 'ติดตั้ง'],
        ['4', 'เอกสาร'],
      ]);
      await plan.update(projectId, manual, { parent_id: docs }, managerNow);
      await expect(
        plan.update(projectId, docs, { parent_id: manual }, managerNow),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // cancelled with what is under it
      view = await plan.cancel(projectId, docs, managerNow);
      expect(view.tasks.map((row) => row.title)).toEqual([
        'สำรวจหน้างาน',
        'ติดตั้ง',
      ]);
    });

    it('CD-181: the owner sees the task among their own, reports with photos, and the manager hears it is done', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const heard: { kind: string; userId: string; task: string }[] = [];
      const notifications = {
        milestoneSlipped: () => Promise.resolve(),
        taskAssigned: (
          userId: string,
          _c: string,
          _p: unknown,
          task: string,
        ) => {
          heard.push({ kind: 'assigned', userId, task });
          return Promise.resolve();
        },
        taskDone: (userId: string, _c: string, _p: unknown, task: string) => {
          heard.push({ kind: 'done', userId, task });
          return Promise.resolve();
        },
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        notifications,
        audit,
        transactions,
      );
      const work = new TaskWorkService(
        projects,
        plan,
        new ProjectTaskRepository(client),
        new ProjectTaskUpdateRepository(client),
        new ProjectTaskFileRepository(client),
        new CompanyMemberRepository(client),
        notifications,
        audit,
        transactions,
        {
          put: (key: string, body: Buffer) => {
            stored.set(key, body);
            return Promise.resolve();
          },
          get: (key: string) =>
            Promise.resolve(Readable.from([stored.get(key)!])),
          remove: (key: string) => {
            stored.delete(key);
            return Promise.resolve();
          },
        },
        { workMayStart: () => Promise.resolve(null) } as never,
        { handoffBlockers: () => Promise.resolve([]) } as never,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const install = (await plan.view(projectId, managerNow)).tasks.find(
        (row) => row.title === 'ติดตั้ง',
      )!;

      // handed to the crew: they hear of it and find it among their own
      await plan.update(
        projectId,
        install.id,
        { owner_user_id: outsider },
        managerNow,
      );
      expect(heard).toEqual([
        { kind: 'assigned', userId: outsider, task: 'ติดตั้ง' },
      ]);
      const mine = await work.mine(crew);
      expect(mine).toEqual([
        expect.objectContaining({
          id: install.id,
          title: 'ติดตั้ง',
          status: 'open',
          finish: install.finish,
          project: expect.objectContaining({
            id: projectId,
          }) as unknown,
        }),
      ]);

      // nothing to report is refused; someone not on it cannot report
      await expect(
        work.report(projectId, install.id, {}, [], crew),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        work.report(
          projectId,
          install.id,
          { note: 'แอบ' },
          [],
          as(pm, ['notification.read']),
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // started, with a photo from site
      const started = await work.report(
        projectId,
        install.id,
        { note: 'เริ่มเดินสายชั้น 1', status: 'in_progress' },
        [
          {
            originalname: 'site.jpg',
            mimetype: 'image/jpeg',
            size: 3,
            buffer: Buffer.from('jpg'),
          },
        ],
        crew,
        new Date('2026-10-06T02:00:00Z'),
      );
      expect(started.task).toMatchObject({ status: 'in_progress' });
      expect(started.task.startedAt).toEqual(new Date('2026-10-06T02:00:00Z'));
      expect(started.files.map((row) => row.fileName)).toEqual(['site.jpg']);
      expect(started.updates[0]).toMatchObject({
        note: 'เริ่มเดินสายชั้น 1',
        statusFrom: 'open',
        statusTo: 'in_progress',
        files: [started.files[0].id],
      });
      const photo = await work.download(
        projectId,
        install.id,
        started.files[0].id,
        managerNow,
      );
      expect(photo.fileName).toBe('site.jpg');

      // done: the manager hears; it leaves the crew's list
      const done = await work.report(
        projectId,
        install.id,
        { note: 'ติดตั้งครบ', status: 'done' },
        [],
        crew,
        new Date('2026-10-08T09:00:00Z'),
      );
      expect(done.task).toMatchObject({ status: 'done' });
      expect(heard).toContainEqual({
        kind: 'done',
        userId: engineer,
        task: 'ติดตั้ง',
      });
      expect(await work.mine(crew)).toEqual([]);
      expect(
        (await plan.view(projectId, managerNow)).tasks.find(
          (row) => row.id === install.id,
        ),
      ).toMatchObject({ status: 'done' });
    });

    it('CD-188: progress from closed work and achieved milestones, against the plan; a far figure needs a reason', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        { milestoneSlipped: () => Promise.resolve() } as never,
        audit,
        transactions,
      );
      const progress = new ProgressService(
        projects,
        plan,
        new ProjectMilestoneRepository(client),
        new ProjectProgressRepository(client),
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const later = new Date('2026-12-01T03:00:00Z');

      // the survey (6 days) is open, the install (2 days) done: 2 of 8;
      // one of the two milestones achieved; by December all was due
      const view = await progress.view(projectId, managerNow, later);
      expect(view.work).toEqual({ pct: 25, done: 1, total: 2 });
      expect(view.milestones).toEqual({ achieved: 1, total: 2, pct: 50 });
      expect(view.planned).toEqual({ pct: 100, variance: -75 });

      // close to the computed figure: no reason needed
      await progress.report(projectId, { reported_pct: 30 }, managerNow, later);
      // far from it: a reason, or it is refused
      await expect(
        progress.report(projectId, { reported_pct: 60 }, managerNow, later),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const saved = await progress.report(
        projectId,
        {
          reported_pct: 60,
          reason: 'สำรวจหน้างานเสร็จแล้ว รอปิดงานในระบบ',
        },
        managerNow,
        new Date(later.getTime() + 60_000),
      );
      expect(
        saved.reports.map((row) => [row.reportedPct, row.computedPct]),
      ).toEqual([
        [60, 25],
        [30, 25],
      ]);
      expect(saved.reports[0]).toMatchObject({
        reason: 'สำรวจหน้างานเสร็จแล้ว รอปิดงานในระบบ',
        plannedPct: 100,
      });

      // a team member reads it but does not record it
      await expect(
        progress.report(
          projectId,
          { reported_pct: 25 },
          as(outsider, ['notification.read']),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(
        (
          await progress.view(
            projectId,
            as(outsider, ['notification.read']),
            later,
          )
        ).reports,
      ).toHaveLength(2);
    });

    it('CD-179: a draft from the baseline, completed, locked — then changed only through a change request', async () => {
      const client = prisma as never;
      const budget = new BudgetService(
        projects,
        new ProjectRepository(client),
        new ProjectBudgetRepository(client),
        new CompanyMemberRepository(client),
        { record: () => Promise.resolve() } as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
        new ProjectIntakeRepository(client),
      );
      const managerNow = as(engineer, ['notification.read']);
      expect((await budget.view(projectId, managerNow)).current).toBeNull();

      // this contract had no Solution: the draft starts empty
      const started = await budget.start(projectId, managerNow);
      expect(started.current).toMatchObject({
        versionNo: 1,
        status: 'draft',
        lines: [],
        contractValue: 150000,
      });
      await expect(budget.start(projectId, managerNow)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      // CD-176 — the work not yet received: the first budget waits
      expect((await budget.view(projectId, managerNow)).awaitingIntake).toBe(
        true,
      );
      await expect(budget.lock(projectId, managerNow)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await prisma.projectIntake.updateMany({
        where: { projectId },
        data: { status: 'accepted' },
      });
      await expect(budget.lock(projectId, managerNow)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(
        budget.saveDraft(
          projectId,
          { lines: [] },
          as(outsider, ['notification.read']),
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // a line without a cost cannot be locked
      const lines = [
        {
          category: 'material',
          code: 'CAM-01',
          description: 'กล้อง',
          quantity: 20,
          unit: 'ตัว',
          unit_cost: 3000,
        },
        {
          category: 'labor',
          description: 'ช่างติดตั้ง',
          quantity: 10,
          unit: 'man-day',
          unit_cost: null,
        },
      ];
      const draft = await budget.saveDraft(projectId, { lines }, managerNow);
      expect(draft.current).toMatchObject({ total: 60000, missingCost: 1 });
      await expect(budget.lock(projectId, managerNow)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });

      lines[1].unit_cost = 2000;
      await budget.saveDraft(projectId, { lines }, managerNow);
      const locked = await budget.lock(projectId, managerNow);
      expect(locked.current).toMatchObject({
        status: 'locked',
        total: 80000,
        byCategory: { material: 60000, labor: 20000, other: 0 },
        margin: 70000,
        marginPct: 46.7,
      });

      // locked: no more editing here
      await expect(
        budget.saveDraft(projectId, { lines }, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('CD-185: a change judged on scope, time and cost; the new margin; work waits for approval; approval writes the next budget', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      let boardSays = 'pending';
      const decided: { userId: string; approved: boolean }[] = [];
      const changes = new ChangeRequestsService(
        projects,
        new ProjectChangeRequestRepository(client),
        new ProjectBudgetRepository(client),
        {
          findFirst: () => Promise.resolve({ projectChangeTypeCode: 'CHG' }),
        } as never,
        {
          findFirst: () => Promise.resolve({ status: boardSays }),
          findMany: () => Promise.resolve([]),
        } as never,
        {
          create: () => Promise.resolve({ id: `req-${tag}` }),
          submit: () => Promise.resolve(),
        } as never,
        new CompanyMemberRepository(client),
        {
          changeDecided: (
            userId: string,
            _c: string,
            _p: unknown,
            change: { approved: boolean },
          ) => {
            decided.push({ userId, approved: change.approved });
            return Promise.resolve();
          },
        } as never,
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        {
          milestoneSlipped: () => Promise.resolve(),
          taskAssigned: () => Promise.resolve(),
        } as never,
        audit,
        transactions,
      );
      const work = new TaskWorkService(
        projects,
        plan,
        new ProjectTaskRepository(client),
        new ProjectTaskUpdateRepository(client),
        new ProjectTaskFileRepository(client),
        new CompanyMemberRepository(client),
        { taskDone: () => Promise.resolve() } as never,
        audit,
        transactions,
        {} as never,
        changes,
        { handoffBlockers: () => Promise.resolve([]) } as never,
      );
      const managerNow = as(engineer, ['notification.read']);

      // five more cameras, two days of training taken off, 20,000 more to pay
      const drafted = await changes.create(
        projectId,
        {
          title: 'เพิ่มกล้องชั้น 2',
          reason: 'ลูกค้าขอเพิ่มจุดติดตั้ง',
          scope_added: 'กล้อง 5 ตัวชั้น 2',
          scope_removed: 'อบรมวันที่ 2-3',
          schedule_days: 3,
          cost_lines: [
            {
              category: 'material',
              description: 'กล้องเพิ่ม',
              quantity: 5,
              unit_cost: 3000,
            },
            {
              category: 'labor',
              description: 'ตัดงานอบรม',
              quantity: -2,
              unit_cost: 2000,
            },
          ],
          price_change: 20000,
        },
        managerNow,
      );
      const cr = drafted.changes.find((row) => row.id === drafted.changeId)!;
      expect(cr).toMatchObject({
        label: 'CR-1',
        status: 'draft',
        costChange: 11000,
        impact: {
          cost: { from: 80000, to: 91000 },
          value: { from: 150000, to: 170000 },
          margin: { fromPct: 46.7, toPct: 46.5 },
        },
      });

      // its work cannot start before the board approves
      const added = await plan.create(
        projectId,
        {
          title: 'ติดตั้งกล้องชั้น 2',
          duration_days: 2,
          change_request_id: cr.id,
          owner_user_id: engineer,
        },
        managerNow,
      );
      await expect(
        work.report(
          projectId,
          added.taskId,
          { status: 'in_progress' },
          [],
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // sent; still waiting
      await changes.submit(projectId, cr.id, managerNow, 'Bearer t');
      expect(
        (await changes.list(projectId, managerNow)).changes[0],
      ).toMatchObject({ status: 'submitted', request: { id: `req-${tag}` } });
      await expect(
        changes.update(projectId, cr.id, { title: 'แก้' }, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // approved: the next budget is written and locked, the old superseded
      boardSays = 'approved';
      const after = await changes.list(projectId, managerNow);
      expect(after.changes[0]).toMatchObject({ status: 'approved' });
      expect(after.budget).toEqual({
        versionNo: 2,
        total: 91000,
        contractValue: 170000,
      });
      const budgets = await prisma.projectBudget.findMany({
        where: { projectId },
        orderBy: { versionNo: 'asc' },
        select: { versionNo: true, status: true, changeRequestId: true },
      });
      expect(budgets).toEqual([
        { versionNo: 1, status: 'superseded', changeRequestId: null },
        { versionNo: 2, status: 'locked', changeRequestId: cr.id },
      ]);
      expect(decided).toEqual([{ userId: engineer, approved: true }]);

      // now the work may start
      const started = await work.report(
        projectId,
        added.taskId,
        { status: 'in_progress' },
        [],
        managerNow,
      );
      expect(started.task.status).toBe('in_progress');

      // a change with no effect is not sent; a draft can be withdrawn
      const empty = await changes.create(
        projectId,
        { title: 'ไม่มีอะไร', reason: 'ทดสอบ' },
        managerNow,
      );
      await expect(
        changes.submit(projectId, empty.changeId, managerNow, 'Bearer t'),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const withdrawn = await changes.cancel(
        projectId,
        empty.changeId,
        managerNow,
      );
      expect(
        withdrawn.changes.find((row) => row.id === empty.changeId)?.status,
      ).toBe('cancelled');
    });

    it('CD-183: risks taken over from Legal once, owned and planned, reviewed on a cycle; high with no plan goes to the executives', async () => {
      const client = prisma as never;
      const risks = new ProjectRisksService(
        projects,
        new ProjectRepository(client),
        new ProjectRiskRepository(client),
        new ProjectRiskReviewRepository(client),
        new VersionRepository(client),
        new SolutionRiskRepository(client),
        new ContractRiskAssessmentRepository(client),
        new CompanyMemberRepository(client),
        { record: () => Promise.resolve() } as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
      );
      const managerNow = as(engineer, ['notification.read']);
      const executive = as(pm, ['pm.project.read', 'notification.read']);
      const today = new Date('2026-10-01T03:00:00Z');

      await expect(
        risks.takeOver(projectId, managerNow, today),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // Legal assessed the contract: one issue put to the executives
      await prisma.contractRiskAssessment.create({
        data: {
          contractId,
          companyId,
          level: 'high',
          assessedBy: pm,
          issues: [
            {
              title: 'ค่าปรับไม่มีเพดาน',
              clause: '12',
              severity: 'high',
              escalate: true,
            },
            {
              title: 'ระยะเวลาแจ้งยกเลิกสั้น',
              severity: 'low',
              escalate: false,
            },
          ],
        },
      });
      const taken = await risks.takeOver(projectId, managerNow, today);
      expect(
        taken.risks.map((row) => [
          row.label,
          row.source,
          row.level,
          row.needsPlan,
        ]),
      ).toEqual([
        ['R-1', 'legal', 'critical', true],
        ['R-2', 'legal', 'low', false],
      ]);
      await expect(
        risks.takeOver(projectId, managerNow, today),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // before the executives: the critical one with no plan
      expect(
        (await risks.attention(executive, today))
          .filter((row) => row.project.id === projectId)
          .map((row) => row.label),
      ).toEqual(['R-1']);

      // given an owner and a plan: off the list
      const [critical, low] = taken.risks;
      await risks.update(
        projectId,
        critical.id,
        {
          owner_user_id: outsider,
          response: 'เจรจาเพดานค่าปรับ 10% ของมูลค่างวด',
          review_every_days: 7,
        },
        managerNow,
        today,
      );
      expect(
        (await risks.attention(executive, today)).some(
          (row) => row.id === critical.id,
        ),
      ).toBe(false);

      // its owner reviews it, though not the manager; another member cannot
      const crew = as(outsider, ['notification.read']);
      const reviewed = await risks.review(
        projectId,
        critical.id,
        { note: 'ลูกค้ายอมรับเพดาน', impact: 3 },
        crew,
        new Date('2026-10-05T03:00:00Z'),
      );
      expect(
        reviewed.risks.find((row) => row.id === critical.id),
      ).toMatchObject({
        level: 'high',
        nextReviewOn: '2026-10-12',
        reviews: [expect.objectContaining({ note: 'ลูกค้ายอมรับเพดาน' })],
      });
      await expect(
        risks.review(projectId, low.id, { note: 'x' }, crew),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // a review past its day comes back to the executives
      expect(
        (await risks.attention(executive, new Date('2026-10-20T03:00:00Z')))
          .filter((row) => row.project.id === projectId)
          .map((row) => [row.label, row.reviewOverdue]),
      ).toEqual([
        ['R-1', true],
        ['R-2', true],
      ]);
    });

    it('CD-184: an issue with an owner and a deadline, late when past it; it becomes a change request; the owner resolves it', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const told: string[] = [];
      const changes = new ChangeRequestsService(
        projects,
        new ProjectChangeRequestRepository(client),
        new ProjectBudgetRepository(client),
        { findFirst: () => Promise.resolve(null) } as never,
        {
          findFirst: () => Promise.resolve(null),
          findMany: () => Promise.resolve([]),
        } as never,
        {} as never,
        new CompanyMemberRepository(client),
        {} as never,
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const issues = new ProjectIssuesService(
        projects,
        new ProjectIssueRepository(client),
        new ProjectTaskRepository(client),
        changes,
        new CompanyMemberRepository(client),
        {
          issueAssigned: (userId: string) => {
            told.push(userId);
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const survey = await prisma.projectTask.findFirstOrThrow({
        where: { projectId, title: 'สำรวจหน้างาน' },
        select: { id: true },
      });

      await expect(
        issues.create(
          projectId,
          { title: 'ไม่มีเจ้าของ', due_on: '2026-10-05' },
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await issues.create(
        projectId,
        {
          title: 'สายสัญญาณไม่ผ่านมาตรฐาน',
          severity: 'high',
          schedule_impact_days: 2,
          cost_impact: 5000,
          owner_user_id: outsider,
          due_on: '2026-10-05',
          task_id: survey.id,
        },
        managerNow,
      );
      expect(told).toEqual([outsider]);
      const late = await issues.list(
        projectId,
        crew,
        new Date('2026-10-10T03:00:00Z'),
      );
      expect(late.summary).toEqual({
        open: 1,
        overdue: 1,
        scheduleDays: 2,
        cost: 5000,
      });
      const issue = late.issues[0];
      expect(issue).toMatchObject({
        label: 'I-1',
        overdue: true,
        task: { id: survey.id, title: 'สำรวจหน้างาน' },
      });

      // it changes what was sold: a change request draft carries its cost
      const turned = await issues.toChange(projectId, issue.id, managerNow);
      const cr = await prisma.projectChangeRequest.findUniqueOrThrow({
        where: { id: turned.changeId },
      });
      expect(cr).toMatchObject({
        title: 'I-1: สายสัญญาณไม่ผ่านมาตรฐาน',
        scheduleDays: 2,
        status: 'draft',
      });
      expect(Number(cr.costChange)).toBe(5000);
      expect(turned.issues[0].changeRequest?.label).toBe(`CR-${cr.seq}`);
      await expect(
        issues.toChange(projectId, issue.id, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // its owner resolves it, with how
      await expect(
        issues.resolve(projectId, issue.id, { resolution: ' ' }, crew),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const resolved = await issues.resolve(
        projectId,
        issue.id,
        { resolution: 'เปลี่ยนสาย CAT6A ทั้งชั้น' },
        crew,
      );
      expect(resolved.issues[0]).toMatchObject({
        status: 'resolved',
        overdue: false,
      });
      await expect(
        issues.update(projectId, issue.id, { title: 'แก้' }, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('CD-186: the team logs contacts with the customer; a decision on the scope is flagged until it becomes a change request', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const changes = new ChangeRequestsService(
        projects,
        new ProjectChangeRequestRepository(client),
        new ProjectBudgetRepository(client),
        { findFirst: () => Promise.resolve(null) } as never,
        {
          findFirst: () => Promise.resolve(null),
          findMany: () => Promise.resolve([]),
        } as never,
        {} as never,
        new CompanyMemberRepository(client),
        {} as never,
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const logs = new CustomerLogsService(
        projects,
        new ProjectCustomerLogRepository(client),
        changes,
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const today = new Date('2026-10-01T05:00:00Z');

      // a team member logs it
      await logs.create(
        projectId,
        {
          kind: 'call',
          occurred_on: '2026-09-30',
          summary: 'นัดเข้าพื้นที่สัปดาห์หน้า',
        },
        crew,
        today,
      );
      await expect(
        logs.create(
          projectId,
          { kind: 'meeting', occurred_on: '2026-10-02', summary: 'อนาคต' },
          crew,
          today,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        logs.create(
          projectId,
          {
            kind: 'meeting',
            occurred_on: '2026-10-01',
            summary: 'ประชุม',
            affects_scope: true,
          },
          crew,
          today,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const logged = await logs.create(
        projectId,
        {
          kind: 'site_visit',
          occurred_on: '2026-10-01',
          contact_name: 'คุณสมชาย (ฝ่ายอาคาร)',
          summary: 'เดินหน้างานลานจอดรถ',
          decision: 'ขอเพิ่มกล้องที่ลานจอดรถ 3 ตัว',
          affects_scope: true,
        },
        crew,
        today,
      );
      expect(logged.owesChange).toBe(1);
      const decision = logged.logs.find((row) => row.affectsScope)!;
      expect(decision).toMatchObject({ label: 'C-2', owesChange: true });

      // only the manager turns it into a change request
      await expect(
        logs.toChange(projectId, decision.id, crew),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const turned = await logs.toChange(projectId, decision.id, managerNow);
      expect(turned.owesChange).toBe(0);
      const cr = await prisma.projectChangeRequest.findUniqueOrThrow({
        where: { id: turned.changeId },
      });
      expect(cr).toMatchObject({
        title: 'C-2: ขอเพิ่มกล้องที่ลานจอดรถ 3 ตัว',
        scopeAdded: 'ขอเพิ่มกล้องที่ลานจอดรถ 3 ตัว',
        status: 'draft',
      });
      expect(await logs.owed(projectId)).toBe(0);
      await expect(
        logs.update(projectId, decision.id, { summary: 'แก้' }, crew, today),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it('CD-193: each installment shows where it stands; billing is recorded by hand and checked', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        { milestoneSlipped: () => Promise.resolve() } as never,
        audit,
        transactions,
      );
      const payments = new PaymentsService(
        projects,
        plan,
        new ProjectRepository(client),
        new ContractInstallmentRepository(client),
        new InstallmentBillingRepository(client),
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const today = new Date('2026-10-01T05:00:00Z');

      const before = await payments.view(projectId, crew, today);
      expect(before.canEdit).toBe(false);
      expect(before.installments.length).toBeGreaterThan(0);
      expect(before.totals.received).toBe(0);
      const first = before.installments[0];
      expect(first.state).not.toBe('paid');

      await expect(
        payments.record(
          projectId,
          first.seq,
          { invoiced_on: '2026-09-15', invoiced_amount: first.amount },
          crew,
          today,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        payments.record(
          projectId,
          first.seq,
          { paid_on: '2026-09-20', paid_amount: first.amount },
          managerNow,
          today,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        payments.record(projectId, 999, { note: 'x' }, managerNow, today),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const billed = await payments.record(
        projectId,
        first.seq,
        {
          invoice_no: 'INV-T193',
          invoiced_on: '2026-09-15',
          invoiced_amount: first.amount,
        },
        managerNow,
        today,
      );
      expect(billed.installments[0]).toMatchObject({
        state: 'invoiced',
        billing: { invoiceNo: 'INV-T193', source: 'manual' },
      });
      // the same row again, now paid — one row per installment
      const paid = await payments.record(
        projectId,
        first.seq,
        {
          invoice_no: 'INV-T193',
          invoiced_on: '2026-09-15',
          invoiced_amount: first.amount,
          paid_on: '2026-09-30',
          paid_amount: first.amount,
        },
        managerNow,
        today,
      );
      expect(paid.installments[0].state).toBe('paid');
      expect(paid.totals.received).toBe(first.amount);
      expect(
        await prisma.contractInstallmentBilling.count({
          where: { contractId },
        }),
      ).toBe(1);
      expect(
        paid.forecast.months.find((row) => row.month === '2026-09')?.received,
      ).toBe(first.amount);
    });
    it('CD-221: the test plan follows the sold scope; the team records results with evidence; a failure opens an issue', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const told: string[] = [];
      const tests = new TestsService(
        projects,
        new ProjectRepository(client),
        new ProjectChangeRequestRepository(client),
        new ProjectTestItemRepository(client),
        new ProjectTestRunRepository(client),
        new CompanyMemberRepository(client),
        {
          issueAssigned: (
            userId: string,
            _c: string,
            _p: unknown,
            no: string,
          ) => {
            told.push(`${userId}:${no}`);
            return Promise.resolve();
          },
        } as never,
        {
          put: (key: string, body: Buffer) => {
            files.set(key, body);
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
          get: (key: string) =>
            Promise.resolve(Readable.from([files.get(key)!])),
        },
        audit,
        transactions,
        {
          options: () => Promise.resolve([]),
          sync: () => Promise.resolve(),
          syncSow: () => Promise.resolve(),
          assertTask: () => Promise.resolve(),
        } as never,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const photo = {
        originalname: 'ok.png',
        mimetype: 'image/png',
        size: 4,
        buffer: Buffer.from('png!'),
      };
      const today = new Date('2026-10-08T03:00:00Z');

      // the plan is what was sold, made once
      const first = await tests.view(projectId, crew);
      expect(first.canEdit).toBe(false);
      expect(first.canWrite).toBe(true);
      expect(first.items.length).toBeGreaterThan(0);
      expect(first.items.every((item) => item.state === 'untested')).toBe(true);
      const again = await tests.view(projectId, crew);
      expect(again.items).toHaveLength(first.items.length);
      const one = first.items[0];

      // the manager plans: adds, assigns; the team may not
      await expect(
        tests.add(projectId, { text: 'ทดสอบไฟดับ' }, crew),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const added = await tests.add(
        projectId,
        { text: 'ทดสอบไฟดับ', steps: 'ตัดไฟ 5 นาที', owner_user_id: outsider },
        managerNow,
      );
      const two = added.items.find((item) => item.source === 'manual')!;
      expect(two).toMatchObject({
        ownerUserId: outsider,
        steps: 'ตัดไฟ 5 นาที',
      });

      // a pass carries evidence; a fail says why and opens an issue
      await expect(
        tests.record(
          projectId,
          one.id,
          { result: 'pass' },
          undefined,
          crew,
          today,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const passed = await tests.record(
        projectId,
        one.id,
        { result: 'pass', note: 'ทดสอบครบทุกจุด' },
        photo,
        crew,
        today,
      );
      expect(passed.items.find((item) => item.id === one.id)?.state).toBe(
        'passed',
      );
      const failed = await tests.record(
        projectId,
        two.id,
        { result: 'fail', note: 'ไฟสำรองไม่ทำงาน' },
        undefined,
        crew,
        today,
      );
      const failedItem = failed.items.find((item) => item.id === two.id)!;
      expect(failedItem.state).toBe('failed');
      const issueId = failedItem.runs[0].issue!.id;
      const issue = await prisma.projectIssue.findUniqueOrThrow({
        where: { id: issueId },
      });
      expect(issue).toMatchObject({
        ownerUserId: engineer,
        status: 'open',
        title: `ไม่ผ่านทดสอบ ${two.label}: ทดสอบไฟดับ`,
      });
      expect(issue.dueOn.toISOString().slice(0, 10)).toBe('2026-10-15');
      expect(told).toEqual([`${engineer}:${failedItem.runs[0].issue!.label}`]);
      const evidence = await tests.evidence(
        projectId,
        one.id,
        passed.items.find((item) => item.id === one.id)!.runs[0].id,
        crew,
      );
      expect(evidence.fileName).toBe('ok.png');

      // what was sold keeps its words; an item that no longer applies is waived
      await expect(
        tests.update(projectId, one.id, { text: 'อื่น' }, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const waived = await tests.update(
        projectId,
        two.id,
        { waived_reason: 'ลูกค้าตัดออก' },
        managerNow,
      );
      expect(waived.items.find((item) => item.id === two.id)?.state).toBe(
        'waived',
      );
      await expect(
        tests.record(projectId, two.id, { result: 'pass' }, photo, crew, today),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // coverage: complete once every item that applies passed
      const before = await tests.coverage(projectId);
      const stillOpen = waived.items.filter(
        (row) => row.state === 'untested' || row.state === 'failed',
      );
      expect(before.open.map((row) => row.label)).toEqual(
        stillOpen.map((row) => row.label),
      );
      expect(before.complete).toBe(stillOpen.length === 0);
      for (const item of waived.items.filter(
        (row) => row.state === 'untested' || row.state === 'failed',
      )) {
        await tests.record(
          projectId,
          item.id,
          { result: 'pass' },
          photo,
          crew,
          today,
        );
      }
      const done = await tests.coverage(projectId);
      expect(done).toMatchObject({ complete: true, waived: 1, open: [] });
      // the failed issue is the manager's to resolve; tidy it for later steps
      await prisma.projectIssue.update({
        where: { id: issueId },
        data: { status: 'resolved', resolution: 'ทดสอบ' },
      });
    });

    it('CD-216: installation point by point — serials, photos, and installed units against the BOQ', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const storage = {
        put: (key: string, body: Buffer) => {
          files.set(key, body);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
        get: (key: string) => Promise.resolve(Readable.from([files.get(key)!])),
      };
      const installs = new InstallationsService(
        projects,
        new ProjectRepository(client),
        new ProjectInstallationRepository(client),
        new CompanyMemberRepository(client),
        storage,
        audit,
        transactions,
        {
          options: () => Promise.resolve([]),
          sync: () => Promise.resolve(),
          syncSow: () => Promise.resolve(),
          assertTask: () => Promise.resolve(),
        } as never,
      );
      const asBuilt = new AsBuiltService(
        projects,
        new ProjectRepository(client),
        new ProjectAsBuiltDocumentRepository(client),
        new ProjectAsBuiltDeviationRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectDesignRepository(client),
        new ProjectChangeRequestRepository(client),
        {
          findFirst: () => Promise.resolve({ projectAsBuiltDocuments: [] }),
        } as never,
        new CompanyMemberRepository(client),
        storage,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');
      const photo = (name: string) => [
        {
          originalname: name,
          mimetype: 'image/jpeg',
          size: 3,
          buffer: Buffer.from('jpg'),
        },
      ];
      // the baseline sold two cameras (and cable, which is not counted)
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { baseline: true },
      });
      await prisma.project.update({
        where: { id: projectId },
        data: {
          baseline: {
            ...(project.baseline as Record<string, unknown>),
            boq: [
              {
                kind: 'equipment',
                name: 'กล้อง IP',
                productCode: 'CAM-1',
                quantity: 2,
                unit: 'ตัว',
              },
              {
                kind: 'material',
                name: 'สาย LAN',
                productCode: 'LAN',
                quantity: 100,
                unit: 'ม.',
              },
            ],
          },
        },
      });

      const first = await installs.view(projectId, crew);
      expect(first.boq).toEqual([
        expect.objectContaining({
          ref: 'boq:0',
          quantity: 2,
          installed: 0,
          matches: false,
        }),
      ]);
      expect(first.choices).toHaveLength(2);
      expect(
        (await asBuilt.state(projectId, companyId)).openDeviations,
      ).toEqual([
        'BOQ 1: กล้อง IP: ติดตั้ง 0 จาก 2 — ต้องบันทึกจุดที่ต่างอ้างบรรทัดนี้',
      ]);

      // planned first; installed needs the after photo and the serial
      const planned = await installs.add(
        projectId,
        { location: 'อาคาร A ชั้น 2', boq_index: '0' },
        { before: photo('before.jpg') },
        crew,
        now,
      );
      const p1 = planned.points[0];
      expect(p1).toMatchObject({
        label: 'P-1',
        installedOn: null,
        beforeName: 'before.jpg',
      });
      await expect(
        installs.update(
          projectId,
          p1.id,
          { installed_on: '2026-10-08', serial_no: 'SN-1' },
          {},
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        installs.update(
          projectId,
          p1.id,
          { installed_on: '2026-10-08' },
          { after: photo('after.jpg') },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await installs.update(
        projectId,
        p1.id,
        { installed_on: '2026-10-08', serial_no: 'SN-1' },
        { after: photo('after.jpg') },
        crew,
        now,
      );

      // a serial once per project; a removed point frees it
      await expect(
        installs.add(
          projectId,
          { location: 'ชั้น 3', boq_index: '0', serial_no: 'SN-1' },
          {},
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const second = await installs.add(
        projectId,
        {
          location: 'ชั้น 3',
          boq_index: '0',
          serial_no: 'SN-2',
          installed_on: '2026-10-08',
        },
        { after: photo('after2.jpg') },
        crew,
        now,
      );
      expect(second.boq[0]).toMatchObject({ installed: 2, matches: true });
      expect(
        (await asBuilt.state(projectId, companyId)).openDeviations,
      ).toEqual([]);
      const p2 = second.points.find((row) => row.label === 'P-2')!;
      await installs.remove(projectId, p2.id, crew);
      expect(
        (await asBuilt.state(projectId, companyId)).openDeviations,
      ).toHaveLength(1);
      const again = await installs.add(
        projectId,
        {
          location: 'ชั้น 3',
          boq_index: '0',
          serial_no: 'SN-2',
          installed_on: '2026-10-08',
        },
        { after: photo('after3.jpg') },
        managerNow,
        now,
      );
      expect(again.boq[0]).toMatchObject({ installed: 2, matches: true });
      expect(
        (await installs.photo(projectId, p1.id, 'after', crew)).fileName,
      ).toBe('after.jpg');
    });

    it('CD-218: a plan task closes itself when its installation points are installed and its tests pass — and reopens when they stop holding', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const storage = {
        put: (key: string, body: Buffer) => {
          files.set(key, body);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
        get: (key: string) => Promise.resolve(Readable.from([files.get(key)!])),
      };
      const evidence = new TaskEvidenceService(
        new ProjectTaskRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectTestItemRepository(client),
        { workMayStart: () => Promise.resolve(null) } as never,
        audit,
        transactions,
        { handoffBlockers: () => Promise.resolve([]) } as never,
        new ProjectDefectRepository(client),
      );
      const installs = new InstallationsService(
        projects,
        new ProjectRepository(client),
        new ProjectInstallationRepository(client),
        new CompanyMemberRepository(client),
        storage,
        audit,
        transactions,
        evidence,
      );
      const tests = new TestsService(
        projects,
        new ProjectRepository(client),
        new ProjectChangeRequestRepository(client),
        new ProjectTestItemRepository(client),
        new ProjectTestRunRepository(client),
        new CompanyMemberRepository(client),
        { issueAssigned: () => Promise.resolve() } as never,
        storage,
        audit,
        transactions,
        evidence,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');
      const photo = [
        {
          originalname: 'a.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('a'),
        },
      ];
      const pdf = {
        originalname: 'r.pdf',
        mimetype: 'application/pdf',
        size: 1,
        buffer: Buffer.from('r'),
      };
      // a leaf task, and a summary one (with a child) evidence may not point at
      const task = await prisma.projectTask.create({
        data: {
          companyId,
          projectId,
          seq: 901,
          title: 'ติดตั้งกล้องชั้น 4',
          durationDays: 2,
          createdBy: engineer,
        },
        select: { id: true },
      });
      const summary = await prisma.projectTask.create({
        data: {
          companyId,
          projectId,
          seq: 902,
          title: 'งานกลุ่ม',
          createdBy: engineer,
        },
        select: { id: true },
      });
      await prisma.projectTask.create({
        data: {
          companyId,
          projectId,
          parentId: summary.id,
          seq: 1,
          title: 'งานย่อย',
          createdBy: engineer,
        },
      });
      const status = async () =>
        (await prisma.projectTask.findUniqueOrThrow({ where: { id: task.id } }))
          .status;

      expect(
        (await evidence.options(projectId)).map((row) => row.id),
      ).toContain(task.id);
      await expect(
        installs.add(
          projectId,
          { location: 'ชั้น 4', task_id: summary.id },
          {},
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // a point planned and a test item, both linked: the task stays open
      const planned = await installs.add(
        projectId,
        { location: 'ชั้น 4 โถงลิฟต์', task_id: task.id },
        {},
        crew,
        now,
      );
      const point = planned.points.find((row) => row.taskId === task.id)!;
      const added = await tests.add(
        projectId,
        { text: 'ภาพชั้น 4 ชัด', task_id: task.id },
        managerNow,
      );
      const item = added.items.find((row) => row.taskId === task.id)!;
      expect(await status()).toBe('open');

      // installed — still the test to pass
      await installs.update(
        projectId,
        point.id,
        { installed_on: '2026-10-08' },
        { after: photo },
        crew,
        now,
      );
      expect(await status()).toBe('open');

      // passed: the task is done, by the evidence, with a note in its history
      await tests.record(
        projectId,
        item.id,
        { result: 'pass' },
        pdf,
        crew,
        now,
      );
      expect(await status()).toBe('done');
      const closing = await prisma.projectTaskUpdate.findFirstOrThrow({
        where: { taskId: task.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(closing).toMatchObject({ statusFrom: 'open', statusTo: 'done' });
      expect(closing.note).toContain('ปิดอัตโนมัติ');

      // a later failure reopens it; passing again closes it
      await tests.record(
        projectId,
        item.id,
        { result: 'fail', note: 'ภาพมัว' },
        undefined,
        crew,
        new Date('2026-10-08T04:00:00Z'),
      );
      expect(await status()).toBe('in_progress');
      await tests.record(
        projectId,
        item.id,
        { result: 'pass' },
        pdf,
        crew,
        new Date('2026-10-08T05:00:00Z'),
      );
      expect(await status()).toBe('done');
      // tidy the issue the failure opened, for the steps after
      await prisma.projectIssue.updateMany({
        where: { projectId, status: 'open' },
        data: { status: 'resolved', resolution: 'ทดสอบ' },
      });
    });

    it('CD-211: the detailed design, version by version — approved through the request type, the newest approved in force, every change a new version', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const storage = {
        put: (key: string, body: Buffer) => {
          files.set(key, body);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
        get: (key: string) => Promise.resolve(Readable.from([files.get(key)!])),
      };
      let requestStatus = 'pending_approval';
      let requestSeq = 0;
      const asked: unknown[] = [];
      const told: string[] = [];
      const designs = new DesignsService(
        projects,
        new ProjectRepository(client),
        new ProjectDesignRepository(client),
        new ProjectDesignFileRepository(client),
        {
          findFirst: () => Promise.resolve({ projectDesignTypeCode: 'DSN' }),
        } as never,
        {
          findFirst: () =>
            Promise.resolve({ status: requestStatus, requestNo: 'DSN-1' }),
          findMany: () => Promise.resolve([]),
        } as never,
        {
          create: (input: unknown) => {
            asked.push(input);
            requestSeq++;
            return Promise.resolve({ id: `req-dsn-${tag}-${requestSeq}` });
          },
          submit: () => Promise.resolve(),
        } as never,
        new CompanyMemberRepository(client),
        {
          designDecided: (
            _u: string,
            _c: string,
            _p: unknown,
            v: string,
            ok: boolean,
          ) => {
            told.push(`${v}:${ok}`);
            return Promise.resolve();
          },
        } as never,
        { on: () => undefined } as never,
        storage,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const drawing = {
        originalname: 'layout.pdf',
        mimetype: 'application/pdf',
        size: 4,
        buffer: Buffer.from('%PDF'),
      };

      // the team drafts v1
      const drafted = await designs.create(projectId, crew);
      const v1 = drafted.versions[0];
      expect(v1).toMatchObject({ label: 'v1', status: 'draft' });
      await expect(designs.create(projectId, crew)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(
        designs.update(
          projectId,
          v1.id,
          {
            configuration: [
              { key: 'VLAN', value: '20' },
              { key: 'VLAN', value: '30' },
            ],
          },
          crew,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await designs.update(
        projectId,
        v1.id,
        {
          title: 'แบบติดตั้งกล้อง',
          configuration: [
            { key: 'VLAN', value: '20' },
            { key: 'NVR IP', value: '10.0.0.5' },
          ],
          differs_from_solution: true,
        },
        crew,
      );

      // only the manager sends; it needs a drawing and the difference said
      await expect(
        designs.submit(projectId, v1.id, crew, 'Bearer x'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        designs.submit(projectId, v1.id, managerNow, 'Bearer x'),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await designs.attach(projectId, v1.id, drawing, crew);
      await designs.update(
        projectId,
        v1.id,
        { differences: 'ย้าย NVR ไปห้อง Server ชั้น 1' },
        crew,
      );
      const sent = await designs.submit(
        projectId,
        v1.id,
        managerNow,
        'Bearer x',
      );
      expect(sent.versions[0].status).toBe('submitted');
      expect(sent.versions[0].request?.id).toBe(`req-dsn-${tag}-1`);
      expect(asked[0]).toMatchObject({
        type_code: 'DSN',
        form_data: { design_no: 'v1', differs_from_solution: 1 },
      });
      await expect(
        designs.update(projectId, v1.id, { title: 'อื่น' }, crew),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // approved: v1 is in force
      requestStatus = 'approved';
      const approved = await designs.view(projectId, crew);
      expect(approved.inForce).toMatchObject({ label: 'v1' });
      expect(told).toEqual(['v1:true']);

      // a change is v2, copied from v1 with its drawing; approved, it replaces v1
      requestStatus = 'pending_approval';
      const v2Draft = await designs.create(projectId, crew);
      const v2 = v2Draft.versions[0];
      expect(v2).toMatchObject({
        label: 'v2',
        title: 'แบบติดตั้งกล้อง',
        status: 'draft',
      });
      expect(v2.files).toHaveLength(1);
      expect(v2.configuration).toEqual([
        { key: 'VLAN', value: '20' },
        { key: 'NVR IP', value: '10.0.0.5' },
      ]);
      await designs.submit(projectId, v2.id, managerNow, 'Bearer x');
      requestStatus = 'approved';
      const after = await designs.view(projectId, crew);
      expect(after.inForce).toMatchObject({ label: 'v2' });
      expect(after.versions.map((row) => [row.label, row.status])).toEqual([
        ['v2', 'approved'],
        ['v1', 'superseded'],
      ]);
      expect((await designs.inForce(projectId))?.versionNo).toBe(2);
      expect(
        (await designs.download(projectId, v2.files[0].id, crew)).fileName,
      ).toBe('layout.pdf');
    });

    it('CD-209: the technical plan — crew and equipment per task, equipment week by week, and handoff 7 holding the work until the plan is complete', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        { milestoneSlipped: () => Promise.resolve() } as never,
        audit,
        transactions,
      );
      const techPlan = new TechPlanService(
        projects,
        plan,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskEquipmentRepository(client),
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const work = new TaskWorkService(
        projects,
        plan,
        new ProjectTaskRepository(client),
        new ProjectTaskUpdateRepository(client),
        new ProjectTaskFileRepository(client),
        new CompanyMemberRepository(client),
        { taskDone: () => Promise.resolve() } as never,
        audit,
        transactions,
        {} as never,
        { workMayStart: () => Promise.resolve(null) } as never,
        techPlan,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      // a piece of work with no owner yet
      const task = await prisma.projectTask.create({
        data: {
          companyId,
          projectId,
          seq: 950,
          title: 'ติดตั้งกล้องชั้น 5',
          durationDays: 3,
          createdBy: engineer,
        },
        select: { id: true },
      });

      const first = await techPlan.view(projectId, crew);
      expect(first.canEdit).toBe(false);
      expect(first.handoff.ready).toBe(false);
      expect(first.handoff.blockers[0]).toContain('ติดตั้งกล้องชั้น 5');
      // handoff 7 holds the work: it cannot start
      await expect(
        work.report(
          projectId,
          task.id,
          { status: 'in_progress', note: 'เริ่ม' },
          [],
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // every task gets an owner; this one needs equipment, so it must list it
      await prisma.projectTask.updateMany({
        where: { projectId, ownerUserId: null },
        data: { ownerUserId: engineer },
      });
      await expect(
        techPlan.saveTask(projectId, task.id, { needs_equipment: true }, crew),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const needs = await techPlan.saveTask(
        projectId,
        task.id,
        { needs_equipment: true, crew_user_ids: [outsider] },
        managerNow,
      );
      expect(needs.handoff.ready).toBe(false);
      expect(needs.handoff.blockers).toEqual([
        expect.stringContaining('งานที่ต้องใช้อุปกรณ์แต่ยังไม่ระบุ'),
      ]);
      await expect(
        techPlan.saveTask(
          projectId,
          task.id,
          { equipment: [{ boq_index: 99, quantity: 1 }] },
          managerNow,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const listed = await techPlan.saveTask(
        projectId,
        task.id,
        {
          equipment: [
            { boq_index: 0, quantity: 4 },
            { name: 'บันไดอลูมิเนียม', quantity: 1, unit: 'อัน' },
          ],
        },
        managerNow,
      );
      expect(listed.handoff).toEqual({ ready: true, blockers: [] });
      const row = listed.tasks.find((item) => item.id === task.id)!;
      expect(row.crew.map((member) => member.id)).toEqual([outsider]);
      expect(row.equipment.map((line) => [line.name, line.quantity])).toEqual([
        ['กล้อง IP', 4],
        ['บันไดอลูมิเนียม', 1],
      ]);
      expect(listed.weekly.length).toBeGreaterThan(0);

      // handed over: the work may start
      const started = await work.report(
        projectId,
        task.id,
        { status: 'in_progress', note: 'เริ่มติดตั้ง' },
        [],
        managerNow,
      );
      expect(started.task).toMatchObject({ status: 'in_progress' });
    });

    it('CD-212: the software plan — rounds of development as summary tasks, each SOW line a task under one, never twice', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const quiet = new Proxy(
        {},
        { get: () => () => Promise.resolve() },
      ) as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        quiet,
        quiet,
        transactions,
      );
      const dev = new DevPlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectChangeRequestRepository(client),
        plan,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      // the SOW: two scope lines and one deliverable
      const before = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { baseline: true },
      });
      const baseline = before.baseline as Record<string, unknown>;
      await prisma.project.update({
        where: { id: projectId },
        data: {
          baseline: {
            ...baseline,
            scope: {
              ...(baseline.scope as Record<string, unknown>),
              inScope: ['ระบบลงทะเบียน', 'รายงานยอดขาย'],
              deliverables: [{ title: 'คู่มือผู้ใช้', criteria: [] }],
            },
          } as never,
        },
      });
      try {
        let view = await dev.view(projectId, crew);
        expect(view.canEdit).toBe(false);
        expect(view.unplanned.map((row) => row.ref)).toEqual(
          expect.arrayContaining([
            'scope:0',
            'scope:1',
            'deliverable:0',
          ]) as never,
        );
        const total = view.total;

        // only the manager plans
        await expect(
          dev.addIteration(projectId, { title: 'Sprint 1' }, crew),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        view = await dev.addIteration(
          projectId,
          { title: 'Sprint 1', owner_user_id: engineer },
          managerNow,
        );
        expect(view.iterations).toHaveLength(1);
        const sprint = view.iterations[0];
        expect(sprint).toMatchObject({ title: 'Sprint 1', items: [] });

        await expect(
          dev.addItems(projectId, sprint.id, { refs: ['scope:0'] }, crew),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        view = await dev.addItems(
          projectId,
          sprint.id,
          {
            refs: ['scope:0', 'deliverable:0'],
            owner_user_id: engineer,
            duration_days: 3,
          },
          managerNow,
        );
        expect(view.planned).toBe(2);
        expect(view.total).toBe(total);
        expect(view.iterations[0].items).toEqual([
          expect.objectContaining({
            title: 'ระบบลงทะเบียน',
            sowRef: 'scope:0',
            durationDays: 3,
            status: 'open',
          }),
          expect.objectContaining({
            title: 'ส่งมอบ คู่มือผู้ใช้',
            sowRef: 'deliverable:0',
          }),
        ] as never);
        // the items sit under the round in the plan; the round is a summary
        const planned = await plan.view(projectId, managerNow);
        const round = planned.tasks.find((task) => task.id === sprint.id)!;
        expect(round.summary).toBe(true);
        expect(
          planned.tasks.filter((task) => task.parentId === sprint.id),
        ).toHaveLength(2);
        // a line is planned once; unknown lines are refused
        await expect(
          dev.addItems(projectId, sprint.id, { refs: ['scope:0'] }, managerNow),
        ).rejects.toThrow('ข้อ SOW นี้อยู่ในรอบงานแล้ว: scope:0');
        await expect(
          dev.addItems(
            projectId,
            sprint.id,
            { refs: ['scope:99'] },
            managerNow,
          ),
        ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
        await expect(
          dev.addItems(projectId, 'nope', { refs: ['scope:1'] }, managerNow),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        // a cancelled item frees its line
        const item = view.iterations[0].items[0];
        await plan.cancel(projectId, item.id, managerNow);
        view = await dev.view(projectId, managerNow);
        expect(view.unplanned.map((row) => row.ref)).toContain('scope:0');
        expect(view.iterations[0].items).toHaveLength(1);
      } finally {
        await prisma.project.update({
          where: { id: projectId },
          data: { baseline: before.baseline as never },
        });
      }
    });

    it('CD-213: software work proved by its SOW line — tests pass and no defect open closes it; a defect reopens it until a retest passes', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const quiet = new Proxy(
        {},
        { get: () => () => Promise.resolve() },
      ) as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        quiet,
        quiet,
        transactions,
      );
      const dev = new DevPlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectChangeRequestRepository(client),
        plan,
      );
      const evidence = new TaskEvidenceService(
        new ProjectTaskRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectTestItemRepository(client),
        { workMayStart: () => Promise.resolve(null) } as never,
        quiet,
        transactions,
        { handoffBlockers: () => Promise.resolve([]) } as never,
        new ProjectDefectRepository(client),
      );
      const defects = new DefectsService(
        projects,
        new ProjectRepository(client),
        new ProjectChangeRequestRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTestItemRepository(client),
        new ProjectDefectRepository(client),
        new CompanyMemberRepository(client),
        quiet,
        transactions,
        evidence,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { companyId: true },
      });
      // an approved change added a line to the SOW
      const lastChange = await prisma.projectChangeRequest.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const change = await prisma.projectChangeRequest.create({
        data: {
          companyId: project.companyId,
          projectId,
          seq: (lastChange?.seq ?? 0) + 1,
          title: 'ส่งออก Excel',
          reason: 'ลูกค้าขอเพิ่ม',
          scopeAdded: 'ส่งออกรายงานเป็น Excel',
          status: 'approved',
          createdBy: engineer,
        },
      });
      const ref = `change:${change.id}`;
      const round = await dev.addIteration(
        projectId,
        { title: 'Sprint CR' },
        managerNow,
      );
      const sprint = round.iterations.find((row) => row.title === 'Sprint CR')!;
      const planned = await dev.addItems(
        projectId,
        sprint.id,
        { refs: [ref], owner_user_id: engineer },
        managerNow,
      );
      const taskId = planned.iterations
        .find((row) => row.id === sprint.id)!
        .items.find((item) => item.sowRef === ref)!.id;
      const status = async () =>
        (
          await prisma.projectTask.findUniqueOrThrow({
            where: { id: taskId },
            select: { status: true },
          })
        ).status;

      // no test of the line yet: the work is pending, not closed
      let view = await defects.view(projectId, crew);
      expect(view.lines.find((line) => line.ref === ref)).toMatchObject({
        tests: 0,
        pending: true,
        task: { id: taskId },
      });

      // its test passes: the task closes itself
      const lastItem = await prisma.projectTestItem.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const item = await prisma.projectTestItem.create({
        data: {
          companyId: project.companyId,
          projectId,
          seq: (lastItem?.seq ?? 0) + 1,
          source: 'change',
          sourceRef: ref,
          text: 'CR: ส่งออกรายงานเป็น Excel',
          createdBy: engineer,
        },
      });
      await prisma.projectTestRun.create({
        data: {
          companyId: project.companyId,
          itemId: item.id,
          result: 'pass',
          testedBy: engineer,
        },
      });
      await evidence.syncSow(projectId, ref, managerNow, now);
      expect(await status()).toBe('done');

      // a defect against the line reopens it
      await expect(
        defects.add(
          projectId,
          {
            title: 'x',
            severity: 'major',
            sow_ref: 'scope:999',
            found_on: '2026-10-08',
          },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      view = await defects.add(
        projectId,
        {
          title: 'ไฟล์ Excel ภาษาไทยเพี้ยน',
          severity: 'major',
          sow_ref: ref,
          found_on: '2026-10-08',
          assignee_user_id: engineer,
        },
        crew,
        now,
      );
      const bug = view.defects.find((row) => row.sowRef === ref)!;
      expect(bug).toMatchObject({
        status: 'open',
        assigneeName: expect.any(String) as never,
      });
      expect(await status()).toBe('in_progress');
      expect(view.lines.find((line) => line.ref === ref)).toMatchObject({
        tests: 1,
        passed: 1,
        openDefects: 1,
        pending: true,
      });

      // fixed is not enough; a failed retest reopens; only a passed retest closes
      await defects.move(
        projectId,
        bug.id,
        { action: 'fix', note: 'ตั้ง UTF-8 BOM' },
        crew,
        now,
      );
      expect(await status()).toBe('in_progress');
      await defects.move(
        projectId,
        bug.id,
        { action: 'reopen', note: 'ยังเพี้ยนบน Mac' },
        crew,
        now,
      );
      await expect(
        defects.move(
          projectId,
          bug.id,
          { action: 'verify', note: 'ผ่าน' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        defects.move(
          projectId,
          bug.id,
          { action: 'cancel', note: 'ซ้ำ' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await defects.move(
        projectId,
        bug.id,
        { action: 'fix', note: 'ใช้ xlsx แทน csv' },
        crew,
        now,
      );
      view = await defects.move(
        projectId,
        bug.id,
        { action: 'verify', note: 'ทดสอบซ้ำบน Windows และ Mac ผ่าน' },
        crew,
        now,
      );
      expect(view.defects.find((row) => row.id === bug.id)).toMatchObject({
        status: 'verified',
        reopenNote: 'ยังเพี้ยนบน Mac',
      });
      expect(await status()).toBe('done');
      expect(view.lines.find((line) => line.ref === ref)?.pending).toBe(false);
    });

    it('CD-214: releases and environments — production only after UAT and with no blocker, unless the manager overrides; the customer sees what runs', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const releases = new ReleasesService(
        projects,
        new ProjectEnvironmentRepository(client),
        new ProjectReleaseRepository(client),
        new ProjectDeploymentRepository(client),
        new ProjectDefectRepository(client),
        new ProjectUatFindingRepository(client),
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');
      const before = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { companyId: true, customerId: true },
      });
      const customerId = randomUUID();
      await prisma.project.update({
        where: { id: projectId },
        data: { customerId },
      });
      // whatever blockers earlier tests left are set aside for this one
      const parked = await prisma.projectDefect.findMany({
        where: {
          projectId,
          severity: 'blocker',
          status: { in: ['open', 'fixed'] },
        },
        select: { id: true, status: true },
      });
      const parkedUat = await prisma.projectUatFinding.findMany({
        where: {
          projectId,
          severity: 'blocker',
          status: { in: ['open', 'fixed'] },
        },
        select: { id: true, status: true },
      });
      await prisma.projectDefect.updateMany({
        where: { id: { in: parked.map((row) => row.id) } },
        data: { status: 'cancelled' },
      });
      await prisma.projectUatFinding.updateMany({
        where: { id: { in: parkedUat.map((row) => row.id) } },
        data: { status: 'confirmed' },
      });
      try {
        // the manager sets up the environments
        await expect(
          releases.saveEnvironment(
            projectId,
            null,
            { kind: 'dev', name: 'Dev' },
            crew,
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        for (const [kind, name] of [
          ['production', 'Production'],
          ['dev', 'Dev'],
          ['uat', 'UAT'],
        ]) {
          await releases.saveEnvironment(
            projectId,
            null,
            { kind, name, url: `https://${kind}.example.co.th` },
            managerNow,
          );
        }
        await expect(
          releases.saveEnvironment(
            projectId,
            null,
            { kind: 'uat', name: 'uat' },
            managerNow,
          ),
        ).rejects.toThrow('มี environment ชื่อนี้แล้ว');
        let view = await releases.view(projectId, crew);
        expect(view.environments.map((env) => env.kind)).toEqual([
          'dev',
          'uat',
          'production',
        ]);
        const env = (kind: string) =>
          view.environments.find((row) => row.kind === kind)!.id;

        // the team records a release; a version is recorded once
        view = await releases.addRelease(
          projectId,
          { version: '1.0.0', notes: 'รุ่นแรก' },
          crew,
        );
        await expect(
          releases.addRelease(projectId, { version: '1.0.0' }, crew),
        ).rejects.toThrow('มีเวอร์ชันนี้แล้ว');
        const first = view.releases[0].id;

        // not to production before UAT
        await expect(
          releases.deploy(
            projectId,
            first,
            { environment_id: env('production') },
            crew,
            now,
          ),
        ).rejects.toThrow('เวอร์ชันนี้ยังไม่เคย deploy บน UAT');
        await releases.deploy(
          projectId,
          first,
          { environment_id: env('dev') },
          crew,
          now,
        );
        await releases.deploy(
          projectId,
          first,
          { environment_id: env('uat') },
          crew,
          now,
        );

        // nor with a blocker open
        const lastDefect = await prisma.projectDefect.findFirst({
          where: { projectId },
          orderBy: { seq: 'desc' },
          select: { seq: true },
        });
        const blocker = await prisma.projectDefect.create({
          data: {
            companyId: before.companyId,
            projectId,
            seq: (lastDefect?.seq ?? 0) + 1,
            title: 'ล็อกอินไม่ได้',
            severity: 'blocker',
            sowRef: 'scope:0',
            foundOn: new Date('2026-10-07T00:00:00Z'),
            createdBy: engineer,
          },
        });
        await expect(
          releases.deploy(
            projectId,
            first,
            { environment_id: env('production') },
            crew,
            now,
          ),
        ).rejects.toThrow('ระดับปิดกั้นค้าง 1 รายการ');
        // the manager may override, with the reason — the team may not
        await expect(
          releases.deploy(
            projectId,
            first,
            { environment_id: env('production'), override_reason: 'ด่วน' },
            crew,
            now,
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        view = await releases.deploy(
          projectId,
          first,
          {
            environment_id: env('production'),
            override_reason: 'ลูกค้าต้องเปิดใช้วันนี้ ผู้บริหารอนุมัติแล้ว',
          },
          managerNow,
          now,
        );
        expect(
          view.releases[0].deployments.find((row) => row.kind === 'production'),
        ).toMatchObject({
          overrideReason: 'ลูกค้าต้องเปิดใช้วันนี้ ผู้บริหารอนุมัติแล้ว',
        });
        await prisma.projectDefect.update({
          where: { id: blocker.id },
          data: { status: 'verified' },
        });

        // the next version walks the path; production now runs it
        view = await releases.addRelease(projectId, { version: '1.0.1' }, crew);
        const second = view.releases.find((row) => row.version === '1.0.1')!.id;
        await releases.deploy(
          projectId,
          second,
          { environment_id: env('uat') },
          crew,
          new Date(now.getTime() + 30_000),
        );
        view = await releases.deploy(
          projectId,
          second,
          { environment_id: env('production') },
          crew,
          new Date(now.getTime() + 60_000),
        );
        expect(
          view.environments.map((row) => [row.kind, row.current?.version]),
        ).toEqual([
          ['dev', '1.0.0'],
          ['uat', '1.0.1'],
          ['production', '1.0.1'],
        ]);

        // the customer's 360° page: what each project runs
        const seen = await releases.forCustomer(customerId, managerNow);
        expect(seen).toHaveLength(1);
        expect(seen[0].environments[0]).toMatchObject({
          kind: 'production',
          version: '1.0.1',
        });
        // someone outside the project sees nothing of it
        expect(
          await releases.forCustomer(
            customerId,
            as(randomUUID(), ['notification.read']),
          ),
        ).toEqual([]);

        // an environment taken off keeps its history
        await releases.removeEnvironment(projectId, env('dev'), managerNow);
        view = await releases.view(projectId, crew);
        expect(view.environments).toHaveLength(2);
        expect(
          view.releases.find((row) => row.version === '1.0.0')!.deployments,
        ).toHaveLength(3);
      } finally {
        await prisma.project.update({
          where: { id: projectId },
          data: { customerId: before.customerId },
        });
        for (const row of parked) {
          await prisma.projectDefect.update({
            where: { id: row.id },
            data: { status: row.status },
          });
        }
        for (const row of parkedUat) {
          await prisma.projectUatFinding.update({
            where: { id: row.id },
            data: { status: row.status },
          });
        }
      }
    });

    it('CD-215: software documents per version — complete for the version on production, carried forward when unchanged, a readiness check only for software projects', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const storage = {
        put: (key: string, body: Buffer) => {
          files.set(key, body);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
        get: (key: string) => Promise.resolve(Readable.from([files.get(key)!])),
      };
      const docs = new SoftwareDocsService(
        projects,
        new ProjectSoftwareDocumentRepository(client),
        new ProjectReleaseRepository(client),
        new ProjectEnvironmentRepository(client),
        new ProjectDeploymentRepository(client),
        new ProjectTaskRepository(client),
        {
          findFirst: () =>
            Promise.resolve({
              projectSoftwareDocuments: ['คู่มือผู้ใช้', 'เอกสาร API'],
            }),
        } as never,
        new CompanyMemberRepository(client),
        storage,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const pdf = (name: string) => ({
        originalname: name,
        mimetype: 'application/pdf',
        size: 4,
        buffer: Buffer.from('%PDF'),
      });
      // CD-214 left UAT and production, production running 1.0.1
      let view = await docs.view(projectId, crew);
      expect(view.software).toBe(true);
      expect(view.target).toMatchObject({
        version: '1.0.1',
        basis: 'production',
      });
      expect(view.missing).toEqual(['คู่มือผู้ใช้', 'เอกสาร API']);
      const release = (version: string) =>
        view.releases.find((row) => row.version === version)!.id;

      // a file must say which version it describes
      await expect(
        docs.attach(projectId, { title: 'คู่มือผู้ใช้' }, pdf('a.pdf'), crew),
      ).rejects.toThrow('ต้องเลือกเวอร์ชันที่เอกสารนี้อธิบาย');
      // the manual written for 1.0.0 does not count for 1.0.1
      view = await docs.attach(
        projectId,
        { title: 'คู่มือผู้ใช้', release_id: release('1.0.0') },
        pdf('manual.pdf'),
        crew,
      );
      expect(view.missing).toEqual(['คู่มือผู้ใช้', 'เอกสาร API']);
      // unchanged for 1.0.1: carried forward, the same stored file
      const manual = view.documents[0].id;
      view = await docs.carry(projectId, manual, release('1.0.1'), crew);
      await expect(
        docs.carry(projectId, manual, release('1.0.1'), crew),
      ).rejects.toThrow('เวอร์ชันนี้มีไฟล์นี้แล้ว');
      expect(view.missing).toEqual(['เอกสาร API']);
      expect(
        new Set(
          (
            await prisma.projectSoftwareDocument.findMany({
              where: { projectId },
              select: { storageKey: true },
            })
          ).map((row) => row.storageKey),
        ).size,
      ).toBe(1);

      // readiness asks it of this (software) project
      const software = await docs.state(projectId, 'any');
      expect(software).toMatchObject({
        complete: false,
        missing: ['เอกสาร API'],
      });
      view = await docs.attach(
        projectId,
        { title: 'เอกสาร API', release_id: release('1.0.1') },
        pdf('api.pdf'),
        crew,
      );
      expect(view).toMatchObject({ complete: true, missing: [] });
      const file = await docs.download(projectId, view.documents[0].id, crew);
      expect(file.fileName).toBe('api.pdf');

      // only its uploader or the manager removes one
      const api = view.documents.find((row) => row.title === 'เอกสาร API')!;
      await expect(
        docs.detach(projectId, api.id, as(randomUUID(), ['pm.project.read'])),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      view = await docs.detach(projectId, api.id, managerNow);
      expect(view.missing).toEqual(['เอกสาร API']);

      // a project with no software work is not asked
      const plain = await prisma.project
        .findFirstOrThrow({
          where: {
            id: { not: projectId },
            environments: { none: {} },
            tasks: { none: { devKind: 'iteration' } },
          },
          select: { id: true },
        })
        .catch(() => null);
      if (plain) expect(await docs.state(plain.id, 'any')).toBeNull();
    });

    it('CD-217: configuration as searchable data — secrets sealed and revealed to the team only, every change kept with its reason and restorable', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const configs = new ConfigsService(
        projects,
        new ProjectConfigItemRepository(client),
        new ProjectConfigHistoryRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectEnvironmentRepository(client),
        new CompanyMemberRepository(client),
        { get: () => 'test-config-key' } as never,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const reader = as(randomUUID(), ['notification.read', 'pm.project.read']);
      let view = await configs.view(projectId, crew);
      const uat = view.environments.find((row) => row.label.startsWith('uat'))!;

      view = await configs.add(
        projectId,
        {
          system: 'Core switch',
          key: 'mgmt_ip',
          value: '10.20.0.1',
          note: 'VLAN 20',
        },
        crew,
      );
      // the same key on the same system once
      await expect(
        configs.add(
          projectId,
          { system: 'core SWITCH', key: 'MGMT_IP', value: '10.20.0.2' },
          crew,
        ),
      ).rejects.toThrow('มีค่านี้ในระบบเดียวกันแล้ว');
      view = await configs.add(
        projectId,
        {
          system: 'Web app',
          environment_id: uat.id,
          key: 'db_password',
          value: 'S3cret!',
          is_secret: true,
        },
        crew,
      );
      const ip = view.items.find((row) => row.key === 'mgmt_ip')!;
      const pw = view.items.find((row) => row.key === 'db_password')!;
      expect(pw).toMatchObject({ value: '••••••', isSecret: true });
      expect(pw.environmentLabel).toBe('UAT');
      // never stored readable
      const stored = await prisma.projectConfigItem.findUniqueOrThrow({
        where: { id: pw.id },
      });
      expect(stored.value).toBeNull();
      expect(stored.secretSealed).not.toContain('S3cret!');

      // the team reveals, and it is recorded; others see only that it exists
      await expect(
        configs.reveal(projectId, pw.id, reader),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect((await configs.view(projectId, reader)).items).toHaveLength(2);
      expect(await configs.reveal(projectId, pw.id, crew)).toEqual({
        value: 'S3cret!',
      });

      // a change needs its reason; old and new are kept
      await expect(
        configs.update(projectId, ip.id, { value: '10.20.0.9' }, crew),
      ).rejects.toThrow('ต้องระบุเหตุผลที่เปลี่ยน');
      await configs.update(
        projectId,
        ip.id,
        { value: '10.20.0.9', reason: 'ย้ายวง management' },
        crew,
      );
      // a secret edited without a new value keeps it
      await configs.update(
        projectId,
        pw.id,
        { note: 'หมุนรหัสทุก 90 วัน', reason: 'เพิ่มหมายเหตุ' },
        crew,
      );
      expect(await configs.reveal(projectId, pw.id, managerNow)).toEqual({
        value: 'S3cret!',
      });
      await configs.update(
        projectId,
        pw.id,
        { value: 'N3w!', reason: 'หมุนรหัส' },
        crew,
      );
      let history = await configs.historyOf(projectId, ip.id, crew);
      expect(
        history.entries.map((row) => [row.action, row.oldValue, row.newValue]),
      ).toEqual([
        ['updated', '10.20.0.1', '10.20.0.9'],
        ['created', null, '10.20.0.1'],
      ]);
      history = await configs.historyOf(projectId, pw.id, crew);
      expect(history.entries.map((row) => row.action)).toEqual([
        'updated',
        'revealed',
        'updated',
        'revealed',
        'created',
      ]);
      expect(history.entries[0]).toMatchObject({
        oldValue: '••••••',
        newValue: '••••••',
      });

      // restore the first secret
      const first = history.entries.find((row) => row.action === 'created')!;
      await configs.restore(
        projectId,
        pw.id,
        first.id,
        'รหัสใหม่ใช้ไม่ได้',
        crew,
      );
      expect(await configs.reveal(projectId, pw.id, crew)).toEqual({
        value: 'S3cret!',
      });

      // searchable, here and across projects — never by a secret
      expect((await configs.view(projectId, crew, '10.20')).items).toHaveLength(
        1,
      );
      const found = await configs.search(managerNow, '10.20.0');
      expect(found.find((row) => row.label === ip.label)).toMatchObject({
        projectId,
        value: '10.20.0.9',
      });
      expect(await configs.search(managerNow, 'S3cret')).toEqual([]);

      // removed with a reason (writer or manager); history stays
      await expect(
        configs.remove(projectId, ip.id, '', managerNow),
      ).rejects.toThrow('ต้องระบุเหตุผลที่นำออก');
      view = await configs.remove(
        projectId,
        ip.id,
        'เปลี่ยนอุปกรณ์',
        managerNow,
      );
      expect(view.items.map((row) => row.key)).toEqual(['db_password']);
      expect(
        (await configs.historyOf(projectId, ip.id, crew)).entries[0].action,
      ).toBe('removed');
    });

    it('CD-219: integration points — a customer owner from CRM or typed in, a connection test in the test plan, values kept in the configuration', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const integrations = new IntegrationsService(
        projects,
        new ProjectIntegrationRepository(client),
        new ProjectTestItemRepository(client),
        new ProjectConfigItemRepository(client),
        new CustomerContactRepository(client),
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const before = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { companyId: true, customerId: true },
      });
      const tag = randomUUID().slice(0, 8);
      const customer = await prisma.customer.create({
        data: {
          companyId: before.companyId,
          customerCode: `CUS-T219-${tag}`,
          nameTh: `ทดสอบเชื่อมต่อ ${tag}`,
          normalizedName: `ทดสอบเชื่อมต่อ ${tag}`,
          status: 'active',
          type: 'corporate',
        },
      });
      const other = await prisma.customer.create({
        data: {
          companyId: before.companyId,
          customerCode: `CUS-T219-${tag}-X`,
          nameTh: `อื่น ${tag}`,
          normalizedName: `อื่น ${tag}`,
          status: 'active',
          type: 'corporate',
        },
      });
      const admin = await prisma.customerContact.create({
        data: {
          customerId: customer.id,
          name: 'คุณวิภา',
          position: 'ผู้ดูแลระบบ ERP',
          email: 'wipa@example.co.th',
        },
      });
      const stranger = await prisma.customerContact.create({
        data: { customerId: other.id, name: 'คนนอก' },
      });
      await prisma.project.update({
        where: { id: projectId },
        data: { customerId: customer.id },
      });
      try {
        let view = await integrations.view(projectId, crew);
        expect(view.contacts).toEqual([
          { id: admin.id, label: 'คุณวิภา · ผู้ดูแลระบบ ERP' },
        ]);
        // an owner is needed, and must be this customer's
        await expect(
          integrations.add(
            projectId,
            {
              name: 'ส่งใบแจ้งหนี้',
              target_system: 'SAP',
              direction: 'outbound',
            },
            crew,
          ),
        ).rejects.toThrow('ต้องระบุผู้รับผิดชอบฝั่งลูกค้า');
        await expect(
          integrations.add(
            projectId,
            {
              name: 'ส่งใบแจ้งหนี้',
              target_system: 'SAP',
              direction: 'outbound',
              contact_id: stranger.id,
            },
            crew,
          ),
        ).rejects.toThrow('ผู้ติดต่อนี้ไม่ใช่ของลูกค้าโครงการนี้');
        view = await integrations.add(
          projectId,
          {
            name: 'ส่งใบแจ้งหนี้',
            target_system: 'SAP ของลูกค้า',
            direction: 'outbound',
            protocol: 'REST',
            endpoint: 'https://erp.example.co.th/api/invoices',
            contact_id: admin.id,
          },
          crew,
        );
        view = await integrations.add(
          projectId,
          {
            name: 'รับข้อมูลพนักงาน',
            target_system: 'HR ของลูกค้า',
            direction: 'inbound',
            protocol: 'SFTP',
            contact_name: 'คุณเอก (ผู้ขาย HR)',
            contact_email: 'ek@vendor.co.th',
          },
          crew,
        );
        await expect(
          integrations.add(
            projectId,
            {
              name: 'ส่งใบแจ้งหนี้',
              target_system: 'X',
              direction: 'both',
              contact_name: 'ก',
            },
            crew,
          ),
        ).rejects.toThrow('มีจุดเชื่อมต่อชื่อนี้แล้ว');
        const [invoice, hr] = view.integrations;
        expect(invoice.contact).toEqual({
          name: 'คุณวิภา',
          phone: null,
          email: 'wipa@example.co.th',
          fromCrm: true,
        });
        expect(hr.contact.fromCrm).toBe(false);

        // its connection test is in the test plan, untested until a run
        const item = await prisma.projectTestItem.findUniqueOrThrow({
          where: {
            projectId_sourceRef: {
              projectId,
              sourceRef: `integration:${invoice.id}`,
            },
          },
        });
        expect(item).toMatchObject({
          source: 'integration',
          text: `${invoice.label} ทดสอบการเชื่อมต่อ ส่งใบแจ้งหนี้ → SAP ของลูกค้า`,
        });
        expect(invoice.test).toMatchObject({ state: 'untested' });
        await prisma.projectTestRun.create({
          data: {
            companyId: before.companyId,
            itemId: item.id,
            result: 'pass',
            note: 'ส่งใบทดสอบ 3 ใบ เข้าครบ',
            testedBy: outsider,
          },
        });
        // renaming keeps the test in step; values filed under its name count
        await prisma.projectConfigItem.create({
          data: {
            companyId: before.companyId,
            projectId,
            seq: 9000,
            system: 'ส่งใบแจ้งหนี้ ERP',
            key: 'api_url',
            value: 'https://erp.example.co.th/api',
            createdBy: outsider,
          },
        });
        view = await integrations.update(
          projectId,
          invoice.id,
          { name: 'ส่งใบแจ้งหนี้ ERP' },
          crew,
        );
        expect(view.integrations[0]).toMatchObject({
          test: { state: 'passed', note: 'ส่งใบทดสอบ 3 ใบ เข้าครบ' },
          configCount: 1,
        });
        expect(
          (
            await prisma.projectTestItem.findUniqueOrThrow({
              where: { id: item.id },
            })
          ).text,
        ).toContain('ส่งใบแจ้งหนี้ ERP →');

        // removed with its test (the recorder or the manager)
        await expect(
          integrations.remove(
            projectId,
            hr.id,
            as(randomUUID(), ['notification.read', 'pm.project.read']),
          ),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        view = await integrations.remove(projectId, hr.id, managerNow);
        expect(view.integrations).toHaveLength(1);
        expect(
          (
            await prisma.projectTestItem.findUniqueOrThrow({
              where: {
                projectId_sourceRef: {
                  projectId,
                  sourceRef: `integration:${hr.id}`,
                },
              },
            })
          ).deletedAt,
        ).not.toBeNull();
      } finally {
        await prisma.projectConfigItem.deleteMany({
          where: { projectId, seq: 9000 },
        });
        await prisma.project.update({
          where: { id: projectId },
          data: { customerId: before.customerId },
        });
        await prisma.customerContact.deleteMany({
          where: { customerId: { in: [customer.id, other.id] } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: [customer.id, other.id] } },
        });
      }
    });

    it('CD-224: technical changes — BOQ, cost and scope impact, approved through the request engine; a scope change carries a CR and lands in the as-built once both are approved', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const tag = randomUUID().slice(0, 8);
      const statuses = new Map<string, string>();
      const requestRows = {
        findFirst: (args: { where: { id: string } }) =>
          Promise.resolve({
            status: statuses.get(args.where.id) ?? 'submitted',
          }),
        findMany: () => Promise.resolve([]),
      } as never;
      const asked: { form_data: Record<string, unknown> }[] = [];
      let seq = 0;
      const requests = {
        create: (input: { form_data: Record<string, unknown> }) => {
          asked.push(input);
          seq++;
          return Promise.resolve({ id: `req-tc-${tag}-${seq}` });
        },
        submit: () => Promise.resolve(),
      } as never;
      const changes = new ChangeRequestsService(
        projects,
        new ProjectChangeRequestRepository(client),
        new ProjectBudgetRepository(client),
        {
          findFirst: () => Promise.resolve({ projectChangeTypeCode: 'CHG' }),
        } as never,
        requestRows,
        requests,
        new CompanyMemberRepository(client),
        { changeDecided: () => Promise.resolve() } as never,
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const tech = new TechChangesService(
        projects,
        new ProjectRepository(client),
        new ProjectTechChangeRepository(client),
        new ProjectChangeRequestRepository(client),
        changes,
        {
          findFirst: () =>
            Promise.resolve({ projectTechChangeTypeCode: 'TCH' }),
        } as never,
        requestRows,
        requests,
        new CompanyMemberRepository(client),
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const deviationsBefore = await prisma.projectAsBuiltDeviation.count({
        where: { projectId },
      });
      const lastDeviation = await prisma.projectAsBuiltDeviation.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const crsBefore = (
        await prisma.projectChangeRequest.findMany({
          where: { projectId },
          select: { id: true },
        })
      ).map((row) => row.id);
      try {
        // the BOQ the baseline sold (CD-216 set it: two cameras)
        let view = await tech.view(projectId, crew);
        expect(view.boq[0]).toMatchObject({ ref: 'boq:0' });
        await expect(
          tech.create(
            projectId,
            { title: 'x', lines: [{ ref: 'boq:0', quantity_to: 2 }] },
            crew,
          ),
        ).rejects.toThrow('จำนวนไม่เปลี่ยน');
        view = await tech.create(
          projectId,
          {
            title: 'เพิ่มกล้องทางเข้า',
            reason: 'ทางเข้าด้านหลังไม่มีมุมมอง',
            lines: [{ ref: 'boq:0', quantity_to: 3, unit_cost: 4000 }],
          },
          crew,
        );
        const first = view.changes[0];
        expect(first).toMatchObject({
          label: 'TC-1',
          costChange: 4000,
          status: 'draft',
        });
        expect(first.lines[0]).toMatchObject({
          name: 'กล้อง IP',
          quantityFrom: 2,
        });

        // the manager submits it, through the request engine
        await expect(
          tech.submit(projectId, first.id, crew, 'Bearer x'),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        view = await tech.submit(projectId, first.id, managerNow, 'Bearer x');
        expect(asked[0].form_data).toMatchObject({
          tech_change_no: 'TC-1',
          affects_scope: 0,
          cost_change: 4000,
        });
        const firstRequest = `req-tc-${tag}-1`;
        statuses.set(firstRequest, 'approved');
        await tech.syncRequest(firstRequest);
        view = await tech.view(projectId, crew);
        expect(view.changes[0]).toMatchObject({
          status: 'approved',
          inForce: true,
          applied: true,
        });
        // it is in the as-built now, explaining the third camera
        const landed = await prisma.projectAsBuiltDeviation.findMany({
          where: { projectId },
          orderBy: { seq: 'desc' },
          take: 1,
        });
        expect(landed[0]).toMatchObject({
          reference: 'boq:0',
          planned: 'กล้อง IP × 2 ตัว',
          built: 'กล้อง IP × 3 ตัว',
          reason: 'TC-1 เพิ่มกล้องทางเข้า: ทางเข้าด้านหลังไม่มีมุมมอง',
        });
        // once only
        await tech.syncRequest(firstRequest);
        await tech.view(projectId, crew);
        expect(
          await prisma.projectAsBuiltDeviation.count({ where: { projectId } }),
        ).toBe(deviationsBefore + 1);

        // a scope change: a CR must be opened (by the manager) before it goes
        view = await tech.create(
          projectId,
          {
            title: 'ย้ายห้องควบคุม',
            reason: 'ลูกค้าเปลี่ยนห้อง',
            lines: [{ ref: 'boq:1', quantity_to: 150 }],
            affects_scope: true,
            scope_added: 'เดินสายเพิ่มไปห้องควบคุมใหม่ชั้น 2',
          },
          crew,
        );
        const second = view.changes.find((row) => row.label === 'TC-2')!;
        await expect(
          tech.submit(projectId, second.id, managerNow, 'Bearer x'),
        ).rejects.toThrow('ต้องเปิดคำขอเปลี่ยนแปลง (CR) ก่อนยื่น');
        await expect(
          tech.openChange(projectId, second.id, crew),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const opened = await tech.openChange(projectId, second.id, managerNow);
        const cr = await prisma.projectChangeRequest.findUniqueOrThrow({
          where: { id: opened.changeId },
        });
        expect(cr).toMatchObject({
          title: 'TC-2: ย้ายห้องควบคุม',
          scopeAdded: 'เดินสายเพิ่มไปห้องควบคุมใหม่ชั้น 2',
          status: 'draft',
        });
        expect(cr.costLines).toEqual([
          expect.objectContaining({ description: 'สาย LAN', quantity: 50 }),
        ]);
        await tech.submit(projectId, second.id, managerNow, 'Bearer x');
        const secondRequest = `req-tc-${tag}-2`;
        statuses.set(secondRequest, 'approved');
        await tech.syncRequest(secondRequest);
        view = await tech.view(projectId, crew);
        // approved, but waiting on its CR
        expect(view.changes.find((row) => row.label === 'TC-2')).toMatchObject({
          status: 'approved',
          inForce: false,
          applied: false,
          change: { status: 'draft' },
        });

        // the CR's board approves: the change is in force and in the as-built
        // (its cost lines dropped here, so no budget version is written)
        const crRequest = `req-cr-${tag}`;
        await prisma.projectChangeRequest.update({
          where: { id: cr.id },
          data: { status: 'submitted', requestId: crRequest, costLines: [] },
        });
        statuses.set(crRequest, 'approved');
        await tech.syncRequest(crRequest);
        view = await tech.view(projectId, crew);
        expect(view.changes.find((row) => row.label === 'TC-2')).toMatchObject({
          inForce: true,
          applied: true,
          change: { status: 'approved' },
        });
        const scoped = await prisma.projectAsBuiltDeviation.findFirstOrThrow({
          where: { projectId, reference: 'boq:1', changeRequestId: cr.id },
        });
        expect(scoped).toMatchObject({
          planned: 'สาย LAN × 100 ม.',
          built: 'สาย LAN × 150 ม.',
          affectsScope: true,
        });

        // a draft withdrawn
        view = await tech.create(projectId, { title: 'ทดลอง' }, crew);
        const third = view.changes.find((row) => row.label === 'TC-3')!;
        view = await tech.cancel(projectId, third.id, crew);
        expect(view.changes.map((row) => row.label)).toEqual(['TC-2', 'TC-1']);
      } finally {
        // what this test added stays out of the tests after it
        await prisma.projectAsBuiltDeviation.deleteMany({
          where: { projectId, seq: { gt: lastDeviation?.seq ?? 0 } },
        });
        await prisma.projectTechChange.deleteMany({ where: { projectId } });
        await prisma.projectChangeRequest.deleteMany({
          where: { projectId, id: { notIn: crsBefore } },
        });
      }
    });

    it("CD-190: actual cost against the locked budget — labour from timesheets at the day's rate, ERP and manual costs, thresholds told once", async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const storage = {
        put: (key: string, body: Buffer) => {
          files.set(key, body);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
        get: (key: string) => Promise.resolve(Readable.from([files.get(key)!])),
      };
      let erpLines = [
        {
          key: 'PCH:1:0',
          docNo: '5001',
          postedOn: '2026-10-01',
          itemCode: 'CAM-1',
          description: 'กล้อง IP',
          amount: 60000,
          category: 'material' as const,
          vendorName: 'ผู้ขายกล้อง',
        },
        {
          key: 'PCH:2:0',
          docNo: '5002',
          postedOn: '2026-10-02',
          itemCode: null,
          description: 'ค่าขนส่ง',
          amount: 500,
          category: 'other' as const,
          vendorName: null,
        },
      ];
      const told: string[] = [];
      const costs = new ProjectCostsService(
        projects,
        new ProjectRepository(client),
        new ProjectBudgetRepository(client),
        new ProjectCostRepository(client),
        new ProjectCostAlertRepository(client),
        new CompanyRepository(client),
        { findFirst: () => Promise.resolve(null) } as never,
        {
          // 10 approved man-days: 8 on 30 Sep at 4,000, 2 from 1 Oct at 4,800
          projectActuals: () =>
            Promise.resolve({
              hours: 84,
              mandays: 10.5,
              lines: [
                {
                  levelId: 'L2',
                  workTypeId: 'W1',
                  date: '2026-09-30',
                  hours: 64,
                },
                {
                  levelId: 'L2',
                  workTypeId: 'W1',
                  date: '2026-10-01',
                  hours: 16,
                },
                {
                  levelId: null,
                  workTypeId: 'W1',
                  date: '2026-10-01',
                  hours: 4,
                },
              ],
            }),
        } as never,
        {
          rateRows: () =>
            Promise.resolve([
              {
                levelId: 'L2',
                workTypeId: 'W1',
                validFrom: '2026-01-01',
                validTo: '2026-09-30',
                costPerManday: 4000,
              },
              {
                levelId: 'L2',
                workTypeId: 'W1',
                validFrom: '2026-10-01',
                validTo: null,
                costPerManday: 4800,
              },
            ]),
        } as never,
        { listProjectCosts: () => Promise.resolve(erpLines) } as never,
        new CompanyMemberRepository(client),
        {
          projectCostAlert: (
            userId: string,
            _c: string,
            input: { category: string; level: string },
          ) => {
            told.push(
              `${userId === engineer ? 'pm' : userId}:${input.category}:${input.level}`,
            );
            return Promise.resolve();
          },
        } as never,
        storage,
        audit,
        transactions,
        { get: () => 0 } as never,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      // what the manager was told; the pricing team gets the same
      const toPm = () => told.filter((line) => line.startsWith('pm:'));
      const companyId = (
        await prisma.project.findUniqueOrThrow({
          where: { id: projectId },
          select: { companyId: true },
        })
      ).companyId;
      // a known locked budget for this test, the versions before set aside
      const before = await prisma.projectBudget.findMany({
        where: { projectId },
        select: { id: true, status: true, versionNo: true },
      });
      await prisma.projectBudget.updateMany({
        where: { projectId, status: 'locked' },
        data: { status: 'superseded' },
      });
      const versionNo =
        before.reduce((max, row) => Math.max(max, row.versionNo), 0) + 1;
      const budget = await prisma.projectBudget.create({
        data: {
          companyId,
          projectId,
          versionNo,
          status: 'locked',
          total: 150000,
          lines: [
            {
              category: 'material',
              code: null,
              description: 'อุปกรณ์',
              quantity: 1,
              unit: null,
              unitCost: 100000,
              amount: 100000,
            },
            {
              category: 'labor',
              code: null,
              description: 'แรงงาน',
              quantity: 1,
              unit: null,
              unitCost: 50000,
              amount: 50000,
            },
          ],
          createdBy: engineer,
        },
      });
      try {
        // labour 8×4,000 + 2×4,800 = 41,600; 4 hours with no level unpriced
        let view = await costs.view(projectId, crew);
        expect(view.labor).toEqual({
          amount: 41600,
          hours: 84,
          mandays: 10.5,
          unpricedHours: 4,
        });
        expect(view.budget).toEqual({ versionNo });

        // the ERP's lines come in on a sync (the manager's, or the pass)
        await expect(costs.syncNow(projectId, crew)).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        view = await costs.syncNow(projectId, managerNow);
        expect(
          view.rows.map((row) => [row.category, row.actual, row.level]),
        ).toEqual([
          ['material', 60000, 'ok'],
          ['labor', 41600, 'ok'],
          // spent with nothing budgeted
          ['other', 500, 'over'],
          ['total', 102100, 'ok'],
        ]);
        expect(toPm()).toEqual(['pm:อื่น ๆ:over']);

        // the manager records a cost, with its evidence
        const pdf = {
          originalname: 'receipt.pdf',
          mimetype: 'application/pdf',
          size: 4,
          buffer: Buffer.from('%PDF'),
        };
        await expect(
          costs.add(
            projectId,
            {
              category: 'material',
              description: 'รถกระเช้า',
              amount: '35000',
              incurred_on: '2026-10-03',
            },
            undefined,
            managerNow,
          ),
        ).rejects.toThrow('ต้องแนบหลักฐาน');
        view = await costs.add(
          projectId,
          {
            category: 'material',
            description: 'รถกระเช้า',
            amount: '35000',
            incurred_on: '2026-10-03',
          },
          pdf,
          managerNow,
        );
        // material 95,000 = 95%: warned; told once
        expect(view.rows[0]).toMatchObject({
          actual: 95000,
          pct: 95,
          level: 'warn',
        });
        // and the total, 137,100 of 150,000 = 91.4%
        expect(toPm()).toEqual([
          'pm:อื่น ๆ:over',
          'pm:วัสดุ/อุปกรณ์:warn',
          'pm:รวม:warn',
        ]);
        const sent = told.length;
        await costs.check(projectId, companyId);
        expect(told).toHaveLength(sent);
        const manual = view.entries.find((row) => row.source === 'manual')!;
        expect(
          (await costs.evidence(projectId, manual.id, crew)).fileName,
        ).toBe('receipt.pdf');

        // a line the ERP no longer lists goes; a manual one stays
        erpLines = erpLines.slice(0, 1);
        view = await costs.syncNow(projectId, managerNow);
        expect(view.rows.find((row) => row.category === 'other')).toMatchObject(
          {
            actual: 0,
          },
        );
        expect(view.entries.map((row) => row.source).sort()).toEqual([
          'erp',
          'manual',
        ]);
        const erpRow = view.entries.find((row) => row.source === 'erp')!;
        await expect(
          costs.remove(projectId, erpRow.id, managerNow),
        ).rejects.toThrow('รายการจาก ERP');
        view = await costs.remove(projectId, manual.id, managerNow);
        expect(view.rows[0]).toMatchObject({ actual: 60000 });
      } finally {
        await prisma.projectCostAlert.deleteMany({ where: { projectId } });
        await prisma.projectCost.deleteMany({ where: { projectId } });
        await prisma.projectBudget.delete({ where: { id: budget.id } });
        for (const row of before) {
          await prisma.projectBudget.update({
            where: { id: row.id },
            data: { status: row.status },
          });
        }
      }
    });

    it('CD-180: the team on the project — an overbooking names its priority and reason and tells the clashing project, more people asked through the request engine, load by week', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const tag = randomUUID().slice(0, 8);
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { companyId: true, projectNo: true },
      });
      const companyId = project.companyId;
      // a second project that already has the person booked
      const other = await prisma.project.findFirst({
        where: { companyId, id: { not: projectId } },
        select: { id: true, managerUserId: true },
      });
      const otherId = other?.id ?? projectId;
      const person = outsider;
      // CD-232 stood in: 8 h a working day, minus what hr_bookings hold
      const hours = async (userId: string, from: string, to: string) => {
        const rows = await prisma.hrBooking.findMany({
          where: { userId, cancelledAt: null },
        });
        const days: DayAvailability[] = [];
        for (
          let at = Date.parse(`${from}T00:00:00Z`);
          at <= Date.parse(`${to}T00:00:00Z`);
          at += 86_400_000
        ) {
          const d = new Date(at).toISOString().slice(0, 10);
          const working = ![0, 6].includes(new Date(at).getUTCDay());
          const booked = working
            ? rows
                .filter(
                  (row) =>
                    row.startDate.toISOString().slice(0, 10) <= d &&
                    row.endDate.toISOString().slice(0, 10) >= d,
                )
                .map((row) => ({
                  bookingId: row.id,
                  projectId: row.projectId,
                  hours: Number(row.hoursPerDay),
                }))
            : [];
          const bookedHours = booked.reduce((sum, b) => sum + b.hours, 0);
          const capacity = working ? 8 : 0;
          days.push({
            day: d,
            working,
            capacity,
            leaveHours: 0,
            pendingLeave: false,
            leaveType: null,
            booked,
            bookedHours,
            free: capacity - bookedHours,
          });
        }
        return days;
      };
      const availability = {
        availabilityFor: async (
          _c: string,
          userIds: string[],
          from: string,
          to: string,
        ) =>
          new Map(
            await Promise.all(
              userIds.map(
                async (id) => [id, await hours(id, from, to)] as const,
              ),
            ),
          ),
        createBooking: async (
          actor: { userId: string },
          dto: {
            user_id: string;
            project_id: string;
            start_date: string;
            end_date: string;
            hours_per_day: number;
          },
        ) => {
          const row = await prisma.hrBooking.create({
            data: {
              companyId,
              userId: dto.user_id,
              projectId: dto.project_id,
              startDate: new Date(`${dto.start_date}T00:00:00Z`),
              endDate: new Date(`${dto.end_date}T00:00:00Z`),
              hoursPerDay: dto.hours_per_day,
              createdBy: actor.userId,
            },
          });
          return { booking: { id: row.id }, overbooked: [] };
        },
        cancelBooking: (actor: { userId: string }, id: string) =>
          prisma.hrBooking.update({
            where: { id },
            data: { cancelledAt: new Date(), cancelledBy: actor.userId },
          }),
        availability: async (_a: unknown, q: { from: string; to: string }) => ({
          projects: {},
          people: [
            {
              userId: person,
              name: 'ช่าง',
              days: await hours(person, q.from, q.to),
              totals: { capacity: 0, leave: 0, booked: 0, free: 0 },
            },
          ],
        }),
      };
      const statuses = new Map<string, string>();
      let seq = 0;
      const asked: { form_data: Record<string, unknown> }[] = [];
      const told: string[] = [];
      const resources = new ResourcesService(
        projects,
        new ProjectRepository(client),
        availability as never,
        new HrBookingRepository(client),
        new ProjectBookingPriorityRepository(client),
        new ProjectResourceRequestRepository(client),
        {
          findFirst: () => Promise.resolve({ projectResourceTypeCode: 'RES' }),
        } as never,
        {
          findFirst: (args: { where: { id: string } }) =>
            Promise.resolve({
              status: statuses.get(args.where.id) ?? 'submitted',
            }),
          findMany: () => Promise.resolve([]),
        } as never,
        {
          create: (input: { form_data: Record<string, unknown> }) => {
            asked.push(input);
            seq++;
            return Promise.resolve({ id: `req-rr-${tag}-${seq}` });
          },
          submit: () => Promise.resolve(),
        } as never,
        new CompanyMemberRepository(client),
        {
          resourceConflict: (
            userId: string,
            _c: string,
            input: { priority: string },
          ) => {
            told.push(`${userId}:${input.priority}`);
            return Promise.resolve();
          },
        } as never,
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      // Mon 12 – Fri 16 Oct 2026; the other project holds 6 h a day
      const held = await prisma.hrBooking.create({
        data: {
          companyId,
          userId: person,
          projectId: otherId,
          startDate: new Date('2026-10-12T00:00:00Z'),
          endDate: new Date('2026-10-16T00:00:00Z'),
          hoursPerDay: 6,
          createdBy: engineer,
        },
      });
      try {
        const want = {
          user_id: person,
          start_date: '2026-10-12',
          end_date: '2026-10-18',
          hours_per_day: 4,
        };
        await expect(
          resources.preview(projectId, want, crew),
        ).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        const preview = await resources.preview(projectId, want, managerNow);
        // 5 working days short by 2 h; the weekend is not counted
        expect(preview.overbooked).toHaveLength(5);
        expect(preview.overbooked[0]).toMatchObject({
          day: '2026-10-12',
          free: 2,
          short: 2,
        });
        if (otherId !== projectId) {
          expect(preview.conflicts.map((row) => row.projectId)).toEqual([
            otherId,
          ]);
        }

        // past what is free: a priority and its reason, or no booking
        await expect(
          resources.book(projectId, want, managerNow),
        ).rejects.toThrow('ต้องระบุว่าโครงการไหนมาก่อน');
        let view = await resources.book(
          projectId,
          { ...want, priority: 'this_first', reason: 'ลูกค้าเร่งเปิดระบบ' },
          managerNow,
          // the view's "today" is the default; bookings run in the future
        );
        const mine = view.bookings.find(
          (row) => row.userId === person && row.hoursPerDay === 4,
        )!;
        expect(mine).toMatchObject({ hoursPerDay: 4, overbookedDays: 5 });
        expect(mine.priority).toMatchObject({
          priority: 'this_first',
          reason: 'ลูกค้าเร่งเปิดระบบ',
        });
        if (otherId !== projectId && other!.managerUserId !== engineer) {
          expect(told).toEqual([`${other!.managerUserId}:this_first`]);
        }
        // within what is free: no priority asked
        view = await resources.book(
          projectId,
          {
            user_id: person,
            start_date: '2026-10-19',
            end_date: '2026-10-23',
            hours_per_day: 8,
          },
          managerNow,
        );
        expect(
          view.bookings.find((row) => row.startDate === '2026-10-19'),
        ).toMatchObject({ overbookedDays: 0, priority: null });

        // the team reads it; cancelling frees the time
        expect(
          (await resources.view(projectId, crew)).bookings.length,
        ).toBeGreaterThanOrEqual(2);
        view = await resources.cancelBooking(projectId, mine.id, managerNow);
        expect(view.bookings.some((row) => row.id === mine.id)).toBe(false);

        // more people, through the request engine
        await expect(
          resources.ask(
            projectId,
            {
              role: '',
              headcount: 0,
              start_date: '2026-10-12',
              end_date: '2026-10-30',
              hours_per_day: 8,
            },
            managerNow,
            'Bearer x',
          ),
        ).rejects.toThrow('ต้องระบุตำแหน่งหรือทักษะที่ต้องการ');
        view = await resources.ask(
          projectId,
          {
            role: 'วิศวกรเครือข่าย',
            headcount: 2,
            start_date: '2026-10-12',
            end_date: '2026-10-30',
            hours_per_day: 8,
          },
          managerNow,
          'Bearer x',
        );
        expect(asked[0].form_data).toMatchObject({
          resource_request_no: 'RR-1',
          role: 'วิศวกรเครือข่าย',
          headcount: 2,
        });
        expect(view.requests[0]).toMatchObject({
          label: 'RR-1',
          status: 'submitted',
        });
        await expect(
          resources.fulfil(projectId, view.requests[0].id, managerNow),
        ).rejects.toThrow('ปิดได้เฉพาะคำขอที่อนุมัติแล้ว');
        statuses.set(`req-rr-${tag}-1`, 'approved');
        await resources.syncRequest(`req-rr-${tag}-1`);
        view = await resources.fulfil(
          projectId,
          view.requests[0].id,
          managerNow,
        );
        expect(view.requests[0].status).toBe('fulfilled');

        // the load by week, Monday-aligned
        const load = await resources.workload(managerNow, {
          from: '2026-10-14',
          weeks: '2',
        });
        expect(load.weeks).toEqual(['2026-10-12', '2026-10-19']);
        expect(load.people[0].weeks[1]).toMatchObject({
          week: '2026-10-19',
          booked: 40,
          pct: 100,
        });
      } finally {
        await prisma.projectBookingPriority.deleteMany({
          where: { projectId },
        });
        await prisma.projectResourceRequest.deleteMany({
          where: { projectId },
        });
        await prisma.hrBooking.deleteMany({
          where: { OR: [{ projectId }, { id: held.id }] },
        });
      }
    });

    it('CD-210: a site survey synced from the device — the Solution assumptions checked one by one, each that differs a change request before it completes', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const storage = {
        put: (key: string, body: Buffer) => {
          files.set(key, body);
          return Promise.resolve();
        },
        remove: (key: string) => {
          files.delete(key);
          return Promise.resolve();
        },
        get: (key: string) => Promise.resolve(Readable.from([files.get(key)!])),
      };
      const changes = new ChangeRequestsService(
        projects,
        new ProjectChangeRequestRepository(client),
        new ProjectBudgetRepository(client),
        { findFirst: () => Promise.resolve(null) } as never,
        {
          findFirst: () => Promise.resolve(null),
          findMany: () => Promise.resolve([]),
        } as never,
        {} as never,
        new CompanyMemberRepository(client),
        {} as never,
        { on: () => undefined } as never,
        audit,
        transactions,
      );
      const surveys = new SurveysService(
        projects,
        new ProjectRepository(client),
        new ProjectSurveyRepository(client),
        new ProjectSurveyPhotoRepository(client),
        changes,
        new CompanyMemberRepository(client),
        storage,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');
      // the Solution assumed power at every point and a low ceiling
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { baseline: true },
      });
      const baseline = project.baseline as Record<string, unknown>;
      await prisma.project.update({
        where: { id: projectId },
        data: {
          baseline: {
            ...baseline,
            scope: {
              ...(baseline.scope as Record<string, unknown>),
              assumptions: [
                {
                  category: 'site',
                  text: 'มีไฟเลี้ยงทุกจุด',
                  owner: 'customer',
                },
                {
                  category: 'site',
                  text: 'เพดานสูงไม่เกิน 4 ม.',
                  owner: 'customer',
                },
              ],
            },
          } as never,
        },
      });
      const surveyId = '7b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

      // the crew syncs the draft made offline; syncing again only updates it
      const first = await surveys.save(
        projectId,
        {
          id: surveyId,
          site: 'อาคาร A',
          surveyed_on: '2026-10-07',
          latitude: 13.7563,
          longitude: 100.5018,
          assumptions: [{ index: 0, holds: true }],
        },
        crew,
        now,
      );
      expect(first.assumptions).toEqual([
        'มีไฟเลี้ยงทุกจุด',
        'เพดานสูงไม่เกิน 4 ม.',
      ]);
      await surveys.save(
        projectId,
        {
          id: surveyId,
          assumptions: [{ index: 1, holds: false, note: 'เพดานสูง 6 ม.' }],
        },
        crew,
        now,
      );
      let view = await surveys.view(projectId, crew);
      expect(view.surveys).toHaveLength(1);
      expect(view.surveys[0]).toMatchObject({
        label: 'S-1',
        site: 'อาคาร A',
        surveyedOn: '2026-10-07',
        latitude: 13.7563,
        status: 'draft',
        mayComplete: true,
      });
      expect(view.surveys[0].assumptions.map((row) => row.holds)).toEqual([
        true,
        false,
      ]);
      await expect(
        surveys.save(
          projectId,
          { id: 'not-a-uuid', site: 'x', surveyed_on: '2026-10-07' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        surveys.save(
          projectId,
          {
            id: '8b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d',
            site: 'x',
            surveyed_on: '2026-10-09',
          },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // a photo synced twice is kept once
      const photoId = '9c0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
      const file = {
        originalname: 'ceiling.jpg',
        mimetype: 'image/jpeg',
        size: 3,
        buffer: Buffer.from('jpg'),
      };
      await surveys.addPhoto(
        projectId,
        surveyId,
        {
          id: photoId,
          caption: 'เพดาน',
          latitude: '13.7563',
          longitude: '100.5018',
        },
        file,
        crew,
      );
      view = await surveys.addPhoto(
        projectId,
        surveyId,
        { id: photoId },
        file,
        crew,
      );
      expect(view.surveys[0].photos).toEqual([
        expect.objectContaining({ id: photoId, caption: 'เพดาน' }) as never,
      ]);
      expect(files.size).toBe(1);
      await expect(
        surveys.addPhoto(
          projectId,
          surveyId,
          { id: 'a0c0c1d2-3f40-4a5b-8c6d-7e8f9a0b1c2d' },
          { ...file, mimetype: 'application/pdf' },
          crew,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // it cannot complete while the differing assumption is not a change request
      await expect(
        surveys.complete(projectId, surveyId, crew, now),
      ).rejects.toThrow(
        'สมมติฐานที่ไม่ตรงต้องแปลงเป็นคำขอเปลี่ยนแปลงก่อน: ข้อ 2',
      );
      // only the manager converts it; one that holds cannot be converted
      await expect(
        surveys.toChange(projectId, surveyId, 1, crew),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        surveys.toChange(projectId, surveyId, 0, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      const converted = await surveys.toChange(
        projectId,
        surveyId,
        1,
        managerNow,
      );
      const change = await prisma.projectChangeRequest.findUniqueOrThrow({
        where: { id: converted.changeId },
      });
      expect(change.title).toBe(
        'S-1: สมมติฐานไม่ตรงหน้างาน — เพดานสูงไม่เกิน 4 ม.',
      );
      expect(change.status).toBe('draft');
      expect(converted.surveys[0].assumptions[1].changeRequestId).toBe(
        converted.changeId,
      );
      await expect(
        surveys.toChange(projectId, surveyId, 1, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // a later sync from the device does not lose the link
      await surveys.save(
        projectId,
        {
          id: surveyId,
          summary: 'ต้องใช้นั่งร้าน',
          assumptions: [{ index: 1, holds: false, note: 'เพดานสูง 6 ม.' }],
        },
        crew,
        now,
      );

      // completed, then read only
      view = await surveys.complete(projectId, surveyId, crew, now);
      expect(view.surveys[0]).toMatchObject({
        status: 'completed',
        summary: 'ต้องใช้นั่งร้าน',
        problems: [],
        mayEdit: false,
      });
      expect(view.surveys[0].assumptions[1].changeRequestId).toBe(
        converted.changeId,
      );
      await expect(
        surveys.save(projectId, { id: surveyId, summary: 'แก้' }, crew, now),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // the photo is still there to read
      const read = await surveys.photo(projectId, surveyId, photoId, crew);
      expect(read.fileName).toBe('ceiling.jpg');
    });

    it('CD-226: as-built — the required documents, and every deviation from what was sold with its reason', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const files = new Map<string, Buffer>();
      const asBuilt = new AsBuiltService(
        projects,
        new ProjectRepository(client),
        new ProjectAsBuiltDocumentRepository(client),
        new ProjectAsBuiltDeviationRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectDesignRepository(client),
        new ProjectChangeRequestRepository(client),
        {
          findFirst: () =>
            Promise.resolve({ projectAsBuiltDocuments: ['แบบติดตั้งจริง'] }),
        } as never,
        new CompanyMemberRepository(client),
        {
          put: (key: string, body: Buffer) => {
            files.set(key, body);
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
          get: (key: string) =>
            Promise.resolve(Readable.from([files.get(key)!])),
        },
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const drawing = {
        originalname: 'as-built.pdf',
        mimetype: 'application/pdf',
        size: 4,
        buffer: Buffer.from('%PDF'),
      };

      const first = await asBuilt.view(projectId, crew);
      expect(first.canWrite).toBe(true);
      expect(first).toMatchObject({
        complete: false,
        missingDocuments: ['แบบติดตั้งจริง'],
      });

      // the team uploads; only its uploader or the manager takes it off
      const attached = await asBuilt.attach(
        projectId,
        { title: 'แบบติดตั้งจริง' },
        drawing,
        crew,
      );
      expect(attached.complete).toBe(true);
      const docId = attached.required[0].documentIds[0];
      expect(
        (await asBuilt.download(projectId, docId, managerNow)).fileName,
      ).toBe('as-built.pdf');

      // a deviation needs what was planned and what was built, inside the baseline
      await expect(
        asBuilt.addDeviation(
          projectId,
          { planned: 'x', built: 'y', reference: 'boq:999' },
          crew,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const reference = first.refs[0]?.ref;
      const noted = await asBuilt.addDeviation(
        projectId,
        {
          planned: 'ติดตั้งตามแบบ',
          built: 'ย้ายจุดติดตั้ง 1 จุด',
          reference,
        },
        crew,
      );
      expect(noted.complete).toBe(false);
      expect(noted.openDeviations).toEqual(['D-1: ยังไม่มีเหตุผล']);
      const d1 = noted.deviations[0];
      expect(d1.referenceLabel).toBe(first.refs[0]?.label ?? null);

      // a reason settles it — unless it changes the scope
      await asBuilt.updateDeviation(
        projectId,
        d1.id,
        { reason: 'ผนังเดิมเจาะไม่ได้', affects_scope: true },
        crew,
      );
      const scoped = await asBuilt.view(projectId, crew);
      expect(scoped.openDeviations).toEqual([
        'D-1: กระทบขอบเขต ต้องผูกกับคำขอเปลี่ยนแปลงที่อนุมัติแล้ว',
      ]);
      // only the manager links the change request, and only an approved one settles it
      const approved = await prisma.projectChangeRequest.findFirst({
        where: { projectId, status: 'approved' },
        select: { id: true },
      });
      const change =
        approved ??
        (await prisma.projectChangeRequest.create({
          data: {
            companyId,
            projectId,
            seq: 900,
            title: 'ย้ายจุด',
            reason: 'ทดสอบ',
            status: 'approved',
            createdBy: engineer,
          },
          select: { id: true },
        }));
      await expect(
        asBuilt.updateDeviation(
          projectId,
          d1.id,
          { change_request_id: change.id },
          crew,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const settled = await asBuilt.updateDeviation(
        projectId,
        d1.id,
        { change_request_id: change.id },
        managerNow,
      );
      expect(settled).toMatchObject({ complete: true, openDeviations: [] });
      expect((await asBuilt.state(projectId, companyId)).complete).toBe(true);
    });

    it('CD-222: UAT — points with their severity, fixes the customer confirms, and blockers that hold acceptance', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const told: string[] = [];
      const uat = new UatService(
        projects,
        new ProjectUatFindingRepository(client),
        new ProjectTestItemRepository(client),
        new CompanyMemberRepository(client),
        {
          uatAssigned: (
            userId: string,
            _c: string,
            _p: unknown,
            no: string,
          ) => {
            told.push(`${userId}:${no}`);
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');

      // the team records what the customer found
      await expect(
        uat.add(
          projectId,
          { title: ' ', severity: 'blocker', reported_on: '2026-10-08' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await uat.add(
        projectId,
        {
          title: 'พิมพ์รายงานไม่ได้',
          severity: 'blocker',
          reported_by: 'คุณสมชาย',
          reported_on: '2026-10-08',
          owner_user_id: outsider,
        },
        managerNow,
        now,
      );
      const added = await uat.add(
        projectId,
        {
          title: 'สีปุ่มไม่ตรงแบบ',
          severity: 'minor',
          reported_on: '2026-10-07',
        },
        crew,
        now,
      );
      expect(told).toEqual([`${outsider}:U-1`]);
      expect(added.blocking).toEqual(['U-1']);
      const [blocker, minor] = added.findings;
      expect((await uat.state(projectId)).blocking).toEqual(['U-1']);

      // a blocker cannot be deferred; only the manager defers the rest
      await expect(
        uat.move(
          projectId,
          blocker.id,
          'defer',
          { note: 'ทีหลัง' },
          managerNow,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        uat.move(projectId, minor.id, 'defer', { note: 'เฟส 2' }, crew, now),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await uat.move(
        projectId,
        minor.id,
        'defer',
        { note: 'เฟส 2' },
        managerNow,
        now,
      );

      // fixed, turned down, fixed again, then confirmed by the customer
      await expect(
        uat.move(projectId, blocker.id, 'fix', {}, crew, now),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await uat.move(
        projectId,
        blocker.id,
        'fix',
        { note: 'แก้ไดรเวอร์เครื่องพิมพ์' },
        crew,
        now,
      );
      expect((await uat.state(projectId)).blocking).toEqual(['U-1']);
      const reopened = await uat.move(
        projectId,
        blocker.id,
        'reopen',
        { note: 'ยังพิมพ์ภาษาไทยไม่ได้' },
        crew,
        now,
      );
      expect(reopened.findings[0]).toMatchObject({
        status: 'open',
        reopenNote: 'ยังพิมพ์ภาษาไทยไม่ได้',
      });
      await uat.move(
        projectId,
        blocker.id,
        'fix',
        { note: 'ติดตั้งฟอนต์ไทย' },
        crew,
        now,
      );
      await expect(
        uat.move(
          projectId,
          blocker.id,
          'confirm',
          { confirmed_by: 'คุณสมชาย', confirmed_on: '2026-10-09' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const confirmed = await uat.move(
        projectId,
        blocker.id,
        'confirm',
        { confirmed_by: 'คุณสมชาย', confirmed_on: '2026-10-08' },
        crew,
        now,
      );
      expect(confirmed).toMatchObject({
        blocking: [],
        confirmed: 1,
        deferred: 1,
      });
      expect(confirmed.findings[0]).toMatchObject({
        status: 'confirmed',
        confirmedByName: 'คุณสมชาย',
        confirmedOn: '2026-10-08',
      });
      // a confirmed point is no longer open to edits
      await expect(
        uat.update(projectId, blocker.id, { title: 'อื่น' }, crew, now),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('CD-225: the readiness check — the company checklist, named inspectors, and the checks the system makes', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const tests = new TestsService(
        projects,
        new ProjectRepository(client),
        new ProjectChangeRequestRepository(client),
        new ProjectTestItemRepository(client),
        new ProjectTestRunRepository(client),
        new CompanyMemberRepository(client),
        {} as never,
        {} as never,
        audit,
        transactions,
        {
          options: () => Promise.resolve([]),
          sync: () => Promise.resolve(),
          syncSow: () => Promise.resolve(),
          assertTask: () => Promise.resolve(),
        } as never,
      );
      const named: string[] = [];
      const ready = new ReadinessService(
        projects,
        new ProjectReadinessItemRepository(client),
        new ProjectIssueRepository(client),
        tests,
        new AsBuiltService(
          projects,
          new ProjectRepository(client),
          new ProjectAsBuiltDocumentRepository(client),
          new ProjectAsBuiltDeviationRepository(client),
          new ProjectInstallationRepository(client),
          new ProjectDesignRepository(client),
          new ProjectChangeRequestRepository(client),
          {
            findFirst: () =>
              Promise.resolve({ projectAsBuiltDocuments: ['แบบติดตั้งจริง'] }),
          } as never,
          new CompanyMemberRepository(client),
          {} as never,
          audit,
          transactions,
        ),
        new UatService(
          projects,
          new ProjectUatFindingRepository(client),
          new ProjectTestItemRepository(client),
          new CompanyMemberRepository(client),
          {} as never,
          audit,
          transactions,
        ),
        {
          findFirst: () =>
            Promise.resolve({
              projectReadinessChecklist: ['หน้างานสะอาด', ' ', 'อบรมผู้ใช้'],
            }),
        } as never,
        new CompanyMemberRepository(client),
        {
          readinessAssigned: (
            userId: string,
            _c: string,
            _p: unknown,
            line: string,
          ) => {
            named.push(`${userId}:${line}`);
            return Promise.resolve();
          },
        } as never,
        audit,
        transactions,
        { state: () => Promise.resolve(null) } as never,
        { forProject: () => Promise.resolve(null) } as never,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');

      expect((await ready.view(projectId, crew)).started).toBe(false);
      await expect(ready.start(projectId, crew)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      const started = await ready.start(projectId, managerNow);
      expect(started.lines.map((line) => line.text)).toEqual([
        'หน้างานสะอาด',
        'อบรมผู้ใช้',
      ]);
      await expect(ready.start(projectId, managerNow)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      const [clean, training] = started.lines;

      // the manager names an inspector, who is told and may then check it
      await ready.update(
        projectId,
        clean.id,
        { inspector_user_id: outsider },
        managerNow,
      );
      expect(named).toEqual([`${outsider}:หน้างานสะอาด`]);
      await expect(
        ready.check(
          projectId,
          training.id,
          { result: 'pass', checked_on: '2026-10-08' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        ready.check(
          projectId,
          clean.id,
          { result: 'pass', checked_on: '2026-10-09' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await ready.check(
        projectId,
        clean.id,
        { result: 'pass', checked_on: '2026-10-08' },
        crew,
        now,
      );

      // a fail says why; rewording a line means it is checked again
      await expect(
        ready.check(
          projectId,
          training.id,
          { result: 'fail', checked_on: '2026-10-08' },
          managerNow,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const failed = await ready.check(
        projectId,
        training.id,
        { result: 'fail', checked_on: '2026-10-08', note: 'ลูกค้ายังไม่ว่าง' },
        managerNow,
        now,
      );
      expect(failed.readiness.ready).toBe(false);
      expect(failed.readiness.blockers).toContain('ไม่ผ่าน: อบรมผู้ใช้');
      const reworded = await ready.update(
        projectId,
        training.id,
        { text: 'อบรมผู้ใช้งาน 2 รอบ' },
        managerNow,
      );
      expect(
        reworded.lines.find((line) => line.id === training.id),
      ).toMatchObject({ result: null, checkedOn: null });
      await ready.check(
        projectId,
        training.id,
        { result: 'pass', checked_on: '2026-10-08' },
        managerNow,
        now,
      );

      // a line added and removed again leaves no trace on the result
      const added = await ready.add(
        projectId,
        { text: 'ส่งรหัสผ่านให้ลูกค้า' },
        managerNow,
      );
      const extra = added.lines.find(
        (line) => line.text === 'ส่งรหัสผ่านให้ลูกค้า',
      )!;
      await ready.remove(projectId, extra.id, managerNow);

      // the system's own checks: tests passed (CD-221), and no issue open
      await prisma.projectIssue.updateMany({
        where: { projectId, status: 'open' },
        data: { status: 'resolved', resolution: 'ทดสอบ' },
      });
      const state = await ready.state(projectId, companyId);
      expect(state.checks.every((check) => check.ok)).toBe(true);
      expect(state.readiness).toMatchObject({
        ready: true,
        passed: 2,
        total: 2,
        blockers: [],
      });
    });

    it('CD-189: acceptance — booked once ready, the result with the signed certificate, open points followed, the milestone achieved', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const tests = new TestsService(
        projects,
        new ProjectRepository(client),
        new ProjectChangeRequestRepository(client),
        new ProjectTestItemRepository(client),
        new ProjectTestRunRepository(client),
        new CompanyMemberRepository(client),
        {} as never,
        {} as never,
        audit,
        transactions,
        {
          options: () => Promise.resolve([]),
          sync: () => Promise.resolve(),
          syncSow: () => Promise.resolve(),
          assertTask: () => Promise.resolve(),
        } as never,
      );
      const readiness = new ReadinessService(
        projects,
        new ProjectReadinessItemRepository(client),
        new ProjectIssueRepository(client),
        tests,
        new AsBuiltService(
          projects,
          new ProjectRepository(client),
          new ProjectAsBuiltDocumentRepository(client),
          new ProjectAsBuiltDeviationRepository(client),
          new ProjectInstallationRepository(client),
          new ProjectDesignRepository(client),
          new ProjectChangeRequestRepository(client),
          {
            findFirst: () =>
              Promise.resolve({ projectAsBuiltDocuments: ['แบบติดตั้งจริง'] }),
          } as never,
          new CompanyMemberRepository(client),
          {} as never,
          audit,
          transactions,
        ),
        new UatService(
          projects,
          new ProjectUatFindingRepository(client),
          new ProjectTestItemRepository(client),
          new CompanyMemberRepository(client),
          {} as never,
          audit,
          transactions,
        ),
        {} as never,
        new CompanyMemberRepository(client),
        {} as never,
        audit,
        transactions,
        { state: () => Promise.resolve(null) } as never,
        { forProject: () => Promise.resolve(null) } as never,
      );
      const files = new Map<string, Buffer>();
      const told: string[] = [];
      // CD-236 — acceptance fills the installed base for real
      const assetsService = new ServiceAssetsService(
        new ServiceAssetRepository(client),
        new ServiceAssetHistoryRepository(client),
        new ProjectRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectEnvironmentRepository(client),
        new ProjectDeploymentRepository(client),
        new CustomerRepository(client),
        new CompanyMemberRepository(client),
        { record: () => Promise.resolve() } as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
        new EntitlementsService(
          new ServiceEntitlementRepository(client),
          new ServiceEntitlementAssetRepository(client),
          new ServiceAssetRepository(client),
          new CustomerContractRepository(client),
          new ContractTermsRepository(client),
          new CustomerRepository(client),
          { record: () => Promise.resolve() } as never,
          {
            execute: (work: (tx: unknown) => Promise<unknown>) =>
              prisma.$transaction((tx) => work(tx)),
          } as never,
        ),
      );
      const acceptance = new AcceptanceService(
        projects,
        readiness,
        milestones,
        new ProjectMilestoneRepository(client),
        new ProjectAcceptanceRepository(client),
        new ProjectAcceptanceItemRepository(client),
        new CompanyMemberRepository(client),
        {
          acceptanceItemAssigned: (
            userId: string,
            _c: string,
            _p: unknown,
            round: string,
          ) => {
            told.push(`${userId}:${round}`);
            return Promise.resolve();
          },
        } as never,
        {
          put: (key: string, body: Buffer) => {
            files.set(key, body);
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
          get: (key: string) =>
            Promise.resolve(Readable.from([files.get(key)!])),
        },
        audit,
        transactions,
        assetsService,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const now = new Date('2026-10-08T03:00:00Z');
      const later = new Date('2026-10-12T03:00:00Z');
      const signed = {
        originalname: 'certificate.pdf',
        mimetype: 'application/pdf',
        size: 4,
        buffer: Buffer.from('%PDF'),
      };
      // a milestone the customer will accept, one criterion not yet ticked
      const last = await prisma.projectMilestone.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const accepted = await prisma.projectMilestone.create({
        data: {
          companyId,
          projectId,
          seq: (last?.seq ?? 0) + 1,
          title: 'ตรวจรับระบบกล้อง',
          criteria: [{ text: 'ลูกค้าลงนามใบตรวจรับ', met: false }],
          createdBy: engineer,
        },
        select: { id: true },
      });

      // not ready, not booked
      const blocker = await prisma.projectIssue.create({
        data: {
          companyId,
          projectId,
          seq: 950,
          title: 'ค้างก่อนตรวจรับ',
          ownerUserId: engineer,
          dueOn: new Date('2026-10-20T00:00:00Z'),
          createdBy: engineer,
        },
        select: { id: true },
      });
      const notReady = acceptance.book(
        projectId,
        { milestone_id: accepted.id, scheduled_at: '2026-10-10T02:00:00Z' },
        managerNow,
        now,
      );
      await expect(notReady).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
      await expect(notReady).rejects.toThrow('ตรวจความพร้อมยังไม่ผ่าน');
      await prisma.projectIssue.update({
        where: { id: blocker.id },
        data: { status: 'resolved', resolution: 'ทดสอบ' },
      });

      // ready: only the manager books, in the future, once per milestone
      await expect(
        acceptance.book(
          projectId,
          { milestone_id: accepted.id, scheduled_at: '2026-10-10T02:00:00Z' },
          crew,
          now,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        acceptance.book(
          projectId,
          { milestone_id: accepted.id, scheduled_at: '2026-10-01T02:00:00Z' },
          managerNow,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const booked = await acceptance.book(
        projectId,
        {
          milestone_id: accepted.id,
          scheduled_at: '2026-10-10T02:00:00Z',
          location: 'อาคาร A ชั้น 3',
          customer_people: 'คุณสมชาย ฝ่ายอาคาร',
          preparation: 'ผลทดสอบ, แบบติดตั้งจริง',
        },
        managerNow,
        now,
      );
      expect(booked.readiness.ready).toBe(true);
      const round = booked.rounds[0];
      expect(round).toMatchObject({ label: 'A-1', status: 'scheduled' });
      await expect(
        acceptance.book(
          projectId,
          { milestone_id: accepted.id, scheduled_at: '2026-10-11T02:00:00Z' },
          managerNow,
          now,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // accepted with conditions: the certificate, and each open point dated
      await expect(
        acceptance.record(
          projectId,
          round.id,
          { result: 'accepted', decided_on: '2026-10-10' },
          undefined,
          managerNow,
          later,
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const recorded = await acceptance.record(
        projectId,
        round.id,
        {
          result: 'conditional',
          decided_on: '2026-10-10',
          note: 'รับมอบ ยกเว้นป้ายชื่อห้อง',
          items: JSON.stringify([
            {
              text: 'ติดป้ายชื่อห้อง',
              due_on: '2026-10-20',
              owner_user_id: outsider,
            },
          ]),
        },
        signed,
        managerNow,
        later,
      );
      const done = recorded.rounds.find((row) => row.id === round.id)!;
      expect(done).toMatchObject({
        status: 'conditional',
        certificateName: 'certificate.pdf',
        followUp: { open: 1, closed: false },
      });
      expect(told).toEqual([`${outsider}:A-1`]);
      // the milestone is achieved, every criterion met, the certificate its evidence
      const milestone = await prisma.projectMilestone.findUniqueOrThrow({
        where: { id: accepted.id },
      });
      expect(milestone).toMatchObject({
        status: 'achieved',
        evidenceName: 'certificate.pdf',
      });
      expect(milestone.achievedOn?.toISOString().slice(0, 10)).toBe(
        '2026-10-10',
      );
      expect(
        (milestone.criteria as { met: boolean }[]).every((c) => c.met),
      ).toBe(true);
      await expect(
        acceptance.record(
          projectId,
          round.id,
          { result: 'accepted', decided_on: '2026-10-10' },
          signed,
          managerNow,
          later,
        ),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // the open point is closed by its owner, saying how
      const item = done.items[0];
      await expect(
        acceptance.closeItem(projectId, round.id, item.id, {}, crew, later),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const closed = await acceptance.closeItem(
        projectId,
        round.id,
        item.id,
        { note: 'ติดป้ายครบ 12 ห้อง' },
        crew,
        later,
      );
      expect(
        closed.rounds.find((row) => row.id === round.id)?.followUp,
      ).toMatchObject({ open: 0, closed: true });
      expect(
        (await acceptance.certificate(projectId, round.id, crew)).fileName,
      ).toBe('certificate.pdf');

      // a rejected round says why, and needs no certificate
      const second = await acceptance.book(
        projectId,
        { scheduled_at: '2026-10-15T02:00:00Z' },
        managerNow,
        later,
      );
      const r2 = second.rounds.find((row) => row.label === 'A-2')!;
      const rejected = await acceptance.record(
        projectId,
        r2.id,
        {
          result: 'rejected',
          decided_on: '2026-10-12',
          note: 'ระบบสำรองไฟยังไม่พร้อม',
        },
        undefined,
        managerNow,
        later,
      );
      expect(rejected.rounds.find((row) => row.id === r2.id)?.status).toBe(
        'rejected',
      );
    });

    it('CD-236: the installed base — made at acceptance from installed points and production software, entered by hand and from a file, searched by serial', async () => {
      const client = prisma as never;
      const assetsService = new ServiceAssetsService(
        new ServiceAssetRepository(client),
        new ServiceAssetHistoryRepository(client),
        new ProjectRepository(client),
        new ProjectInstallationRepository(client),
        new ProjectEnvironmentRepository(client),
        new ProjectDeploymentRepository(client),
        new CustomerRepository(client),
        new CompanyMemberRepository(client),
        { record: () => Promise.resolve() } as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
        new EntitlementsService(
          new ServiceEntitlementRepository(client),
          new ServiceEntitlementAssetRepository(client),
          new ServiceAssetRepository(client),
          new CustomerContractRepository(client),
          new ContractTermsRepository(client),
          new CustomerRepository(client),
          { record: () => Promise.resolve() } as never,
          {
            execute: (work: (tx: unknown) => Promise<unknown>) =>
              prisma.$transaction((tx) => work(tx)),
          } as never,
        ),
      );
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { companyId: true, customerId: true },
      });
      const companyId = project.companyId;
      const reader = {
        ...as(randomUUID(), ['service.asset.read', 'service.asset.manage']),
        activeCompanyId: companyId,
      };
      // the acceptance (CD-189) put in what was installed and production
      const fromProject = await prisma.serviceAsset.findMany({
        where: { projectId },
        orderBy: { createdAt: 'asc' },
      });
      const installed = await prisma.projectInstallation.count({
        where: { projectId, deletedAt: null, installedOn: { not: null } },
      });
      const production = await prisma.projectEnvironment.count({
        where: { projectId, deletedAt: null, kind: 'production' },
      });
      expect(fromProject).toHaveLength(installed + production);
      expect(
        fromProject.every((row) => row.source === 'project' && row.acceptedOn),
      ).toBe(true);
      // once each: another round adds nothing
      expect(
        await assetsService.registerFromAcceptance({
          projectId,
          companyId,
          acceptedOn: '2026-10-05',
          actorId: engineer,
          label: 'A-9',
        }),
      ).toEqual([]);

      const tag = randomUUID().slice(0, 6).toUpperCase();
      const customer = await prisma.customer.create({
        data: {
          companyId,
          customerCode: `CUS-T236-${tag}`,
          nameTh: `ทดสอบทะเบียน ${tag}`,
          normalizedName: `ทดสอบทะเบียน ${tag}`,
          status: 'active',
          type: 'corporate',
        },
      });
      try {
        // by hand: a customer is needed; the serial is kept normalised
        await expect(
          assetsService.create(reader, { kind: 'equipment', name: 'UPS 3kVA' }),
        ).rejects.toThrow('ต้องระบุลูกค้า');
        const ups = await assetsService.create(reader, {
          kind: 'equipment',
          customer_id: customer.id,
          name: 'UPS 3kVA',
          serial_no: ` ups-${tag} 01`,
          location: 'ห้อง server',
          installed_on: '2024-03-01',
        });
        expect(ups.serialNo).toBe(`UPS-${tag}01`);
        await expect(
          assetsService.create(reader, {
            kind: 'equipment',
            customer_id: customer.id,
            name: 'อีกเครื่อง',
            serial_no: `ups-${tag}01`,
          }),
        ).rejects.toThrow('มีในทะเบียนแล้ว');

        // the old base from a file: checked, then written
        const rows = [
          {
            row_no: 2,
            customer_code: customer.customerCode,
            name: 'สวิตช์',
            serial_no: `SW-${tag}`,
            model: 'C9200',
          },
          { row_no: 3, customer_code: 'CUS-NOPE', name: 'x' },
          {
            row_no: 4,
            customer_code: customer.customerCode,
            name: 'ซ้ำ',
            serial_no: `ups-${tag}01`,
          },
          {
            row_no: 5,
            customer_code: customer.customerCode,
            kind: 'software',
            name: 'ระบบบัญชี',
            version: '3.2',
          },
        ];
        const dry = await assetsService.import(reader, {
          mode: 'dry_run',
          import_id: `imp-${tag}`,
          rows,
        });
        expect(dry.summary).toEqual({ create: 2, skip: 1, error: 1 });
        expect(
          await prisma.serviceAsset.count({
            where: { customerId: customer.id },
          }),
        ).toBe(1);
        const done = await assetsService.import(reader, {
          mode: 'commit',
          import_id: `imp-${tag}`,
          rows,
        });
        expect(done.summary).toEqual({ create: 2, skip: 1, error: 1 });

        // a call comes in: found by serial, or by the customer
        let found = await assetsService.list(reader, { q: `sw-${tag}` });
        expect(found.items.map((row) => row.name)).toEqual(['สวิตช์']);
        found = await assetsService.list(reader, { customer_id: customer.id });
        expect(found.items).toHaveLength(3);

        // corrected with a reason; replaced, and out of the active list
        await expect(
          assetsService.update(reader, ups.id, { location: 'ชั้น 2' }),
        ).rejects.toThrow('ต้องระบุเหตุผลที่แก้');
        await assetsService.update(reader, ups.id, {
          location: 'ชั้น 2',
          reason: 'ย้ายห้อง',
        });
        const replaced = await assetsService.setStatus(reader, ups.id, {
          status: 'replaced',
          reason: 'เปลี่ยนเครื่องใหม่จากเคลม',
        });
        expect(replaced.history.map((row) => row.action)).toEqual([
          'status',
          'updated',
          'created',
        ]);
        found = await assetsService.list(reader, { customer_id: customer.id });
        expect(found.items).toHaveLength(2);
        found = await assetsService.list(reader, {
          customer_id: customer.id,
          status: 'all',
        });
        expect(found.items).toHaveLength(3);
      } finally {
        await prisma.serviceAssetHistory.deleteMany({
          where: { asset: { customerId: customer.id } },
        });
        await prisma.serviceAsset.deleteMany({
          where: { customerId: customer.id },
        });
        await prisma.customer.delete({ where: { id: customer.id } });
      }
    });

    it('CD-237: entitlements — a warranty from the acceptance date and the contract terms, a service contract set from the register, the strongest cover answering for an asset', async () => {
      const client = prisma as never;
      const tx = {
        execute: (work: (t: unknown) => Promise<unknown>) =>
          prisma.$transaction((t) => work(t)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const entitlements = new EntitlementsService(
        new ServiceEntitlementRepository(client),
        new ServiceEntitlementAssetRepository(client),
        new ServiceAssetRepository(client),
        new CustomerContractRepository(client),
        new ContractTermsRepository(client),
        new CustomerRepository(client),
        audit,
        tx,
      );
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { companyId: true, customerId: true, contractId: true },
      });
      const companyId = project.companyId;
      const reader = {
        ...as(randomUUID(), ['service.asset.read', 'service.asset.manage']),
        activeCompanyId: companyId,
      };
      const tag = randomUUID().slice(0, 6).toUpperCase();
      const customer = await prisma.customer.create({
        data: {
          companyId,
          customerCode: `CUS-T237-${tag}`,
          nameTh: `ทดสอบสิทธิ์ ${tag}`,
          normalizedName: `ทดสอบสิทธิ์ ${tag}`,
          status: 'active',
          type: 'corporate',
        },
      });
      const assets = await Promise.all(
        ['A', 'B'].map((suffix) =>
          prisma.serviceAsset.create({
            data: {
              companyId,
              customerId: customer.id,
              kind: 'equipment',
              source: 'manual',
              name: `เครื่อง ${suffix}`,
              serialNo: `T237-${tag}-${suffix}`,
              createdBy: engineer,
            },
          }),
        ),
      );
      const contract = await prisma.customerContract.findUniqueOrThrow({
        where: { id: project.contractId },
        select: { id: true, customerId: true },
      });
      const termsBefore = await prisma.contractTerms.findUnique({
        where: { contractId: contract.id },
      });
      const levels = {
        critical: { responseHours: 1, resolutionHours: 4 },
        high: { responseHours: 2, resolutionHours: 8 },
        medium: { responseHours: 4, resolutionHours: 24 },
        low: { responseHours: 8, resolutionHours: 72 },
      };
      await prisma.contractTerms.upsert({
        where: { contractId: contract.id },
        create: {
          contractId: contract.id,
          companyId,
          warrantyMonths: 12,
          serviceCoverage: 'H8X5',
          serviceLevels: levels,
        },
        update: {
          warrantyMonths: 12,
          serviceCoverage: 'H8X5',
          serviceLevels: levels,
        },
      });
      // the contract is the project's; for this test its warranty covers the
      // test customer's assets
      await prisma.customerContract.update({
        where: { id: contract.id },
        data: { customerId: customer.id },
      });
      try {
        // the warranty an acceptance makes: from its date, the contract's level
        const warrantyId = await entitlements.warrantyFromAcceptance({
          companyId,
          projectId,
          customerId: customer.id,
          contractId: contract.id,
          acceptedOn: '2026-10-05',
          label: 'A-1',
          assetIds: assets.map((a) => a.id),
          actorId: engineer,
        });
        let detail = await entitlements.detail(reader, warrantyId!);
        expect(detail).toMatchObject({
          kind: 'warranty',
          startOn: '2026-10-05',
          endOn: '2027-10-04',
          coverage: 'H8X5',
          state: 'active',
        });
        expect(detail.severityTargets?.critical).toEqual({
          responseHours: 1,
          resolutionHours: 4,
        });
        expect(detail.assets).toHaveLength(2);

        // a service contract from the register: defaults, then 24x7 on A only
        const defaults = await entitlements.contractDefaults(
          reader,
          contract.id,
        );
        expect(defaults).toMatchObject({
          customerId: customer.id,
          coverage: 'H8X5',
        });
        await expect(
          entitlements.create(reader, {
            kind: 'service_contract',
            customer_id: customer.id,
            title: 'MA',
            start_on: '2026-12-01',
            end_on: '2026-11-01',
          }),
        ).rejects.toThrow('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
        const ma = await entitlements.create(reader, {
          kind: 'service_contract',
          customer_id: customer.id,
          contract_id: contract.id,
          title: 'MA 24x7',
          start_on: '2026-12-01',
          end_on: '2027-11-30',
          coverage: 'H24X7',
          corrective_quota: null,
          preventive_quota: 4,
          asset_ids: [assets[0].id],
        });
        expect(ma).toMatchObject({ preventiveLeft: 4, correctiveLeft: null });

        // what answers for A: the warranty now, the 24x7 contract once it runs
        expect(
          (
            await entitlements.coverageOf(companyId, assets[0].id, '2026-11-15')
          ).map((row) => row.title),
        ).toEqual([detail.title]);
        expect(
          (
            await entitlements.coverageOf(companyId, assets[0].id, '2027-01-10')
          )[0],
        ).toMatchObject({ id: ma.id, coverage: 'H24X7' });
        expect(
          (
            await entitlements.coverageOf(companyId, assets[1].id, '2027-01-10')
          )[0].id,
        ).toBe(warrantyId);
        expect(
          await entitlements.coverageOf(companyId, assets[1].id, '2027-12-01'),
        ).toEqual([]);

        // changed with a reason: the contract moves to B; then withdrawn
        await expect(
          entitlements.update(reader, ma.id, { asset_ids: [assets[1].id] }),
        ).rejects.toThrow('ต้องระบุเหตุผลที่แก้');
        detail = await entitlements.update(reader, ma.id, {
          asset_ids: [assets[1].id],
          reason: 'ลูกค้าย้ายสัญญาไปเครื่อง B',
        });
        expect(detail.assets.map((a) => a.id)).toEqual([assets[1].id]);
        // only the customer's own assets
        await expect(
          entitlements.update(reader, ma.id, {
            asset_ids: [randomUUID()],
            reason: 'x',
          }),
        ).rejects.toThrow('มีอุปกรณ์ที่ไม่ใช่ของลูกค้ารายนี้');
        detail = await entitlements.cancel(reader, ma.id, {
          reason: 'ลูกค้ายกเลิก MA',
        });
        expect(detail.state).toBe('cancelled');
        const listed = await entitlements.list(reader, {
          customer_id: customer.id,
          state: 'all',
        });
        expect(
          listed.map((row) => [row.kind, row.state, row.assetCount]),
        ).toEqual([
          ['warranty', expect.any(String), 2],
          ['service_contract', 'cancelled', 1],
        ]);
      } finally {
        await prisma.customerContract.update({
          where: { id: contract.id },
          data: { customerId: contract.customerId },
        });
        if (termsBefore) {
          await prisma.contractTerms.update({
            where: { contractId: contract.id },
            data: {
              warrantyMonths: termsBefore.warrantyMonths,
              serviceCoverage: termsBefore.serviceCoverage,
              serviceLevels: termsBefore.serviceLevels ?? Prisma.JsonNull,
            },
          });
        } else {
          await prisma.contractTerms.delete({
            where: { contractId: contract.id },
          });
        }
        await prisma.serviceEntitlementAsset.deleteMany({
          where: { asset: { customerId: customer.id } },
        });
        await prisma.serviceEntitlement.deleteMany({
          where: { customerId: customer.id },
        });
        await prisma.serviceAsset.deleteMany({
          where: { customerId: customer.id },
        });
        await prisma.customer.delete({ where: { id: customer.id } });
      }
    });
    it('CD-192: health from the project figures; the weekly draft, refreshed until submitted; the portfolio puts risk first', async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        { milestoneSlipped: () => Promise.resolve() } as never,
        audit,
        transactions,
      );
      const progress = new ProgressService(
        projects,
        plan,
        new ProjectMilestoneRepository(client),
        new ProjectProgressRepository(client),
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const payments = new PaymentsService(
        projects,
        plan,
        new ProjectRepository(client),
        new ContractInstallmentRepository(client),
        new InstallmentBillingRepository(client),
        audit,
        transactions,
      );
      const due: string[] = [];
      const reports = new StatusReportsService(
        projects,
        plan,
        progress,
        payments,
        new ProjectStatusReportRepository(client),
        new ProjectRiskRepository(client),
        new ProjectIssueRepository(client),
        new ProjectBudgetRepository(client),
        {
          findFirst: () =>
            Promise.resolve({ projectHealthAmber: 20, projectHealthRed: 40 }),
        } as never,
        new CompanyMemberRepository(client),
        {
          statusReportDue: (userId: string) => {
            due.push(userId);
            return Promise.resolve();
          },
        } as never,
        { get: () => 0 } as never,
        audit,
        transactions,
        new ProjectIntakeRepository(client),
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const executive = as(pm, ['notification.read', 'pm.project.read']);
      const monday = new Date('2026-10-05T02:00:00Z');
      const tuesday = new Date('2026-10-06T02:00:00Z');

      // the live health reads what the earlier steps left behind
      const live = await reports.list(projectId, crew, monday);
      expect(live.canEdit).toBe(false);
      expect(live.thisWeek).toBe('2026-10-05');
      expect(['green', 'amber', 'red']).toContain(live.live.health.level);
      expect(live.live.health.score).toBe(
        live.live.health.factors.reduce((sum, f) => sum + f.points, 0),
      );

      // CD-68 — the customer's 360° projects tab: the same health, and the
      // work's receipt; someone outside the project sees none of it
      const customerOf = randomUUID();
      const before = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { customerId: true },
      });
      await prisma.project.update({
        where: { id: projectId },
        data: { customerId: customerOf },
      });
      try {
        const tab = await reports.ofCustomer(customerOf, crew, monday);
        expect(tab.map((item) => item.id)).toEqual([projectId]);
        expect(tab[0].health?.score).toBe(live.live.health.score);
        expect(tab[0].intakeStatus).toBe('accepted');
        const stranger = as(randomUUID(), ['notification.read']);
        await expect(
          reports.ofCustomer(customerOf, stranger, monday),
        ).resolves.toEqual([]);
      } finally {
        await prisma.project.update({
          where: { id: projectId },
          data: { customerId: before.customerId },
        });
      }

      // Monday's sweep drafts the week for the manager, once
      await reports.sweep(monday);
      await reports.sweep(monday);
      expect(due.filter((id) => id === engineer)).toHaveLength(1);
      const drafted = await prisma.projectStatusReport.findMany({
        where: { projectId },
      });
      expect(drafted).toHaveLength(1);
      expect(drafted[0]).toMatchObject({ status: 'draft' });
      // a day later its figures are brought up to date
      await reports.sweep(tuesday);
      const refreshed = await prisma.projectStatusReport.findFirstOrThrow({
        where: { projectId },
      });
      expect(refreshed.snapshotAt.toISOString()).toBe(tuesday.toISOString());

      // only the manager writes it; it needs the week's work and the next
      const reportId = refreshed.id;
      await expect(
        reports.update(projectId, reportId, { accomplished: 'x' }, crew),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        reports.submit(projectId, reportId, managerNow, tuesday),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await reports.update(
        projectId,
        reportId,
        {
          accomplished: 'ติดตั้งกล้องชั้น 1 เสร็จ',
          next_steps: 'ทดสอบระบบร่วมกับลูกค้า',
          help_needed: '',
        },
        managerNow,
        tuesday,
      );
      const sent = await reports.submit(
        projectId,
        reportId,
        managerNow,
        tuesday,
      );
      expect(sent.reports[0]).toMatchObject({
        status: 'submitted',
        accomplished: 'ติดตั้งกล้องชั้น 1 เสร็จ',
        helpNeeded: null,
      });
      // frozen: no more edits, and the sweep leaves it alone
      await expect(
        reports.update(projectId, reportId, { next_steps: 'y' }, managerNow),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        reports.draft(projectId, managerNow, tuesday),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await reports.sweep(new Date('2026-10-07T02:00:00Z'));
      const kept = await prisma.projectStatusReport.findFirstOrThrow({
        where: { id: reportId },
      });
      expect(kept.snapshotAt.toISOString()).toBe(tuesday.toISOString());

      // the portfolio: whoever reads every project sees this one, reported
      const board = await reports.portfolio(executive, tuesday);
      const row = board.projects.find((item) => item.id === projectId);
      expect(row).toMatchObject({ reportStatus: 'submitted' });
      expect(board.counts.red + board.counts.amber + board.counts.green).toBe(
        board.projects.length,
      );
    });

    it("CD-191: a project closes only with nothing owed, its documents and a lesson — then on the executives' approval", async () => {
      const client = prisma as never;
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const plan = new PlanService(
        projects,
        new ProjectRepository(client),
        new ProjectTaskRepository(client),
        new ProjectTaskLinkRepository(client),
        new ProjectMilestoneRepository(client),
        new WorkCalendarRepository(client),
        new CompanyMemberRepository(client),
        { milestoneSlipped: () => Promise.resolve() } as never,
        audit,
        transactions,
      );
      const payments = new PaymentsService(
        projects,
        plan,
        new ProjectRepository(client),
        new ContractInstallmentRepository(client),
        new InstallmentBillingRepository(client),
        audit,
        transactions,
      );
      const logs = new CustomerLogsService(
        projects,
        new ProjectCustomerLogRepository(client),
        {} as never,
        new CompanyMemberRepository(client),
        audit,
        transactions,
      );
      const files = new Map<string, Buffer>();
      const asked: unknown[] = [];
      let requestStatus = 'pending_approval';
      const decided: boolean[] = [];
      const closeout = new CloseoutService(
        projects,
        new ProjectRepository(client),
        new ProjectCloseoutRepository(client),
        new ProjectCloseDocumentRepository(client),
        new ProjectLessonRepository(client),
        new ProjectMilestoneRepository(client),
        new ProjectTaskRepository(client),
        new ProjectIssueRepository(client),
        new ProjectChangeRequestRepository(client),
        new ProjectRiskRepository(client),
        new ContractObligationRepository(client),
        logs,
        payments,
        {
          findFirst: () =>
            Promise.resolve({
              projectCloseTypeCode: 'PCL',
              projectCloseDocuments: ['ใบตรวจรับงาน', 'เอกสารส่งมอบงาน'],
            }),
        } as never,
        {
          findFirst: () =>
            Promise.resolve({ status: requestStatus, requestNo: 'PCL-0001' }),
        } as never,
        {
          create: (input: unknown) => {
            asked.push(input);
            return Promise.resolve({ id: `req-${tag}` });
          },
          submit: () => Promise.resolve(),
        } as never,
        new CompanyMemberRepository(client),
        {
          closeDecided: (
            _user: string,
            _company: string,
            _project: unknown,
            approved: boolean,
          ) => {
            decided.push(approved);
            return Promise.resolve();
          },
        } as never,
        { on: () => undefined } as never,
        {
          put: (key: string, body: Buffer) => {
            files.set(key, body);
            return Promise.resolve();
          },
          remove: () => Promise.resolve(),
          get: (key: string) =>
            Promise.resolve(Readable.from([files.get(key)!])),
        },
        audit,
        transactions,
      );
      const managerNow = as(engineer, ['notification.read']);
      const crew = as(outsider, ['notification.read']);
      const pdf = (name: string) => ({
        originalname: name,
        mimetype: 'application/pdf',
        size: 4,
        buffer: Buffer.from('%PDF'),
      });

      // what the earlier steps left open stops it
      const before = await closeout.view(projectId, crew);
      expect(before.canEdit).toBe(false);
      expect(before.canWrite).toBe(true);
      const failed = before.checks
        .filter((check) => check.blocking && !check.ok)
        .map((check) => check.key);
      expect(failed).toEqual(
        expect.arrayContaining(['changes', 'documents', 'lessons']),
      );
      await expect(
        closeout.submit(projectId, managerNow, 'Bearer x'),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      // the team writes lessons; only the manager attaches documents
      const lessoned = await closeout.addLesson(
        projectId,
        { kind: 'improve', text: 'นัดเข้าพื้นที่ล่วงหน้าอย่างน้อย 2 สัปดาห์' },
        crew,
      );
      expect(lessoned.lessons).toHaveLength(1);
      expect(lessoned.lessons[0]).toMatchObject({ kbmsStatus: 'pending' });
      await expect(
        closeout.addLesson(projectId, { kind: 'nope', text: 'x' }, crew),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        closeout.attach(
          projectId,
          { title: 'ใบตรวจรับงาน' },
          pdf('a.pdf'),
          crew,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await closeout.attach(
        projectId,
        { title: 'ใบตรวจรับงาน' },
        pdf('acceptance.pdf'),
        managerNow,
      );
      const attached = await closeout.attach(
        projectId,
        { title: 'เอกสารส่งมอบงาน' },
        pdf('handover.pdf'),
        managerNow,
      );
      expect(attached.required.every((row) => row.documentIds.length)).toBe(
        true,
      );

      // everything owed settled the way the other cards would
      await prisma.projectChangeRequest.updateMany({
        where: { projectId, status: { in: ['draft', 'submitted'] } },
        data: { status: 'cancelled' },
      });
      await prisma.projectIssue.updateMany({
        where: { projectId, status: 'open' },
        data: { status: 'resolved', resolution: 'ทดสอบ' },
      });
      await prisma.projectMilestone.updateMany({
        where: { projectId, status: 'planned' },
        data: { status: 'cancelled' },
      });
      await prisma.contractObligation.updateMany({
        where: { contractId, status: 'open' },
        data: { status: 'done' },
      });
      const ready = await closeout.view(projectId, managerNow);
      expect(ready.problems).toEqual([]);

      const sent = await closeout.submit(projectId, managerNow, 'Bearer x');
      expect(sent.closeout).toMatchObject({
        status: 'submitted',
        requestNo: 'PCL-0001',
      });
      expect(asked[0]).toMatchObject({
        type_code: 'PCL',
        form_data: { lessons: 1 },
      });
      // locked while with the executives
      await expect(
        closeout.addLesson(projectId, { kind: 'went_well', text: 'x' }, crew),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // turned down: back to be fixed
      requestStatus = 'rejected';
      await closeout.syncRequest(`req-${tag}`);
      expect(
        (await prisma.project.findUniqueOrThrow({ where: { id: projectId } }))
          .status,
      ).not.toBe('closed');
      // asked again: a new request, waiting
      requestStatus = 'pending_approval';
      await closeout.submit(projectId, managerNow, 'Bearer x');

      // approved: the project is closed, once
      requestStatus = 'approved';
      await closeout.syncRequest(`req-${tag}`);
      await closeout.syncRequest(`req-${tag}`);
      expect(
        (await prisma.project.findUniqueOrThrow({ where: { id: projectId } }))
          .status,
      ).toBe('closed');
      expect(decided).toEqual([false, true]);
      const after = await closeout.view(projectId, managerNow);
      expect(after.closeout?.status).toBe('approved');
      expect(after.canEdit).toBe(false);
    });
  },
);
