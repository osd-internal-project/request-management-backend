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
  },
);
