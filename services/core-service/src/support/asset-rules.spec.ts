import { assetProblems, assetsFromProject, serialKey } from './asset-rules';

describe('CD-236 installed base rules', () => {
  const baseline = {
    boq: [
      {
        kind: 'equipment',
        name: 'กล้อง IP',
        productCode: 'CAM-1',
        model: 'X100',
        quantity: 2,
      },
    ],
  };

  it('an accepted project leaves its installed points and production software', () => {
    const drafts = assetsFromProject({
      projectName: 'ระบบกล้อง อาคาร A',
      baseline,
      points: [
        {
          id: 'p1',
          seq: 1,
          location: 'ชั้น 1',
          boqIndex: 0,
          serialNo: 'SN1',
          installedOn: '2026-10-01',
        },
        {
          id: 'p2',
          seq: 2,
          location: 'ชั้น 2',
          boqIndex: 0,
          serialNo: null,
          installedOn: null,
        },
        {
          id: 'p3',
          seq: 3,
          location: 'ห้อง server',
          boqIndex: null,
          serialNo: 'SN3',
          installedOn: '2026-10-02',
        },
        {
          id: 'p4',
          seq: 4,
          location: 'ชั้น 3',
          boqIndex: 0,
          serialNo: 'SN4',
          installedOn: '2026-10-02',
        },
      ],
      environments: [
        { id: 'e1', kind: 'uat', name: 'UAT' },
        { id: 'e2', kind: 'production', name: 'Production' },
      ],
      registered: {
        installationIds: new Set(['p4']),
        environmentIds: new Set(),
      },
    });
    expect(drafts.map((d) => [d.kind, d.name, d.serialNo, d.model])).toEqual([
      ['equipment', 'กล้อง IP', 'SN1', 'X100'],
      // no BOQ line: named after its point
      ['equipment', 'จุดติดตั้ง P-3', 'SN3', null],
      ['software', 'ระบบกล้อง อาคาร A — Production', null, null],
    ]);
  });

  it('an asset entered by hand names what it is', () => {
    const ok = {
      kind: 'equipment',
      name: 'UPS',
      serialNo: 'U1',
      installedOn: '2025-01-01',
      today: '2026-10-05',
    };
    expect(assetProblems(ok)).toEqual([]);
    expect(
      assetProblems({
        ...ok,
        kind: 'x',
        name: ' ',
        installedOn: '2027-01-01',
        status: 'lost',
      }),
    ).toHaveLength(4);
  });

  it('serials compare without case or spaces', () => {
    expect(serialKey(' ab 12c ')).toBe('AB12C');
    expect(serialKey('  ')).toBeNull();
  });
});
