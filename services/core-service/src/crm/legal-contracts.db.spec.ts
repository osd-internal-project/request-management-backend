import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Principal } from '@request-management/share';
import {
  ContractAccessRepository,
  ContractDocumentRepository,
  CustomerContractRepository,
} from './contract.repositories';
import { CustomerRepository } from './customer.repository';
import { LegalContractsService } from './legal-contracts.service';
import { ContractExpiryService } from './contract-expiry.service';
import {
  ContractObligationRepository,
  ContractObligationsService,
} from './contract-obligations.service';
import { CompanyMemberRepository } from '../access/company-member.repository';
import {
  ContractInstallmentRepository,
  ContractInstallmentsService,
} from './contract-installments.service';
import {
  ContractDraftRepository,
  ContractDraftVersionRepository,
  ContractDraftsService,
} from './contract-drafts.service';
import {
  ContractTemplateRepository,
  ContractTemplatesService,
} from './contract-templates.service';
import { RequestRepository } from '../requests/request.repository';
import {
  ContractRiskAssessmentRepository,
  ContractRiskService,
} from './contract-risk.service';

/**
 * CD-161 — the repository's search runs on relation filters (documents'
 * text, the access list) and a party CHECK the unit spec cannot see. This
 * records contracts against a real database — one with a counterparty and a
 * PDF, one confidential — searches as two people, and deletes them. Skipped
 * without a database:
 *
 *   CORE_DB_TEST_URL=postgresql://… yarn workspace \
 *     @request-management/core-service test legal-contracts.db
 */
const DB_URL = process.env.CORE_DB_TEST_URL;

