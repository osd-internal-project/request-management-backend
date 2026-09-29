import type { Principal } from '@request-management/share';
import { masterProblem, sameParty } from './contract-links';
import { ContractMasterNotifier } from './contract-master-notifier';

const msa = {
  id: 'msa-1',
  kind: 'msa',
  status: 'active',
  customerId: 'cus-1',
  counterpartyName: null,
};

describe('CD-149 a contract under a master agreement', () => {
  it('fits: same customer, the master is an active MSA', () => {
    expect(
      masterProblem(
        { kind: 'standard', customerId: 'cus-1', counterpartyName: null },
        msa,
      ),
    ).toBeNull();
  });

  it('refuses a different party, a non-MSA master, a cancelled one, itself, and an MSA under an MSA', () => {
    const sub = {
      kind: 'standard',
      customerId: 'cus-1',
      counterpartyName: null,
    };
    expect(masterProblem({ ...sub, customerId: 'cus-2' }, msa)).toBe(
      'สัญญาย่อยต้องเป็นคู่สัญญาเดียวกับข้อตกลงหลัก',
    );
    expect(masterProblem(sub, { ...msa, kind: 'nda' })).toBe(
      'สัญญาที่อ้างอิงต้องเป็นข้อตกลงหลัก (MSA)',
    );
    expect(masterProblem(sub, { ...msa, status: 'cancelled' })).toBe(
      'ข้อตกลงหลักนี้ถูกยกเลิกแล้ว',
    );
    expect(masterProblem({ ...sub, id: 'msa-1' }, msa)).toBe(
      'สัญญาอ้างอิงตัวเองเป็นข้อตกลงหลักไม่ได้',
    );
    expect(masterProblem({ ...sub, kind: 'msa' }, msa)).toBe(
      'ข้อตกลงหลัก (MSA) อ้างอิงข้อตกลงหลักอื่นไม่ได้',
    );
    expect(masterProblem(sub, null)).toBe('ไม่พบข้อตกลงหลักที่ระบุ');
  });

  it('an outside party is the same when the name is, ignoring spacing and case', () => {
    const a = {
      kind: 'nda',
      customerId: null,
      counterpartyName: 'ACME  Co., Ltd.',
    };
    expect(sameParty(a, { ...a, counterpartyName: 'acme co., ltd.' })).toBe(
      true,
    );
    expect(sameParty(a, { ...a, counterpartyName: 'Other Co.' })).toBe(false);
    expect(
      sameParty(a, { ...a, counterpartyName: null, customerId: 'cus-1' }),
    ).toBe(false);
  });
});

describe('CD-149 ContractMasterNotifier', () => {
  it('tells the owner of each active sub-contract — not the person who made the change', async () => {
    const notifications = {
      masterAgreementChanged: jest.fn(() => Promise.resolve()),
    };
    const notifier = new ContractMasterNotifier(
      {
        findFirst: jest.fn(() =>
          Promise.resolve({
            companyId: 'osd',
            contractNo: 'MSA-001',
            title: 'ข้อตกลงหลัก',
            subContracts: [
              { id: 's1', contractNo: 'CTR-1', ownerUserId: 'sales-1' },
              { id: 's2', contractNo: 'CTR-2', ownerUserId: 'legal-1' },
            ],
          }),
        ),
      } as never,
      notifications as never,
    );
    const told = await notifier.changed('msa-1', 'แก้ไขวันสิ้นสุด', {
      userId: 'legal-1',
    } as unknown as Principal);
    expect(told).toBe(1);
    expect(notifications.masterAgreementChanged).toHaveBeenCalledWith(
      'sales-1',
      'osd',
      expect.objectContaining({ contractNo: 'MSA-001' }),
      { id: 's1', contractNo: 'CTR-1', ownerUserId: 'sales-1' },
      'แก้ไขวันสิ้นสุด',
    );
  });

  it('a failing notification never fails the edit', async () => {
    const notifier = new ContractMasterNotifier(
      {
        findFirst: jest.fn(() => Promise.reject(new Error('db down'))),
      } as never,
      {} as never,
    );
    await expect(
      notifier.changed('msa-1', 'x', { userId: 'u' } as unknown as Principal),
    ).resolves.toBe(0);
  });
});
