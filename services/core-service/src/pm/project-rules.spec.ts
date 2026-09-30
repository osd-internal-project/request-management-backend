import { buildBaseline, cleanMembers, openProblems } from './project-rules';

const contract = {
  status: 'active',
  kind: 'standard',
  signedOn: new Date('2026-09-20T00:00:00Z'),
  endOn: new Date('2027-09-30T00:00:00Z'),
  projectNo: null,
};

describe('CD-175 openProblems', () => {
  it('opens a signed, active contract of work before its end', () => {
    expect(openProblems(contract, '2026-09-30')).toEqual([]);
  });

  it('refuses an unsigned contract', () => {
    expect(
      openProblems({ ...contract, signedOn: null }, '2026-09-30').join(),
    ).toContain('ยังไม่ได้ลงนามครบ');
  });

  it('refuses one already opened, ended, cancelled, or an NDA', () => {
    expect(
      openProblems(
        { ...contract, projectNo: 'PRJ-OSD-000001' },
        '2026-09-30',
      ).join(),
    ).toContain('PRJ-OSD-000001');
    expect(openProblems(contract, '2027-10-01').join()).toContain(
      'สิ้นสุดแล้ว',
    );
    expect(
      openProblems({ ...contract, status: 'cancelled' }, '2026-09-30'),
    ).toHaveLength(1);
    expect(
      openProblems({ ...contract, kind: 'nda' }, '2026-09-30'),
    ).toHaveLength(1);
  });

  it('still opens on its last day', () => {
    expect(openProblems(contract, '2027-09-30')).toEqual([]);
  });
});

const sources = {
  contract: {
    contractNo: 'CTR-1',
    title: 'ติดตั้งกล้อง',
    value: 150000,
    currency: 'THB',
    startOn: new Date('2026-10-01T00:00:00Z'),
    endOn: new Date('2027-09-30T00:00:00Z'),
    signedOn: new Date('2026-09-20T00:00:00Z'),
    party: 'บริษัท ลูกค้า จำกัด',
  },
  version: {
    id: 'v1',
    versionNo: 2,
    solutionId: 's1',
    solutionTitle: 'ระบบกล้อง',
    inScope: ['ติดตั้งกล้อง 20 ตัว'],
    outOfScope: ['งานโยธา'],
    deliverables: [
      { title: 'ระบบกล้องพร้อมใช้งาน', description: '', criteria: ['ภาพชัด'] },
    ],
    assumptions: [{ category: 'customer', text: 'ลูกค้าเตรียมไฟ' }],
    boq: [
      {
        kind: 'equipment',
        productCode: 'CAM-01',
        name: 'กล้อง',
        quantity: 20,
        unit: 'ตัว',
        refUnitCost: 3000,
      },
      {
        kind: 'material',
        productCode: 'CBL-01',
        name: 'สาย',
        quantity: 10,
        unit: 'ม้วน',
        refUnitCost: null,
      },
    ],
    labor: [{ role: 'ช่าง', mandays: 10, rate: 2000 }],
  },
  quotes: [
    {
      id: 'q1',
      vendorName: 'ผู้ขาย',
      quoteNo: 'Q-1',
      quoteDate: new Date('2026-09-01T00:00:00Z'),
      validUntil: new Date('2026-12-31T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
      lines: [{ lineIndex: 1, productCode: 'CBL-01', unitPrice: 500 }],
    },
  ],
  requestPackage: null,
  installments: [
    {
      seq: 1,
      kind: 'deposit',
      label: 'มัดจำ',
      amount: 45000,
      dueOn: null,
      dueNote: 'เมื่อลงนาม',
      milestone: null,
    },
    {
      seq: 2,
      kind: 'final',
      label: 'งวดสุดท้าย',
      amount: 105000,
      dueOn: new Date('2027-03-31T00:00:00Z'),
      dueNote: null,
      milestone: 'ตรวจรับ',
    },
  ],
};

describe('CD-175 buildBaseline', () => {
  const today = new Date('2026-09-30T03:00:00Z');

  it('copies the contract, the approved scope, BOQ, labour, cost and installments', () => {
    const { baseline, missing } = buildBaseline(sources, today);
    expect(missing).toEqual([]);
    expect(baseline.contract).toMatchObject({
      contractNo: 'CTR-1',
      value: 150000,
      signedOn: '2026-09-20',
      endOn: '2027-09-30',
    });
    expect(baseline.solution).toEqual({
      solutionId: 's1',
      title: 'ระบบกล้อง',
      versionNo: 2,
    });
    expect(baseline.scope).toMatchObject({
      inScope: ['ติดตั้งกล้อง 20 ตัว'],
      outOfScope: ['งานโยธา'],
    });
    expect(baseline.boq).toHaveLength(2);
    // 20 × 3,000 reference + 10 × 500 from the partner quote; 10 × 2,000 labour
    expect(baseline.cost).toMatchObject({
      materialsTotal: 65000,
      laborTotal: 20000,
      total: 85000,
      missingCost: 0,
    });
    expect(baseline.installments).toEqual([
      expect.objectContaining({ seq: 1, amount: 45000, dueOn: null }),
      expect.objectContaining({
        seq: 2,
        dueOn: '2027-03-31',
        milestone: 'ตรวจรับ',
      }),
    ]);
  });

  it('falls back to the contract request package, and says what is missing', () => {
    const { baseline, missing } = buildBaseline(
      {
        ...sources,
        version: null,
        quotes: [],
        requestPackage: {
          solutionTitle: 'ระบบกล้อง',
          solutionVersionNo: 1,
          inScope: ['ติดตั้งกล้อง'],
          outOfScope: [],
          deliverables: [],
        },
        installments: [],
      },
      today,
    );
    expect(baseline.scope).toMatchObject({ inScope: ['ติดตั้งกล้อง'] });
    expect(baseline.boq).toEqual([]);
    expect(baseline.cost).toBeNull();
    expect(missing.join('|')).toContain('ใช้ขอบเขตงานจากคำขอจัดทำสัญญา');
    expect(missing.join('|')).toContain('ไม่มีรายการสิ่งส่งมอบ');
    expect(missing.join('|')).toContain('ไม่มีแผนงวดวางบิล');
  });

  it('flags BOQ lines without a cost', () => {
    const { missing } = buildBaseline({ ...sources, quotes: [] }, today);
    expect(missing).toEqual(['BOQ 1 รายการยังไม่มีต้นทุน']);
  });
});

describe('CD-175 cleanMembers', () => {
  it('drops blanks, repeats and the manager', () => {
    expect(
      cleanMembers(
        [
          { user_id: 'a', role: ' วิศวกร ' },
          { user_id: 'mgr' },
          { user_id: 'a', role: 'ซ้ำ' },
          { user_id: ' ' },
          { user_id: 'b' },
        ],
        'mgr',
      ),
    ).toEqual([
      { userId: 'a', role: 'วิศวกร' },
      { userId: 'b', role: null },
    ]);
  });
});
