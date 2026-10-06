import {
  articleFromJobs,
  articleFromProblem,
  problemReady,
  subjectTerms,
} from './kb-field-rules';

describe('CD-262 field knowledge rules', () => {
  it('one job: symptom, cause, fix and where it came from', () => {
    const a = articleFromJobs([
      {
        requestNo: 'SVC-001',
        title: 'VPN หลุดบ่อย',
        cause: 'MTU',
        resolution: 'ตั้ง MTU 1400',
      },
    ]);
    expect(a.title).toBe('VPN หลุดบ่อย');
    expect(a.body).toContain('## สาเหตุ\n- MTU');
    expect(a.body).toContain('## วิธีแก้\nตั้ง MTU 1400');
    expect(a.body).toContain('> ที่มา: ใบงานบริการ SVC-001');
    expect(a.sourceRef).toBe('SVC-001');
  });

  it('several jobs: repeats dropped, fixes numbered', () => {
    const a = articleFromJobs([
      { requestNo: 'A', title: 'x', cause: 'c', resolution: 'f1' },
      { requestNo: 'B', title: 'x ', cause: 'c', resolution: 'f2' },
    ]);
    expect(a.body).toContain('## อาการ\n- x\n');
    expect(a.body).toContain('1. f1\n2. f2');
    expect(a.sourceRef).toBe('A, B');
  });

  it('a problem is ready once known and written up', () => {
    const p = {
      problemNo: 'PRB-1',
      title: 't',
      status: 'investigating',
      rootCause: 'r',
      workaround: 'w',
      permanentFix: null,
    };
    expect(problemReady(p)).toBe(false);
    expect(problemReady({ ...p, status: 'known_error' })).toBe(true);
    expect(problemReady({ ...p, status: 'known_error', workaround: ' ' })).toBe(
      false,
    );
    const a = articleFromProblem({ ...p, status: 'known_error' });
    expect(a.title).toBe('ปัญหาที่ทราบแล้ว: t');
    expect(a.body).toContain('## วิธีหลบเลี่ยง\nw');
    expect(a.body).not.toContain('การแก้ถาวร');
  });

  it('subject terms: short words dropped', () => {
    expect(subjectTerms('VPN หลุด / เน็ตช้า ที่ ชั้น 2')).toEqual([
      'vpn',
      'หลุด',
      'เน็ตช้า',
      'ที่',
      'ชั้น',
    ]);
  });
});
