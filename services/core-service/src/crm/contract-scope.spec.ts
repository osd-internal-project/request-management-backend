import type { Principal } from '@request-management/share';
import {
  checkItems,
  checkProblems,
  foundIn,
  scopeItems,
  statusOf,
} from './contract-scope';
import { ContractScopeCheckService } from './contract-scope-check.service';

const pack = {
  inScope: ['ติดตั้งระบบ ERP', 'อบรมผู้ใช้ 2 รุ่น'],
  outOfScope: ['ย้ายข้อมูลเก่า'],
  deliverables: [{ title: 'ระบบพร้อมใช้งาน', criteria: ['ผ่าน UAT'] }],
};

const clauses = [
  {
    key: 'c1',
    heading: 'ขอบเขตงาน',
    body: '1. ติดตั้งระบบ  ERP\n2. อบรมผู้ใช้ 2 รุ่น\nไม่รวม: ย้ายข้อมูลเก่า',
  },
  { key: 'c2', heading: 'การส่งมอบ', body: 'ระบบพร้อมใช้งาน' },
];

describe('CD-150 scope of work against the contract', () => {
  it('lists every item: in and out of scope, deliverables and their criteria', () => {
    expect(scopeItems(pack).map((item) => [item.key, item.kind])).toEqual([
      ['in-0', 'in_scope'],
      ['in-1', 'in_scope'],
      ['out-0', 'out_of_scope'],
      ['del-0', 'deliverable'],
      ['del-0-0', 'criterion'],
    ]);
  });

  it('finds an item regardless of spacing, case and punctuation', () => {
    const [erp] = scopeItems(pack);
    expect(foundIn(erp, clauses)).toBe(true);
    expect(
      foundIn(
        { key: 'x', kind: 'in_scope', text: 'ติดตั้ง-ระบบ, erp' },
        clauses,
      ),
    ).toBe(true);
    expect(
      foundIn({ key: 'x', kind: 'criterion', text: 'ผ่าน UAT' }, clauses),
    ).toBe(false);
  });

  it('found matches; not found waits for Legal, who must say why either way', () => {
    const items = checkItems(scopeItems(pack), clauses, new Map());
    expect(items.map((item) => item.verdict)).toEqual([
      'match',
      'match',
      'match',
      'match',
      null,
    ]);
    expect(checkProblems(items)).toEqual(['ยังไม่ได้ตัดสิน: ผ่าน UAT']);

    const explained = checkItems(
      scopeItems(pack),
      clauses,
      new Map([['del-0-0', { verdict: 'match' as const, note: null }]]),
    );
    expect(checkProblems(explained)).toEqual([
      'ไม่พบในสัญญาแต่ถือว่าตรง ต้องอธิบาย (เช่น ข้อที่ใช้ถ้อยคำอื่น): ผ่าน UAT',
    ]);

    const mismatched = checkItems(
      scopeItems(pack),
      clauses,
      new Map([
        [
          'del-0-0',
          { verdict: 'mismatch' as const, note: 'สัญญาไม่มีเกณฑ์ตรวจรับ' },
        ],
      ]),
    );
    expect(checkProblems(mismatched)).toEqual([]);
    expect(statusOf(mismatched)).toBe('inconsistent');
    expect(
      statusOf(
        checkItems(
          scopeItems(pack),
          clauses,
          new Map([
            [
              'del-0-0',
              { verdict: 'match' as const, note: 'อยู่ในข้อ 5 ภาคผนวก' },
            ],
          ]),
        ),
      ),
    ).toBe('consistent');
  });
});

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

function harness(options: { solution?: boolean; latest?: number }) {
  const rows: Record<string, unknown>[] = [];
  const checks = {
    findMany: jest.fn(() => Promise.resolve([...rows].reverse())),
    upsert: jest.fn((args: { create: Record<string, unknown> }) => {
      rows.push({ ...args.create, checkedAt: new Date() });
      return Promise.resolve(args.create);
    }),
  };
  const service = new ContractScopeCheckService(
    checks as never,
    {
      subjectOf: jest.fn(() =>
        Promise.resolve({
          companyId: 'osd',
          requestId: 'req-1',
          latestVersionNo: options.latest ?? 2,
          editable: true,
        }),
      ),
      clausesOf: jest.fn(() => Promise.resolve(clauses)),
    } as never,
    {
      of: jest.fn(() =>
        Promise.resolve({
          requestId: 'req-1',
          opportunityId: 'opp-1',
          negotiationRoundNo: null,
          tradeTerms: [],
          solutionId: options.solution === false ? null : 's-1',
          solutionTitle: 'ERP',
          solutionVersionNo: 3,
          inScope: pack.inScope,
          outOfScope: pack.outOfScope,
          deliverables: pack.deliverables,
          assumptionsText: null,
          missing: [],
          capturedAt: new Date(),
          capturedBy: null,
        }),
      ),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
  );
  return { service, rows };
}

describe('CD-150 ContractScopeCheckService', () => {
  it('unchecked, then inconsistent, then consistent — the blocker follows', async () => {
    const { service } = harness({});
    await expect(service.blocker('d-1', legal)).resolves.toBe(
      'ยังไม่ได้ตรวจขอบเขตงานของร่างฉบับที่ 2',
    );
    await service.save(
      'd-1',
      {
        verdicts: [
          { key: 'del-0-0', verdict: 'mismatch', note: 'ไม่มีเกณฑ์ตรวจรับ' },
        ],
      },
      legal,
    );
    await expect(service.blocker('d-1', legal)).resolves.toContain(
      'ไม่สอดคล้อง',
    );
    const view = await service.save(
      'd-1',
      {
        verdicts: [
          { key: 'del-0-0', verdict: 'match', note: 'อยู่ในภาคผนวก ก' },
        ],
      },
      legal,
    );
    expect(view.status).toBe('consistent');
    await expect(service.blocker('d-1', legal)).resolves.toBeNull();
  });

  it('an item not found and not decided is refused', async () => {
    const { service } = harness({});
    await expect(
      service.save('d-1', { verdicts: [] }, legal),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('no approved Solution: nothing to check, nothing blocks', async () => {
    const { service } = harness({ solution: false });
    await expect(service.view('d-1', legal)).resolves.toMatchObject({
      applicable: false,
    });
    await expect(service.blocker('d-1', legal)).resolves.toBeNull();
  });
});