(DB_URL ? describe : describe.skip)(
  'CD-161 contract repository (real Postgres)',
  () => {
    let prisma: PrismaClient;
    let service: LegalContractsService;
    let companyId: string;
    let legalUser: string;
    let otherUser: string;
    const tag = randomUUID().slice(0, 8);
    const ids: string[] = [];
    const stored = new Map<string, Buffer>();

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
      const company = await prisma.company.findFirstOrThrow({
        select: { id: true },
      });
      const users = await prisma.user.findMany({
        take: 2,
        select: { id: true },
      });
      companyId = company.id;
      legalUser = users[0].id;
      otherUser = users[1]?.id ?? `nobody-${tag}`;
      const client = prisma as never;
      service = new LegalContractsService(
        new CustomerContractRepository(client),
        new ContractDocumentRepository(client),
        new ContractAccessRepository(client),
        new CustomerRepository(client),
        { findMany: () => Promise.resolve([]) } as never,
        { record: () => Promise.resolve() } as never,
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
        {
          put: (key: string, body: Buffer) => {
            stored.set(key, body);
            return Promise.resolve();
          },
          remove: (key: string) => {
            stored.delete(key);
            return Promise.resolve();
          },
        } as never,
        { changed: () => Promise.resolve(0) } as never,
      );
    });

    afterAll(async () => {
      await prisma.contractDocument.deleteMany({
        where: { contractId: { in: ids } },
      });
      await prisma.customerContract.updateMany({
        where: { id: { in: ids } },
        data: { masterContractId: null },
      });
      await prisma.customerContract.deleteMany({ where: { id: { in: ids } } });
      await prisma.$disconnect();
    });

    const as = (userId: string, manage: boolean) =>
      ({
        userId,
        activeCompanyId: companyId,
        displayName: 'ทดสอบ',
        permissions: manage
          ? ['legal.contract.read', 'legal.contract.manage']
          : ['legal.contract.read'],
      }) as unknown as Principal;

    it('CD-161: counterparty contracts, text inside the PDF, and confidential ones hidden from the rest', async () => {
      const legal = as(legalUser, true);
      const nda = await service.create(
        {
          kind: 'nda',
          contract_no: `NDA-T161-${tag}`,
          title: 'NDA ทดสอบคลังสัญญา',
          counterparty_name: 'บริษัท คู่ค้าทดสอบ จำกัด',
          end_on: '2027-12-31',
        },
        legal,
      );
      ids.push(nda.id);
      const secret = await service.create(
        {
          contract_no: `SEC-T161-${tag}`,
          title: 'สัญญาลับทดสอบ',
          counterparty_name: 'บริษัท ลับ จำกัด',
          end_on: '2027-06-30',
        },
        legal,
      );
      ids.push(secret.id);
      await service.setAccess(
        secret.id,
        { confidential: true, user_ids: [] },
        legal,
      );

      const uploaded = await service.upload(
        nda.id,
        {
          originalname: 'nda-signed.pdf',
          mimetype: 'application/pdf',
          size: 1,
          buffer: readFileSync(
            join(__dirname, '../../test/fixtures/contract-th.pdf'),
          ),
        },
        legal,
      );
      expect(uploaded).toMatchObject({ textStatus: 'extracted' });

      // text inside the file — Thai, across a line break
      const byText = await service.list(legal, {
        text: 'ค่าปรับร้อยละ 0.1',
        search: tag,
      } as never);
      expect(byText.data.map((row) => (row as { id: string }).id)).toEqual([
        nda.id,
      ]);

      // the party's name finds it; kind narrows
      const byParty = await service.list(legal, {
        search: 'คู่ค้าทดสอบ',
        kind: 'nda',
      } as never);
      expect(
        byParty.data.some((row) => (row as { id: string }).id === nda.id),
      ).toBe(true);

      // the confidential one: legal sees it, someone else does not — not in
      // the list, and not by id
      const mine = await service.list(legal, { search: tag } as never);
      expect(mine.total).toBe(2);
      const theirs = await service.list(as(otherUser, false), {
        search: tag,
      } as never);
      expect(theirs.data.map((row) => (row as { id: string }).id)).toEqual([
        nda.id,
      ]);
      await expect(
        service.detail(secret.id, as(otherUser, false)),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // CD-149 — an MSA with the same party, a sub-contract under it; the
      // master's detail lists it, and another party cannot hang under it
      const msa = await service.create(
        {
          kind: 'msa',
          contract_no: `MSA-T161-${tag}`,
          title: 'ข้อตกลงหลักทดสอบ',
          counterparty_name: 'บริษัท คู่ค้าทดสอบ จำกัด',
          end_on: '2029-12-31',
        },
        legal,
      );
      ids.unshift(msa.id);
      await service.update(nda.id, { master_contract_id: msa.id }, legal);
      const master = await service.detail(msa.id, legal);
      expect(
        (
          master as unknown as { subContracts: { id: string }[] }
        ).subContracts.map((row) => row.id),
      ).toEqual([nda.id]);
      await expect(
        service.update(secret.id, { master_contract_id: msa.id }, legal),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(
        service.update(msa.id, { kind: 'standard' }, legal),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      // no party at all is refused by the database too
      await expect(
        prisma.customerContract.update({
          where: { id: nda.id },
          data: { counterpartyName: null },
        }),
      ).rejects.toThrow(/customer_contracts_party_check/);
    });

    it('CD-162/163: the sweeps and "mine" run on the engine; an obligation is done by its owner', async () => {
      const client = prisma as never;
      const ruleOf = (params: Record<string, unknown>) =>
        ({
          across: () =>
            Promise.resolve({
              standard: { enabled: true, params },
              byCompany: new Map(),
              of: () => ({ enabled: true, params }),
            }),
        }) as never;
      const expiryRule = ruleOf({ warn_days: [60, 30, 7] });
      const obligationRule = ruleOf({ warn_days: 3 });
      const told: unknown[] = [];
      const notifications = {
        contractExpiry: (...args: unknown[]) => {
          told.push(args);
          return Promise.resolve();
        },
        contractObligation: (...args: unknown[]) => {
          told.push(args);
          return Promise.resolve();
        },
      } as never;
      // 1990: nothing is due, so nothing is written
      const expiry = new ContractExpiryService(
        new CustomerContractRepository(client),
        expiryRule,
        notifications,
        { get: () => 0 } as never,
      );
      await expect(
        expiry.sweep(new Date('1990-01-01T03:00:00Z')),
      ).resolves.toEqual({ warned: 0 });

      const contractId = ids[ids.length - 1];
      const obligations = new ContractObligationsService(
        new ContractObligationRepository(client),
        new CustomerContractRepository(client),
        new CompanyMemberRepository(client),
        obligationRule,
        notifications,
        { record: () => Promise.resolve() } as never,
        { get: () => 0 } as never,
      );
      const legal = as(legalUser, true);
      const created = (await obligations.create(
        contractId,
        {
          title: `ส่งรายงาน T163-${tag}`,
          owner_user_id: legalUser,
          due_on: '1990-01-10',
        },
        legal,
      )) as { id: string };
      await expect(
        obligations.sweep(new Date('1990-01-01T03:00:00Z')),
      ).resolves.toEqual({ due: 0, overdue: 0 });
      const mine = (await obligations.mine(legal)) as unknown as {
        id: string;
      }[];
      expect(mine.some((row) => row.id === created.id)).toBe(true);
      await expect(
        obligations.complete(created.id, { note: 'ส่งแล้ว' }, legal),
      ).resolves.toMatchObject({ status: 'done' });
      await prisma.contractObligation.deleteMany({ where: { id: created.id } });
    });

    it('CD-146: a template, a draft on a contract request, and a second version — one draft per request', async () => {
      const client = prisma as never;
      const type = await prisma.requestType.findFirst({
        select: { id: true, code: true },
      });
      if (!type) return;
      const request = await prisma.request.create({
        data: {
          requestTypeId: type.id,
          typeCode: type.code,
          companyId,
          requesterId: legalUser,
          status: 'in_progress',
          formData: { contract_value: 500000, end_date: '2027-12-31' },
        },
      });
      const transactions = {
        execute: (work: (tx: unknown) => Promise<unknown>) =>
          prisma.$transaction((tx) => work(tx)),
      } as never;
      const audit = { record: () => Promise.resolve() } as never;
      const templates = new ContractTemplatesService(
        new ContractTemplateRepository(client),
        audit,
      );
      const drafts = new ContractDraftsService(
        new ContractDraftRepository(client),
        new ContractDraftVersionRepository(client),
        templates,
        new RequestRepository(client),
        {
          findFirst: () =>
            Promise.resolve({
              contractRequestTypeCode: type.code,
              letterheadNameTh: 'บริษัท ทดสอบ จำกัด',
              letterheadTaxId: null,
              letterheadAddress: null,
            }),
        } as never,
        { findFirst: () => Promise.resolve(null) } as never,
        { findFirst: () => Promise.resolve(null) } as never,
        { findFirst: () => Promise.resolve(null) } as never,
        { findFirst: () => Promise.resolve(null) } as never,
        new CompanyMemberRepository(client),
        transactions,
        audit,
      );
      const legal = as(legalUser, true);
      const template = await templates.create(
        {
          code: `T146-${tag}`,
          name: 'แม่แบบทดสอบ',
          clauses: [
            { heading: 'คู่สัญญา', body: '{{our_name}} กับ {{party_name}}' },
            { heading: 'มูลค่า', body: '{{contract_value}} บาท' },
          ],
        },
        legal,
      );
      try {
        const started = await drafts.start(
          { request_id: request.id, template_id: template.id },
          legal,
        );
        expect(started.clauses.map((clause) => clause.body)).toEqual([
          'บริษัท ทดสอบ จำกัด กับ {{party_name}}',
          '500,000.00 บาท',
        ]);
        expect(started.missing).toEqual(['party_name']);
        await expect(
          drafts.start(
            { request_id: request.id, template_id: template.id },
            legal,
          ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        const second = await drafts.saveVersion(
          started.id,
          {
            base_version: 1,
            clauses: [
              { ...started.clauses[0], body: 'บริษัท ทดสอบ จำกัด กับ ลูกค้า' },
            ],
          },
          legal,
        );
        expect(second.version.versionNo).toBe(2);
        expect(second.counts).toEqual({ edited: 1, added: 0, removed: 1 });
        // version 1 is untouched
        const first = await drafts.view(started.id, legal, 1);
        expect(first.clauses).toHaveLength(2);
      } finally {
        await prisma.contractDraft.deleteMany({
          where: { requestId: request.id },
        });
        await prisma.contractTemplate.delete({ where: { id: template.id } });
        await prisma.request.delete({ where: { id: request.id } });
      }
    });

    it('CD-158: an assessment and its issues round-trip as JSON; the table refuses an unknown level', async () => {
      const client = prisma as never;
      const contractId = ids[ids.length - 1];
      const service = new ContractRiskService(
        new ContractRiskAssessmentRepository(client),
        new CustomerContractRepository(client),
        { findFirst: () => Promise.resolve(null) } as never,
        { findFirst: () => Promise.resolve(null) } as never,
        {} as never,
        { record: () => Promise.resolve() } as never,
      );
      const legal = as(legalUser, true);
      const view = await service.save(
        contractId,
        {
          level: 'medium',
          summary: 'ภาพรวมยอมรับได้',
          issues: [
            { title: 'ภาษาสัญญากำกวม', clause: 'ข้อ 3', severity: 'low' },
          ],
        },
        legal,
        'Bearer t',
      );
      expect(view).toMatchObject({
        assessed: true,
        level: 'medium',
        issues: [
          {
            title: 'ภาษาสัญญากำกวม',
            clause: 'ข้อ 3',
            severity: 'low',
            escalate: false,
          },
        ],
        opinion: { state: 'not_needed' },
        signing: { ready: true },
      });
      await expect(
        prisma.contractRiskAssessment.update({
          where: { contractId },
          data: { level: 'extreme' },
        }),
      ).rejects.toThrow(/contract_risk_assessments_level_check/);
    });

    it('CD-164: a schedule is replaced whole in one transaction; the table refuses a zero installment', async () => {
      const client = prisma as never;
      const contractId = ids[ids.length - 1];
      await prisma.customerContract.update({
        where: { id: contractId },
        data: { value: 100 },
      });
      const service = new ContractInstallmentsService(
        new ContractInstallmentRepository(client),
        new CustomerContractRepository(client),
        {
          execute: (work: (tx: unknown) => Promise<unknown>) =>
            prisma.$transaction((tx) => work(tx)),
        } as never,
        { record: () => Promise.resolve() } as never,
      );
      const legal = as(legalUser, true);
      const thirds = [33.33, 33.33, 33.34].map((amount) => ({
        kind: 'progress' as const,
        amount,
        milestone: 'ส่งมอบ',
      }));
      await expect(
        service.save(contractId, { installments: thirds }, legal),
      ).resolves.toMatchObject({ total: 100, balanced: true });
      const again = await service.save(
        contractId,
        {
          installments: [
            {
              kind: 'deposit',
              amount: 40,
              due_note: 'เมื่อลงนาม',
              guarantee_type: 'bank_guarantee',
              guarantee_amount: 40,
              guarantee_expires_on: '2027-06-30',
            },
            { kind: 'final', amount: 60, due_on: '2027-01-31' },
          ],
        },
        legal,
      );
      expect(
        again.installments.map((row) => [row.seq, row.kind, row.amount]),
      ).toEqual([
        [1, 'deposit', 40],
        [2, 'final', 60],
      ]);
      expect(again.installments[0].guaranteeExpiresOn).toBe('2027-06-30');
      await expect(
        prisma.contractInstallment.create({
          data: {
            companyId,
            contractId,
            seq: 9,
            kind: 'progress',
            label: 'x',
            amount: 0,
          },
        }),
      ).rejects.toThrow(/contract_installments_amount_positive/);
    });
  },
);
