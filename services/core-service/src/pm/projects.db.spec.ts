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
} from './project.repositories';
import { ProjectsService } from './projects.service';
import { MilestonesService } from './milestones.service';
import { ProjectMilestoneRepository } from './project.repositories';
import { ContractInstallmentsService } from '../crm/contract-installments.service';
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
      await prisma.projectMilestone.deleteMany({ where: { projectId } });
      await prisma.project.deleteMany({ where: { contractId } });
      await prisma.contractInstallment.deleteMany({ where: { contractId } });
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
      const drawn = await milestones.fromSchedule(projectId, managerNow);
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
        { criteria: ['ลูกค้าลงนามใบตรวจรับ', 'ส่งคู่มือการใช้งาน'] },
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
    });
  },
);
