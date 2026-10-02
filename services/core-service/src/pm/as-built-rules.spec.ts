import {
  asBuiltRefs,
  asBuiltStatus,
  deviationProblems,
} from './as-built-rules';

describe('CD-226 as-built rules', () => {
  it('a deviation may point at a BOQ line or a scope line of the baseline', () => {
    const refs = asBuiltRefs({
      boq: [
        { name: 'กล้อง IP', productCode: 'CAM-1', quantity: 20, unit: 'ตัว' },
        { name: '', productCode: '', quantity: 1 },
      ],
      scope: { inScope: ['ติดตั้งกล้อง 20 จุด'] },
    });
    expect(refs).toEqual([
      { ref: 'boq:0', label: 'BOQ 1: กล้อง IP × 20 ตัว' },
      { ref: 'scope:0', label: 'ขอบเขต 1: ติดตั้งกล้อง 20 จุด' },
    ]);
    expect(asBuiltRefs(null)).toEqual([]);
  });

  it('a deviation says what was planned and what was built, and points inside the baseline', () => {
    expect(
      deviationProblems({
        planned: 'กล้อง 20 ตัว',
        built: 'กล้อง 18 ตัว',
        reference: 'boq:0',
        refs: ['boq:0'],
      }),
    ).toEqual([]);
    expect(
      deviationProblems({
        planned: ' ',
        built: '',
        reference: 'boq:9',
        refs: [],
      }),
    ).toHaveLength(3);
  });

  it('complete when every required document is there and every deviation is settled', () => {
    expect(
      asBuiltStatus({
        required: ['แบบติดตั้งจริง', 'ผังการเชื่อมต่อระบบ'],
        uploaded: [' แบบติดตั้งจริง ', 'ผังการเชื่อมต่อระบบ', 'อื่น ๆ'],
        deviations: [
          {
            label: 'D-1',
            reason: 'ลูกค้าขอย้ายจุด',
            affectsScope: false,
            changeStatus: null,
          },
          {
            label: 'D-2',
            reason: 'ลดจำนวน',
            affectsScope: true,
            changeStatus: 'approved',
          },
        ],
      }),
    ).toEqual({ complete: true, missingDocuments: [], openDeviations: [] });
  });

  it('what is missing is said, document by document and deviation by deviation', () => {
    expect(
      asBuiltStatus({
        required: ['แบบติดตั้งจริง', 'ผังการเชื่อมต่อระบบ'],
        uploaded: ['แบบติดตั้งจริง'],
        deviations: [
          { label: 'D-1', reason: '', affectsScope: false, changeStatus: null },
          {
            label: 'D-2',
            reason: 'ลด',
            affectsScope: true,
            changeStatus: 'submitted',
          },
        ],
      }),
    ).toEqual({
      complete: false,
      missingDocuments: ['ผังการเชื่อมต่อระบบ'],
      openDeviations: [
        'D-1: ยังไม่มีเหตุผล',
        'D-2: กระทบขอบเขต ต้องผูกกับคำขอเปลี่ยนแปลงที่อนุมัติแล้ว',
      ],
    });
  });
});
