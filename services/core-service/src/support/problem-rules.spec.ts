import {
  matchingProblems,
  problemStepProblems,
  repeatGroups,
  scopeProblems,
  stillDismissed,
} from './problem-rules';

const limits = { days: 90, asset: 3, model: 5, customerModel: 3 };
const job = (
  id: string,
  assetId: string,
  productCode: string,
  customerId: string,
) => ({
  id,
  assetId,
  productCode,
  customerId,
});

describe('CD-246 recurring problem rules', () => {
  it('suggests one unit, one model at a customer, one model anywhere — each at its threshold', () => {
    const groups = repeatGroups(
      [
        job('1', 'a1', 'CAM', 'c1'),
        job('2', 'a1', 'CAM', 'c1'),
        job('3', 'a1', 'CAM', 'c1'),
        job('4', 'a2', 'CAM', 'c1'),
        job('5', 'a3', 'CAM', 'c2'),
        job('6', 'a4', 'NVR', 'c2'),
      ],
      limits,
    );
    expect(groups.map((g) => [g.key, g.jobIds.length])).toEqual([
      ['model:CAM', 5],
      ['customer_model:c1|CAM', 4],
      ['asset:a1', 3],
    ]);
  });

  it('drops a wider group that holds exactly the same jobs', () => {
    const groups = repeatGroups(
      [
        job('1', 'a1', 'CAM', 'c1'),
        job('2', 'a1', 'CAM', 'c1'),
        job('3', 'a1', 'CAM', 'c1'),
      ],
      limits,
    );
    expect(groups.map((g) => g.key)).toEqual(['asset:a1']);
  });

  it('brings a dismissed group back only once it has grown', () => {
    const group = { key: 'asset:a1', jobIds: ['1', '2', '3'] } as never;
    expect(stillDismissed(group, new Map([['asset:a1', 3]]))).toBe(true);
    expect(stillDismissed(group, new Map([['asset:a1', 2]]))).toBe(false);
    expect(stillDismissed(group, new Map())).toBe(false);
  });

  it('moves a problem with what each step needs', () => {
    const none = { workaround: null, rootCause: null, permanentFix: null };
    expect(problemStepProblems('open', 'investigating', none)).toEqual([]);
    expect(problemStepProblems('open', 'known_error', none)).toEqual([
      'รู้สาเหตุแล้วต้องมีวิธีแก้ชั่วคราวให้ช่างใช้',
    ]);
    expect(problemStepProblems('investigating', 'resolved', none)).toEqual([
      'ต้องระบุสาเหตุราก',
      'ต้องระบุวิธีแก้ถาวร',
    ]);
    expect(problemStepProblems('open', 'closed', none)[0]).toContain('ไม่ได้');
    expect(problemStepProblems('resolved', 'closed', none)).toEqual([]);
  });

  it('checks a scope', () => {
    expect(
      scopeProblems({
        scope: 'asset',
        assetId: null,
        productCode: null,
        customerId: null,
      }),
    ).toHaveLength(1);
    expect(
      scopeProblems({
        scope: 'customer_model',
        assetId: null,
        productCode: 'CAM',
        customerId: 'c1',
      }),
    ).toEqual([]);
  });

  it('matches a new job to open problems of its unit, model, or model at its customer', () => {
    const base = {
      status: 'open',
      assetId: null,
      productCode: null,
      customerId: null,
    };
    const problems = [
      { ...base, id: 'p1', scope: 'asset', assetId: 'a1' },
      { ...base, id: 'p2', scope: 'model', productCode: 'CAM' },
      {
        ...base,
        id: 'p3',
        scope: 'customer_model',
        productCode: 'CAM',
        customerId: 'c2',
      },
      {
        ...base,
        id: 'p4',
        scope: 'model',
        productCode: 'CAM',
        status: 'resolved',
      },
    ];
    expect(
      matchingProblems(job('x', 'a1', 'CAM', 'c1'), problems).map((p) => p.id),
    ).toEqual(['p1', 'p2']);
  });
});
