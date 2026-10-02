import {
  currentOf,
  deployProblems,
  environmentProblems,
  releaseProblems,
} from './release-rules';

describe('CD-214 release rules', () => {
  it('an environment has a kind, a name and, if any, a web address', () => {
    expect(
      environmentProblems({
        kind: 'uat',
        name: 'UAT',
        url: 'https://uat.x.co',
      }),
    ).toEqual([]);
    expect(
      environmentProblems({ kind: 'qa', name: ' ', url: 'uat.x.co' }),
    ).toHaveLength(3);
  });

  it('a version is a short plain tag', () => {
    expect(releaseProblems('1.2.0-rc.1')).toEqual([]);
    expect(releaseProblems('')).toEqual(['ต้องระบุเวอร์ชัน']);
    expect(releaseProblems('v 1')).toHaveLength(1);
  });

  const now = new Date('2026-10-08T03:00:00Z');
  const prod = {
    kind: 'production',
    onUat: true,
    hasUat: true,
    blockers: 0,
    overrideReason: '',
    canEdit: false,
    deployedAt: now,
    now,
  };

  it('production takes what ran on UAT, with no blocker open', () => {
    expect(deployProblems(prod)).toEqual([]);
    expect(deployProblems({ ...prod, onUat: false, blockers: 2 })).toEqual([
      'เวอร์ชันนี้ยังไม่เคย deploy บน UAT',
      'มีข้อบกพร่องหรือประเด็น UAT ระดับปิดกั้นค้าง 2 รายการ',
    ]);
    expect(
      deployProblems({ ...prod, hasUat: false, onUat: false }),
    ).toHaveLength(1);
    // other environments take anything
    expect(
      deployProblems({ ...prod, kind: 'uat', onUat: false, blockers: 3 }),
    ).toEqual([]);
  });

  it('the manager may override production with a reason (a hotfix)', () => {
    const hotfix = {
      ...prod,
      onUat: false,
      blockers: 1,
      overrideReason: 'ระบบล่ม',
    };
    expect(deployProblems(hotfix)).toEqual([
      'ข้ามเงื่อนไข production ได้เฉพาะผู้จัดการโครงการ',
    ]);
    expect(deployProblems({ ...hotfix, canEdit: true })).toEqual([]);
  });

  it('a deployment cannot be dated in the future', () => {
    expect(
      deployProblems({
        ...prod,
        kind: 'dev',
        deployedAt: new Date('2026-10-09T00:00:00Z'),
      }),
    ).toEqual(['เวลาที่ deploy ต้องไม่เกินตอนนี้']);
  });

  it('what runs on an environment is its latest deployment', () => {
    const rows = [
      { environmentId: 'e1', deployedAt: new Date('2026-10-01'), v: '1.0' },
      { environmentId: 'e1', deployedAt: new Date('2026-10-05'), v: '1.1' },
      { environmentId: 'e2', deployedAt: new Date('2026-10-02'), v: '1.0' },
    ];
    const current = currentOf(rows);
    expect(current.get('e1')?.v).toBe('1.1');
    expect(current.get('e2')?.v).toBe('1.0');
  });
});
