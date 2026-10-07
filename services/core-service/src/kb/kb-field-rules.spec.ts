import {
  appendLessons,
  articleFromJobs,
  articleFromQa,
  boqProductCode,
  articleFromLessons,
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

describe('CD-263 project lessons', () => {
  it('one draft per project, sections by kind, empty kinds left out', () => {
    const a = articleFromLessons({ projectNo: 'PRJ-1', name: 'เครือข่าย' }, [
      { kind: 'improve', text: 'สั่งของช้า' },
      { kind: 'went_well', text: 'ทีมประสานดี' },
      { kind: 'improve', text: ' ' },
    ]);
    expect(a.title).toBe('บทเรียนจากโครงการ PRJ-1 · เครือข่าย');
    expect(a.body).toContain(
      '## สิ่งที่ทำได้ดี\n- ทีมประสานดี\n\n## สิ่งที่ควรปรับปรุง\n- สั่งของช้า',
    );
    expect(a.body).not.toContain('ข้อแนะนำ');
    expect(a.sourceRef).toBe('PRJ-1');
  });

  it('later lessons are appended', () => {
    expect(
      appendLessons('x', [{ kind: 'recommend', text: 'จองรถล่วงหน้า' }]),
    ).toBe('x\n\n## ข้อแนะนำสำหรับโครงการต่อไป\n- จองรถล่วงหน้า');
    expect(appendLessons('x', [])).toBe('x');
  });
});

describe('CD-264 Pre-Sales Q&A', () => {
  it('one answer: question and answer sections, no customer', () => {
    const a = articleFromQa([
      { question: 'รองรับ HA ไหม', answer: 'รองรับ active-passive' },
    ]);
    expect(a.title).toBe('รองรับ HA ไหม');
    expect(a.body).toContain(
      '## คำถาม\nรองรับ HA ไหม\n\n## คำตอบ\nรองรับ active-passive',
    );
  });

  it('several: numbered, unanswered dropped', () => {
    const a = articleFromQa([
      { question: 'q1', answer: 'a1' },
      { question: 'q2', answer: ' ' },
      { question: 'q3', answer: 'a3' },
    ]);
    expect(a.body).toContain('## 1. q1\na1\n\n## 2. q3\na3');
  });

  it('BOQ product: equipment first', () => {
    expect(
      boqProductCode([
        { kind: 'service', productCode: 'SVC' },
        { kind: 'equipment', productCode: 'FG-100' },
      ]),
    ).toBe('FG-100');
    expect(boqProductCode([{ kind: 'service', productCode: '' }])).toBeNull();
    expect(boqProductCode(null)).toBeNull();
  });
});
