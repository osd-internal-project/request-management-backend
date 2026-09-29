import type { Principal } from '@request-management/share';
import { CustomerMergeService, warningsOf } from './customer-merge.service';

const actor = {
  userId: 'admin-1',
  activeCompanyId: 'osd',
  displayName: 'ผู้ดูแลระบบ',
} as unknown as Principal;

const side = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  companyId: 'osd',
  customerCode: `CUS-${id}`,
  nameTh: `ลูกค้า ${id}`,
  taxId: null as string | null,
  branchCode: null as string | null,
  status: 'active',
  headOfficeId: null as string | null,
  mergedIntoCustomerId: null as string | null,
  accountOwnerUserId: null as string | null,
  ...extra,
});

function harness(rows: ReturnType<typeof side>[]) {
  const prisma = {
    customer: {
      findMany: jest.fn(
        (args: { where: { id: { in: string[] }; companyId: string } }) =>
          Promise.resolve(
            rows.filter(
              (row) =>
                args.where.id.in.includes(row.id) &&
                row.companyId === args.where.companyId,
            ),
          ),
      ),
    },
  };
  const transactions = { execute: jest.fn() };
  const service = new CustomerMergeService(
    prisma as never,
    transactions as never,
    {} as never,
    { kickCustomer: jest.fn() } as never,
    { record: jest.fn() } as never,
  );
  return { service, transactions };
}

async function codeOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return 'no error';
}

describe('CD-122 CustomerMergeService guards', () => {
  it('refuses the same customer, another company’s, an alias, or no reason — before any write', async () => {
    const rows = [
      side('a'),
      side('b'),
      side('x', { companyId: 'other' }),
      side('old', { mergedIntoCustomerId: 'b' }),
    ];
    const { service, transactions } = harness(rows);
    const merge = (from: string, into: string, reason = 'ซ้ำ') =>
      service.merge(from, into, { into, reason }, actor);

    expect(await codeOf(merge('a', 'a'))).toBe('VALIDATION_FAILED');
    expect(await codeOf(merge('a', 'x'))).toBe('NOT_FOUND');
    expect(await codeOf(merge('old', 'a'))).toBe('CRM_CUSTOMER_STATE_INVALID');
    expect(await codeOf(merge('a', 'b', '   '))).toBe('VALIDATION_FAILED');
    expect(transactions.execute).not.toHaveBeenCalled();
  });
});

describe('CD-122 merge warnings', () => {
  const none = { externalCodes: [], accountPlan: false };

  it('names what an admin should read twice', () => {
    expect(
      warningsOf(
        side('a', { taxId: '0105561000001' }),
        side('b', { taxId: '0105561000002' }),
        none,
      ),
    ).toEqual(['เลขประจำตัวผู้เสียภาษีไม่ตรงกัน — อาจเป็นคนละนิติบุคคล']);

    expect(
      warningsOf(
        side('a', { taxId: '0105561000001', branchCode: '00001' }),
        side('b', { taxId: '0105561000001' }),
        none,
      ),
    ).toEqual(['เลขภาษีเดียวกันแต่คนละสาขา — ปกติเป็นลูกค้าคนละราย']);

    const all = warningsOf(
      side('a', { accountOwnerUserId: 'u1' }),
      side('b', { headOfficeId: 'a', accountOwnerUserId: 'u2' }),
      { externalCodes: ['sap'], accountPlan: true },
    );
    expect(all).toHaveLength(4);
    expect(all[1]).toContain('SAP');
  });

  it('a clean pair has nothing to say', () => {
    expect(
      warningsOf(side('a', { taxId: '0105561000001' }), side('b'), none),
    ).toEqual([]);
  });
});
