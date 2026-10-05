import {
  changeFromTech,
  costChangeOf,
  deviationsOf,
  inForce,
  techLinesFrom,
  techSubmitProblems,
} from './tech-change-rules';

const baseline = {
  boq: [
    { name: 'Access point', quantity: 10, unit: 'ตัว', refUnitCost: 5000 },
    { name: 'Switch 24 port', quantity: 2, unit: 'ตัว', refUnitCost: 30000 },
  ],
};

describe('CD-224 technical change rules', () => {
  it('lines are completed from the baseline BOQ and costed', () => {
    const { lines, problems } = techLinesFrom(
      [
        { ref: 'boq:0', quantity_to: 12 },
        { ref: 'boq:1', quantity_to: 1, unit_cost: 28000 },
        { name: 'PoE injector', unit: 'ตัว', quantity_to: 3, unit_cost: 1500 },
      ],
      baseline,
    );
    expect(problems).toEqual([]);
    expect(lines[0]).toEqual({
      ref: 'boq:0',
      name: 'Access point',
      unit: 'ตัว',
      quantityFrom: 10,
      quantityTo: 12,
      unitCost: 5000,
    });
    // +2 × 5000 − 1 × 28000 + 3 × 1500
    expect(costChangeOf(lines)).toBe(-13500);
  });

  it('a line must exist, change something, and appear once', () => {
    const { problems } = techLinesFrom(
      [
        { ref: 'boq:9', quantity_to: 1 },
        { ref: 'boq:0', quantity_to: 10 },
        { ref: 'boq:0', quantity_to: 11 },
        { quantity_to: 1 },
      ],
      baseline,
    );
    expect(problems).toEqual([
      'บรรทัด 1: ไม่พบรายการนี้ใน BOQ',
      'บรรทัด 1: ต้องระบุรายการ',
      'บรรทัด 2: จำนวนไม่เปลี่ยน',
      'บรรทัด 3: รายการ BOQ นี้ซ้ำ',
      'บรรทัด 4: ต้องระบุรายการ',
    ]);
  });

  it('a scope change needs its scope and its change request before it goes', () => {
    const base = {
      title: 'เปลี่ยนรุ่น AP',
      reason: 'รุ่นเดิมเลิกผลิต',
      description: null,
      lines: 1,
      affectsScope: false,
      scopeAdded: null,
      scopeRemoved: null,
      changeRequestId: null,
    };
    expect(techSubmitProblems(base)).toEqual([]);
    expect(techSubmitProblems({ ...base, affectsScope: true })).toEqual([
      'กระทบขอบเขต: ต้องระบุขอบเขตที่เพิ่มหรือลด',
      'กระทบขอบเขต: ต้องเปิดคำขอเปลี่ยนแปลง (CR) ก่อนยื่น',
    ]);
    expect(techSubmitProblems({ ...base, reason: '', lines: 0 })).toHaveLength(
      2,
    );
  });

  it('in force once approved — and its CR approved, when the scope moves', () => {
    expect(
      inForce({ status: 'approved', affectsScope: false, changeStatus: null }),
    ).toBe(true);
    expect(
      inForce({
        status: 'approved',
        affectsScope: true,
        changeStatus: 'submitted',
      }),
    ).toBe(false);
    expect(
      inForce({
        status: 'approved',
        affectsScope: true,
        changeStatus: 'approved',
      }),
    ).toBe(true);
    expect(
      inForce({ status: 'submitted', affectsScope: false, changeStatus: null }),
    ).toBe(false);
  });

  it('it leaves a deviation per line, and a CR draft with the added cost', () => {
    const { lines } = techLinesFrom(
      [
        { ref: 'boq:0', quantity_to: 12 },
        { name: 'PoE injector', unit: 'ตัว', quantity_to: 3, unit_cost: 1500 },
        { ref: 'boq:1', quantity_to: 1 },
      ],
      baseline,
    );
    const deviations = deviationsOf({
      label: 'TC-1',
      title: 'เพิ่มจุดกระจายสัญญาณ',
      reason: 'ผนังหนากว่าที่สำรวจ',
      affectsScope: true,
      changeRequestId: 'cr1',
      lines,
    });
    expect(deviations[0]).toEqual({
      reference: 'boq:0',
      planned: 'Access point × 10 ตัว',
      built: 'Access point × 12 ตัว',
      reason: 'TC-1 เพิ่มจุดกระจายสัญญาณ: ผนังหนากว่าที่สำรวจ',
      affectsScope: true,
      changeRequestId: 'cr1',
    });
    expect(deviations[1]).toMatchObject({
      reference: null,
      planned: 'ไม่มีใน BOQ',
    });
    const change = changeFromTech({
      label: 'TC-1',
      title: 'เพิ่มจุดกระจายสัญญาณ',
      reason: 'ผนังหนากว่าที่สำรวจ',
      scopeAdded: 'เพิ่ม AP 2 จุดชั้น 3',
      scopeRemoved: null,
      lines,
    });
    expect(change.cost_lines).toEqual([
      {
        category: 'material',
        description: 'Access point',
        quantity: 2,
        unit: 'ตัว',
        unit_cost: 5000,
      },
      {
        category: 'material',
        description: 'PoE injector',
        quantity: 3,
        unit: 'ตัว',
        unit_cost: 1500,
      },
    ]);
    expect(change).toMatchObject({ scope_added: 'เพิ่ม AP 2 จุดชั้น 3' });
  });
});
