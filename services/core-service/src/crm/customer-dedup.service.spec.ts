import { CustomerDedupService } from './customer-dedup.service';
import { normalizeCustomerName } from './customer-name';

interface Row {
  id: string;
  companyId: string;
  customerCode: string;
  nameTh: string;
  nameEn: string | null;
  normalizedName: string;
  taxId: string | null;
  branchCode: string;
  branchName: string | null;
  status: string;
  headOfficeId: string | null;
  mergedIntoCustomerId: string | null;
  createdAt: Date;
}

const OSD = 'company-osd';
const TAX = '1234567890121';

let seq = 0;
function row(overrides: Partial<Row>): Row {
  seq += 1;
  return {
    id: `cust-${seq}`,
    companyId: OSD,
    customerCode: `CUS-OSD-${String(seq).padStart(6, '0')}`,
    nameTh: 'บริษัท ทดสอบ จำกัด',
    nameEn: null,
    normalizedName: '',
    taxId: null,
    branchCode: '00000',
    branchName: null,
    status: 'active',
    headOfficeId: null,
    mergedIntoCustomerId: null,
    createdAt: new Date(Date.UTC(2026, 0, seq)),
    ...overrides,
  };
}

type Where = Partial<{
  companyId: string;
  taxId: string;
  branchCode: string;
  mergedIntoCustomerId: null;
  id: { not: string };
}>;

/** The handful of `where` keys the service uses, evaluated for real. */
function matches(r: Row, where: Where): boolean {
  return (
    (where.companyId === undefined || r.companyId === where.companyId) &&
    (where.taxId === undefined || r.taxId === where.taxId) &&
    (where.branchCode === undefined || r.branchCode === where.branchCode) &&
    (where.mergedIntoCustomerId === undefined ||
      r.mergedIntoCustomerId === null) &&
    (where.id === undefined || r.id !== where.id.not)
  );
}

function harness(rows: Row[], threshold: number | null = null) {
  // normalizedName is what `create` stores; derive it the same way here
  for (const r of rows) r.normalizedName = normalizeCustomerName(r.nameTh);

  const prisma = {
    customer: {
      findFirst: jest.fn((args: { where: Where }) =>
        Promise.resolve(rows.find((r) => matches(r, args.where)) ?? null),
      ),
      findMany: jest.fn((args: { where: Where }) =>
        Promise.resolve(
          rows
            .filter((r) => matches(r, args.where))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        ),
      ),
    },
    crmCompanyConfig: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          threshold === null ? null : { dedupThreshold: threshold },
        ),
      ),
    },
  };
  return new CustomerDedupService(prisma as never);
}

describe('CM-03 CustomerDedupService', () => {
  it('same tax id + same branch → duplicate, naming the existing row', async () => {
    const existing = row({ taxId: TAX, nameTh: 'บริษัท กขค จำกัด' });
    const service = harness([existing]);

    const result = await service.check(
      { nameTh: 'อะไรก็ได้', taxId: TAX, branchCode: '00000' },
      OSD,
    );

    expect(result.duplicate).toMatchObject({
      id: existing.id,
      similarity: 1,
    });
    expect(result.headOffice).toBeNull();
  });

  it('same tax id + new branch → no duplicate; the head office is named instead', async () => {
    const head = row({ taxId: TAX });
    const branch = row({
      taxId: TAX,
      branchCode: '00001',
      headOfficeId: head.id,
    });
    const service = harness([branch, head]);

    const result = await service.check(
      { nameTh: 'สาขาใหม่', taxId: TAX, branchCode: '00002' },
      OSD,
    );

    expect(result.duplicate).toBeNull();
    expect(result.headOffice).toMatchObject({ id: head.id });
  });

  it('head office prefers a head row with code 00000 over an older head', async () => {
    const olderHead = row({ taxId: TAX, branchCode: '00009' });
    const hq = row({ taxId: TAX, branchCode: '00000' });
    const service = harness([olderHead, hq]);

    const head = await service.headOfficeOf(TAX, OSD);

    expect(head?.id).toBe(hq.id);
  });

  it('similar-name warning ignores บจก./บริษัท…จำกัด and skips rows with the same tax id', async () => {
    const lookalike = row({ nameTh: 'บจก. กขค เทรดดิ้ง' });
    // same tax id → it is a branch/duplicate question, not a name warning
    const sameTax = row({
      nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด',
      taxId: TAX,
      branchCode: '00005',
    });
    const unrelated = row({ nameTh: 'บริษัท สยามอาหาร จำกัด' });
    const service = harness([lookalike, sameTax, unrelated]);

    const result = await service.check(
      { nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด', taxId: TAX, branchCode: '00000' },
      OSD,
    );

    expect(result.similar.map((s) => s.id)).toEqual([lookalike.id]);
  });

  it('uses the company’s own threshold, not the default', async () => {
    const near = row({ nameTh: 'บริษัท กขค เทรด จำกัด' });

    const strict = await harness([near], 0.99).check(
      { nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด' },
      OSD,
    );
    const loose = await harness([near], 0.5).check(
      { nameTh: 'บริษัท กขค เทรดดิ้ง จำกัด' },
      OSD,
    );

    expect(strict.threshold).toBe(0.99);
    expect(strict.similar).toHaveLength(0);
    expect(loose.threshold).toBe(0.5);
    expect(loose.similar.map((s) => s.id)).toEqual([near.id]);
  });

  it('no config row → the 0.85 default', async () => {
    const result = await harness([]).check({ nameTh: 'ใดๆ' }, OSD);

    expect(result.threshold).toBe(0.85);
  });

  it('an update never collides with itself, and other companies never match', async () => {
    const self = row({ taxId: TAX, nameTh: 'บริษัท กขค จำกัด' });
    const elsewhere = row({
      companyId: 'company-lex',
      taxId: TAX,
      nameTh: 'บริษัท กขค จำกัด',
    });
    const service = harness([self, elsewhere]);

    const result = await service.check(
      {
        nameTh: 'บริษัท กขค จำกัด',
        taxId: TAX,
        branchCode: '00000',
        excludeCustomerId: self.id,
      },
      OSD,
    );

    expect(result.duplicate).toBeNull();
    expect(result.headOffice).toBeNull();
    expect(result.similar).toHaveLength(0);
  });

  it('a merged alias row is never the match — the survivor is', async () => {
    const survivor = row({ taxId: TAX });
    const alias = row({ taxId: TAX, mergedIntoCustomerId: survivor.id });
    const service = harness([alias, survivor]);

    const result = await service.check(
      { nameTh: 'x', taxId: TAX, branchCode: '00000' },
      OSD,
    );

    expect(result.duplicate?.id).toBe(survivor.id);
  });
});
