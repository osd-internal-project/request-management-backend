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
  ProjectMemberRepository,
  ProjectRepository,
  ProjectBudgetRepository,
  ProjectChangeRequestRepository,
  ProjectProgressRepository,
  ProjectTaskFileRepository,
  ProjectTaskLinkRepository,
  ProjectTaskRepository,
  ProjectTaskUpdateRepository,
  WorkCalendarRepository,
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { MilestonesService } from './milestones.service';
import { PlanService } from './plan.service';
import { TaskWorkService } from './task-work.service';
import { ProgressService } from './progress.service';
import { BudgetService } from './budget.service';
import { ChangeRequestsService } from './change-requests.service';
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
      await prisma.projectTask.deleteMany({ where: { projectId } });
      await prisma.projectMilestone.deleteMany({ where: { projectId } });
      await prisma.projectChangeRequest.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { contractId } });
      await prisma.contractInstallment.deleteMany({ where: { contractId } });
      await prisma.contractTerms.deleteMany({ where: { contractId } });
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
  },
);
