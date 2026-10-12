import {
  acceptProblems,
  answer,
  gapsByGroup,
  type IntakeSources,
  intakeLines,
  readAnswers,
  withAnswers,
} from './intake-rules';

const sources = (overrides: Partial<IntakeSources> = {}): IntakeSources => ({
  handover: {
    status: 'accepted',
    round: 1,
    items: [
      {
        code: 'budget',
        label: 'งบประมาณลูกค้า',
        checked: true,
        detail: '2 ล้าน',
      },
      { code: 'site', label: 'หน้างาน', checked: false, detail: null },
    ],
  },
  baseline: {
    contract: {
      contractNo: 'CTR-1',
      value: 150000,
      currency: 'THB',
      startOn: '2026-10-01',
      endOn: '2026-12-31',
      signedOn: '2026-09-30',
    },
    solution: { title: 'กล้องอาคาร A', versionNo: 2 },
    scope: { inScope: ['ติดตั้ง'], outOfScope: [], deliverables: ['กล้อง'] },
    boq: [{}, {}],
    cost: { total: 80000, missingCost: 0 },
    installments: [{ amount: 50000 }, { amount: 100000 }],
  },
  missing: [],
  companyLines: ['ผู้ติดต่อลูกค้า', ' ', 'ผู้ติดต่อลูกค้า'],
  ...overrides,
});

describe('CD-176 receiving the work — the lines', () => {
  it('sales from the handover, technical and contract from the baseline, company lines once', () => {
    const lines = intakeLines(sources());
    expect(lines.map((line) => line.code)).toEqual([
      'sales.handover',
      'sales.item.budget',
      'sales.item.site',
      'technical.solution',
      'technical.scope',
      'technical.boq',
      'contract.signed',
      'contract.value',
      'contract.installments',
      'company.ผู้ติดต่อลูกค้า',
    ]);
    const by = new Map(lines.map((line) => [line.code, line]));
    expect(by.get('sales.item.budget')).toMatchObject({
      detail: '2 ล้าน',
      warn: false,
    });
    expect(by.get('sales.item.site')).toMatchObject({ warn: true });
    expect(by.get('technical.solution')?.detail).toBe(
      'กล้องอาคาร A · เวอร์ชัน 2',
    );
    expect(by.get('contract.installments')?.detail).toBe('2 งวด · รวม 150,000');
  });

  it('what is missing is said on the line and flagged', () => {
    const lines = intakeLines(
      sources({
        handover: null,
        baseline: { contract: { contractNo: 'CTR-1' } },
        companyLines: [],
      }),
    );
    const by = new Map(lines.map((line) => [line.code, line]));
    expect(by.get('sales.handover')).toMatchObject({
      detail: 'ไม่พบงานส่งมอบจากทีมขายของดีลนี้',
      warn: true,
    });
    expect(by.get('technical.solution')?.warn).toBe(true);
    expect(by.get('technical.boq')?.detail).toBe('ไม่มี BOQ');
    expect(by.get('contract.signed')?.warn).toBe(true);
    expect(by.get('contract.installments')?.detail).toBe('ไม่มีแผนงวดวางบิล');
  });
});

describe('CD-176 receiving the work — verdicts', () => {
  const at = '2026-10-08T03:00:00.000Z';
  const lines = intakeLines(sources({ companyLines: [] }));

  it('a verdict stands while the detail is the same; changed → asked again', () => {
    const answers = [
      {
        code: 'technical.boq',
        detail: 'BOQ 1 รายการ',
        result: 'incomplete' as const,
        note: 'ขาดสาย',
        by: 'u-pm',
        at,
      },
      ...lines
        .filter((line) => line.code !== 'technical.boq')
        .map((line) => ({
          code: line.code,
          detail: line.detail,
          result: 'ok' as const,
          note: null,
          by: 'u-pm',
          at,
        })),
    ];
    const state = withAnswers(lines, answers);
    const boq = state.find((line) => line.code === 'technical.boq');
    expect(boq).toMatchObject({ result: null, changed: true });
    expect(acceptProblems(state)).toEqual(['ยังไม่ได้ตรวจ: BOQ และต้นทุน']);
  });

  it('received only when every line is correct', () => {
    const all = lines.map((line) => ({
      code: line.code,
      detail: line.detail,
      result: 'ok' as const,
      note: null,
      by: 'u-pm',
      at,
    }));
    expect(acceptProblems(withAnswers(lines, all))).toEqual([]);
    const one = answer(all, {
      ...all[0],
      result: 'incomplete',
      note: 'ยังไม่ได้รับ',
    });
    expect(one).toHaveLength(all.length);
    const state = withAnswers(lines, one);
    expect(acceptProblems(state)).toEqual(['ไม่ครบ: งานส่งมอบจากทีมขาย']);
    expect([...gapsByGroup(state).keys()]).toEqual(['sales']);
  });

  it('stored answers that are malformed are ignored', () => {
    expect(
      readAnswers([
        null,
        { code: 'x' },
        { code: 'y', detail: '', result: 'maybe' },
        { code: 'z', detail: '', result: 'ok' },
      ]),
    ).toEqual([{ code: 'z', detail: '', result: 'ok' }]);
    expect(readAnswers('nope')).toEqual([]);
  });
});
