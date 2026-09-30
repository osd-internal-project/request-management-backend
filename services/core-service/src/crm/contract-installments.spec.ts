import type { Principal } from '@request-management/share';
import {
  balanceOf,
  scheduleProblems,
  shareOf,
  type InstallmentInput,
} from './contract-installments';
import { ContractInstallmentsService } from './contract-installments.service';

const deposit: InstallmentInput = {
  kind: 'deposit',
  amount: 300_000,
  dueNote: 'เมื่อลงนามสัญญา',
  guaranteeType: 'bank_guarantee',
  guaranteeAmount: 300_000,
};
const progress: InstallmentInput = {
  kind: 'progress',
  amount: 500_000,
  milestone: 'ติดตั้งแล้วเสร็จ',
};
const retention: InstallmentInput = {
  kind: 'retention',
  amount: 200_000,
  dueNote: 'คืนเมื่อพ้นระยะประกัน',
};

describe('CD-164 billing schedule rules', () => {
  it('adds up to the contract value in satang, not in floating point', () => {
    expect(balanceOf([33.33, 33.33, 33.34], 100)).toEqual({
      total: 100,
      difference: 0,
      balanced: true,
    });
    expect(balanceOf([0.1, 0.2], 0.3).balanced).toBe(true);
    expect(balanceOf([400_000], 1_000_000)).toMatchObject({
      difference: -600_000,
      balanced: false,
    });
    expect(shareOf(300_000, 1_000_000)).toBe(30);
    expect(shareOf(1, 3)).toBe(33.33);
    expect(shareOf(1, null)).toBeNull();
  });

  it('a whole schedule that equals the value may be saved; an empty one clears it', () => {
    expect(scheduleProblems([deposit, progress, retention], 1_000_000)).toEqual(
      [],
    );
    expect(scheduleProblems([], null)).toEqual([]);
  });

  it('says how far it is off — short or over', () => {
    expect(scheduleProblems([deposit, progress], 1_000_000)).toEqual([
      'ผลรวมทุกงวดยังขาดอีก 200,000.00 บาท จากมูลค่าสัญญา',
    ]);
    expect(
      scheduleProblems(
        [deposit, progress, { ...retention, amount: 200_000.5 }],
        1_000_000,
      ),
    ).toEqual(['ผลรวมทุกงวดเกินมูลค่าสัญญา 0.50 บาท']);
  });

  it('a deposit carries its guarantee, at least as large as the advance', () => {
    const { guaranteeType: _type, ...bare } = deposit;
    expect(scheduleProblems([bare, progress, retention], 1_000_000)).toEqual([
      'งวดที่ 1: เงินมัดจำต้องบันทึกหลักประกันที่ออกคู่กัน',
    ]);
    expect(
      scheduleProblems(
        [{ ...deposit, guaranteeAmount: 150_000 }, progress, retention],
        1_000_000,
      ),
    ).toEqual(['งวดที่ 1: หลักประกันต้องไม่น้อยกว่าเงินมัดจำ']);
  });

  it('every installment says when; amounts are positive to the satang; one final', () => {
    expect(
      scheduleProblems(
        [
          { kind: 'progress', amount: 500_000 },
          { kind: 'final', amount: 250_000.005, dueOn: '2027-01-31' },
          { kind: 'final', amount: 250_000, dueOn: '2027-02-28' },
        ],
        1_000_000,
      ),
    ).toEqual([
      'งวดที่ 1: ต้องระบุกำหนดชำระ หรือหมุดหมายที่ปลดล็อก',
      'งวดที่ 2: จำนวนเงินต้องมากกว่า 0 และไม่เกินทศนิยม 2 ตำแหน่ง',
      'งวดสุดท้ายมีได้งวดเดียว',
      'ผลรวมทุกงวดเกินมูลค่าสัญญา 0.01 บาท',
    ]);
  });

  it('no schedule on a contract without a value', () => {
    expect(scheduleProblems([progress], null)).toEqual([
      'ระบุมูลค่าสัญญาก่อนวางงวด',
    ]);
  });
});

const legal = {
  userId: 'u-legal',
  activeCompanyId: 'osd',
  permissions: ['legal.contract.read', 'legal.contract.manage'],
} as unknown as Principal;

function harness(contract: Record<string, unknown> | null) {
  let stored: Record<string, unknown>[] = [];
  const tx = {
    // CD-182 — no milestone tied to these installments
    projectMilestone: {
      findMany: jest.fn(() => Promise.resolve([])),
      update: jest.fn(),
    },
    contractInstallment: {
      findMany: jest.fn(() => Promise.resolve(stored)),
      deleteMany: jest.fn(() => {
        stored = [];
        return Promise.resolve({ count: 0 });
      }),
      createMany: jest.fn((args: { data: Record<string, unknown>[] }) => {
        stored = args.data.map((row, index) => ({
          id: `i-${index + 1}`,
          ...row,
        }));
        return Promise.resolve({ count: stored.length });
      }),
    },
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new ContractInstallmentsService(
    { findMany: jest.fn(() => Promise.resolve(stored)) } as never,
    { findFirst: jest.fn(() => Promise.resolve(contract)) } as never,
    { execute: (work: (client: typeof tx) => unknown) => work(tx) } as never,
    audit as never,
  );
  return { service, tx, audit, stored: () => stored };
}

const contract = {
  id: 'c-1',
  companyId: 'osd',
  contractNo: 'CTR-001',
  value: 1_000_000,
  currency: 'THB',
};

describe('CD-164 ContractInstallmentsService', () => {
  it('saves the schedule whole, numbered in order, and shows each share', async () => {
    const { service, audit, stored } = harness(contract);
    const view = await service.save(
      'c-1',
      {
        installments: [
          {
            kind: 'deposit',
            amount: 300_000,
            due_note: 'เมื่อลงนามสัญญา',
            guarantee_type: 'bank_guarantee',
            guarantee_amount: 300_000,
            guarantee_ref: ' LG-001 ',
          },
          {
            kind: 'progress',
            label: 'งวดที่ 2',
            amount: 500_000,
            milestone: 'ติดตั้งแล้วเสร็จ',
          },
          {
            kind: 'retention',
            amount: 200_000,
            due_on: '2027-10-14',
            // a guarantee without its type is not kept
            guarantee_amount: 5,
          },
        ],
      },
      legal,
    );
    expect(stored().map((row) => [row.seq, row.kind, row.label])).toEqual([
      [1, 'deposit', 'เงินมัดจำ'],
      [2, 'progress', 'งวดที่ 2'],
      [3, 'retention', 'เงินประกันผลงาน'],
    ]);
    expect(stored()[2].guaranteeAmount).toBeNull();
    expect(view).toMatchObject({
      contractValue: 1_000_000,
      total: 1_000_000,
      balanced: true,
      installments: [
        { sharePct: 30, guaranteeRef: 'LG-001' },
        { sharePct: 50 },
        { sharePct: 20, dueOn: '2027-10-14' },
      ],
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'legal.installments.saved' }),
    );
  });

  it('refuses a schedule that does not add up, and writes nothing', async () => {
    const { service, tx } = harness(contract);
    await expect(
      service.save(
        'c-1',
        {
          installments: [{ kind: 'progress', amount: 1, due_on: '2026-12-01' }],
        },
        legal,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(tx.contractInstallment.deleteMany).not.toHaveBeenCalled();
  });

  it('a contract the reader cannot see answers not found', async () => {
    const { service } = harness(null);
    await expect(service.view('c-9', legal)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
