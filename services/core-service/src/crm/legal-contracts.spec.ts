import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Principal } from '@request-management/share';
import { extractContractText, normalizeText } from './contract-text';
import { contractVisibleWhere } from './contract-visibility';
import { LegalContractsService } from './legal-contracts.service';

/** Printed from plain text by macOS cupsfilter: Thai and English lines. */
const SAMPLE_PDF = readFileSync(
  join(__dirname, '../../test/fixtures/contract-th.pdf'),
);

const reader = {
  userId: 'u-read',
  activeCompanyId: 'osd',
  displayName: 'ผู้อ่าน',
  permissions: ['legal.contract.read'],
} as unknown as Principal;
const manager = {
  ...reader,
  userId: 'u-legal',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

describe('CD-161 contract text', () => {
  it('reads the text layer of a PDF — Thai included — collapsing whitespace', async () => {
    const result = await extractContractText(SAMPLE_PDF, 'application/pdf');
    expect(result).toEqual({
      status: 'extracted',
      text: 'สัญญาจ้างบริการดูแลระบบ ค่าปรับร้อยละ 0.1 ต่อวัน Penalty clause 0.1 percent per day',
    });
  });

  it('a Word file is kept but not read; a broken PDF is failed, not thrown', async () => {
    await expect(
      extractContractText(Buffer.from('x'), 'application/msword'),
    ).resolves.toEqual({ status: 'not_pdf', text: null });
    await expect(
      extractContractText(Buffer.from('not a pdf'), 'application/pdf'),
    ).resolves.toEqual({ status: 'failed', text: null });
    expect(normalizeText('  a\n\n b\tc ')).toBe('a b c');
  });
});

describe('CD-161 who sees a confidential contract', () => {
  it('manage sees all; anyone else sees ordinary ones plus their own and those they were given', () => {
    expect(contractVisibleWhere(manager)).toEqual({});
    expect(contractVisibleWhere(reader)).toEqual({
      OR: [
        { confidential: false },
        { ownerUserId: 'u-read' },
        { createdBy: 'u-read' },
        { access: { some: { userId: 'u-read' } } },
      ],
    });
  });
});

describe('CD-161 LegalContractsService', () => {
  function harness() {
    const contracts = {
      findFirst: jest.fn(() => Promise.resolve(null)),
      findMany: jest.fn(() => Promise.resolve([])),
      count: jest.fn(() => Promise.resolve(0)),
      create: jest.fn((args: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'c-1', ...args.data }),
      ),
    };
    const customers = {
      findFirst: jest.fn(() => Promise.resolve(null)),
    };
    const service = new LegalContractsService(
      contracts as never,
      {} as never,
      {} as never,
      customers as never,
      {} as never,
      { record: jest.fn() } as never,
      {
        execute: (work: (tx: unknown) => Promise<unknown>) => work({}),
      } as never,
      {} as never,
      { changed: jest.fn(() => Promise.resolve(0)) } as never,
    );
    return { service, contracts };
  }

  const base = {
    contract_no: 'NDA-001',
    title: 'NDA โครงการ',
    end_on: '2027-12-31',
  };

  it('a contract names a customer or a counterparty — never neither', async () => {
    const { service, contracts } = harness();
    await expect(service.create(base, manager)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await service.create(
      {
        ...base,
        kind: 'nda',
        counterparty_name: ' บริษัท คู่ค้า จำกัด ',
        counterparty_tax_id: '0105561000001',
      },
      manager,
    );
    expect(contracts.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          kind: 'nda',
          customerId: null,
          counterpartyName: 'บริษัท คู่ค้า จำกัด',
          counterpartyTaxId: '0105561000001',
          ownerUserId: 'u-legal',
        }) as unknown,
      },
      expect.anything(),
    );
  });

  it('search covers number, party and customer; text searches inside the files', async () => {
    const { service, contracts } = harness();
    await service.list(reader, {
      search: 'คู่ค้า',
      text: ' ค่าปรับ \n ร้อยละ ',
      kind: 'nda',
      ends_to: '2027-01-01',
    } as never);
    const where = (
      contracts.findMany.mock.calls[0] as unknown as [
        { where: { AND: Record<string, unknown>[] } },
      ]
    )[0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        { kind: 'nda' },
        { endOn: { lte: new Date('2027-01-01T00:00:00Z') } },
        {
          documents: {
            some: {
              deletedAt: null,
              textContent: { contains: 'ค่าปรับ ร้อยละ', mode: 'insensitive' },
            },
          },
        },
      ]),
    );
    // the confidential rule is part of every list
    expect(where.AND[0]).toMatchObject({
      companyId: 'osd',
      OR: expect.any(Array) as unknown,
    });
  });
});
