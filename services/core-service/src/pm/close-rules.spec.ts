import {
  closeChecks,
  closeoutEditable,
  closeProblems,
  lessonProblems,
  missingDocuments,
  type CloseFacts,
} from './close-rules';

const clean: CloseFacts = {
  projectStatus: 'active',
  obligationsOpen: 0,
  issuesOpen: 0,
  decisionsOwed: 0,
  changesPending: 0,
  milestonesOpen: 0,
  documentsMissing: [],
  lessons: 1,
  tasksOpen: 0,
  risksOpen: 0,
  outstanding: 0,
};

describe('CD-191 close-out rules', () => {
  it('a project with nothing owed may be closed', () => {
    expect(closeProblems(closeChecks(clean))).toEqual([]);
  });

  it('anything owed stops it, each said with its count', () => {
    const problems = closeProblems(
      closeChecks({
        ...clean,
        obligationsOpen: 2,
        issuesOpen: 1,
        decisionsOwed: 1,
        changesPending: 1,
        milestonesOpen: 3,
        documentsMissing: ['ใบตรวจรับงาน'],
        lessons: 0,
      }),
    );
    expect(problems).toHaveLength(7);
    expect(problems).toContain('ไม่มีข้อผูกพันตามสัญญาค้าง: ค้าง 2 ข้อ');
    expect(problems).toContain(
      'แนบเอกสารปิดโครงการครบ: ยังไม่มี: ใบตรวจรับงาน',
    );
  });

  it('open tasks, risks and unpaid installments only warn', () => {
    const checks = closeChecks({
      ...clean,
      tasksOpen: 4,
      risksOpen: 1,
      outstanding: 120000,
    });
    expect(closeProblems(checks)).toEqual([]);
    expect(
      checks.filter((check) => !check.ok).map((check) => check.key),
    ).toEqual(['tasks', 'risks', 'payments']);
  });

  it('a closed project cannot be closed again', () => {
    expect(
      closeProblems(closeChecks({ ...clean, projectStatus: 'closed' })),
    ).toEqual(['โครงการยังดำเนินอยู่: โครงการปิดหรือยกเลิกแล้ว']);
  });

  it('documents match by name, ignoring stray spaces', () => {
    expect(
      missingDocuments(['ใบตรวจรับงาน', 'เอกสารส่งมอบงาน'], [' ใบตรวจรับงาน ']),
    ).toEqual(['เอกสารส่งมอบงาน']);
  });

  it('a lesson needs a known kind and some text', () => {
    expect(
      lessonProblems({ kind: 'improve', text: 'นัดลูกค้าล่วงหน้า' }),
    ).toEqual([]);
    expect(lessonProblems({ kind: 'x', text: '  ' })).toHaveLength(2);
  });

  it('editable as a draft or after a rejection only', () => {
    expect(closeoutEditable(null)).toBe(true);
    expect(closeoutEditable('rejected')).toBe(true);
    expect(closeoutEditable('submitted')).toBe(false);
    expect(closeoutEditable('approved')).toBe(false);
  });
});
