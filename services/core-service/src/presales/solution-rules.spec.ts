import {
  approvalBlocker,
  approvalFormData,
  assessmentProblem,
  briefOf,
  cleanDeliverables,
  cleanLines,
  readDeliverables,
  sowGaps,
  cleanAssumptions,
  lockGaps,
  MAX_ASSUMPTION_LENGTH,
  MAX_ASSUMPTIONS,
  readAssumptions,
  requirementCounts,
  requirementGaps,
  type RequirementState,
} from './solution-rules';

describe('CD-132 solution rules', () => {
  it('blank assumptions are dropped and text trimmed', () => {
    const { assumptions, problems } = cleanAssumptions([
      { category: 'technical', text: '  ลูกค้ามี VLAN แยก  ' },
      { category: 'customer', text: '   ' },
    ]);
    expect(problems).toEqual([]);
    expect(assumptions).toEqual([
      { category: 'technical', text: 'ลูกค้ามี VLAN แยก' },
    ]);
  });

  it('an unknown category, an over-long line and too many lines are each named', () => {
    expect(
      cleanAssumptions([{ category: 'magic', text: 'x' }]).problems[0],
    ).toContain('ข้อ 1');
    expect(
      cleanAssumptions([
        { category: 'technical', text: 'x'.repeat(MAX_ASSUMPTION_LENGTH + 1) },
      ]).problems,
    ).toHaveLength(1);
    const many = Array.from({ length: MAX_ASSUMPTIONS + 1 }, () => ({
      category: 'commercial',
      text: 'ok',
    }));
    expect(cleanAssumptions(many).problems).toEqual([
      `สมมติฐานได้ไม่เกิน ${MAX_ASSUMPTIONS} ข้อ`,
    ]);
  });

  it('a stored column is read defensively', () => {
    expect(readAssumptions(null)).toEqual([]);
    expect(
      readAssumptions([
        { category: 'third_party', text: 'ISP ส่งมอบวงจรภายใน 30 วัน' },
        { category: 'bogus', text: 'x' },
        'junk',
      ]),
    ).toEqual([
      { category: 'third_party', text: 'ISP ส่งมอบวงจรภายใน 30 วัน' },
    ]);
  });

  it('a version locks only with a summary and a design', () => {
    expect(lockGaps({ summary: ' ', design: '' })).toEqual([
      'ยังไม่มีสรุปทางออก',
      'ยังไม่มีรายละเอียดการออกแบบ',
    ]);
    expect(
      lockGaps({ summary: 'SD-WAN 12 สาขา', design: 'hub-spoke' }),
    ).toEqual([]);
  });

  it('the brief carries the known form fields only', () => {
    expect(
      briefOf({
        requirement: 'เชื่อม 12 สาขา',
        needs_demo: true,
        secret: 'x',
        site: '',
      }),
    ).toEqual({ requirement: 'เชื่อม 12 สาขา', needs_demo: 'ใช่' });
    expect(briefOf(null)).toEqual({});
  });
});

describe('CD-131 requirement rules', () => {
  const row = (assessment: string, customerAnswer: string | null = null) =>
    ({ assessment, customerAnswer }) as RequirementState;

  it('counts what is waiting on the customer: asked and unanswered only', () => {
    expect(
      requirementCounts([
        row('needs_info'),
        row('needs_info', '  '),
        row('needs_info', 'ใช้ Fortinet'),
        row('feasible'),
        row('unassessed'),
      ]),
    ).toMatchObject({
      total: 5,
      needs_info: 3,
      waiting_customer: 2,
      unassessed: 1,
      feasible: 1,
    });
  });

  it('an empty or fully assessed analysis leaves nothing blocking', () => {
    expect(requirementGaps([])).toEqual([]);
    expect(
      requirementGaps([
        row('feasible'),
        row('not_feasible'),
        row('needs_info', 'ok'),
      ]),
    ).toEqual([]);
  });

  it('a question and a refusal must each say why', () => {
    expect(assessmentProblem('needs_info', ' ')).not.toBeNull();
    expect(assessmentProblem('not_feasible', '')).not.toBeNull();
    expect(assessmentProblem('feasible', '')).toBeNull();
    expect(
      assessmentProblem('needs_info', 'ใช้ firewall ยี่ห้อไหน'),
    ).toBeNull();
  });
});

describe('CD-134 scope of work rules', () => {
  it('blank lines are dropped and an over-long one is named', () => {
    expect(cleanLines([' ติดตั้ง 12 สาขา ', '', '  '], 'งานในขอบเขต')).toEqual({
      lines: ['ติดตั้ง 12 สาขา'],
      problems: [],
    });
    expect(cleanLines(['x'.repeat(1001)], 'งานในขอบเขต').problems[0]).toContain(
      'งานในขอบเขต ข้อ 1',
    );
  });

  it('an empty deliverable is dropped; criteria without a title is a problem', () => {
    const { deliverables, problems } = cleanDeliverables([
      { title: ' ติดตั้งอุปกรณ์ ', criteria: [' ลิงก์ขึ้นครบ ', ''] },
      { title: '', description: '', criteria: [''] },
      { title: ' ', criteria: ['failover < 30 วินาที'] },
    ]);
    expect(deliverables).toEqual([
      { title: 'ติดตั้งอุปกรณ์', description: '', criteria: ['ลิงก์ขึ้นครบ'] },
    ]);
    expect(problems).toEqual(['รายการส่งมอบข้อ 3: ยังไม่มีชื่อรายการ']);
  });

  it('a version locks only with scope, deliverables and criteria for each', () => {
    expect(sowGaps({ inScope: [], deliverables: [] })).toEqual([
      'ยังไม่มีงานในขอบเขต',
      'ยังไม่มีรายการส่งมอบ',
    ]);
    expect(
      sowGaps({
        inScope: ['SD-WAN'],
        deliverables: [
          { title: 'ติดตั้ง', criteria: ['ลิงก์ขึ้น'] },
          { title: 'อบรม', criteria: [] },
        ],
      }),
    ).toEqual(['รายการส่งมอบยังไม่มีเกณฑ์ตรวจรับ: อบรม']);
    expect(
      sowGaps({
        inScope: ['SD-WAN'],
        deliverables: [{ title: 'ติดตั้ง', criteria: ['ลิงก์ขึ้น'] }],
      }),
    ).toEqual([]);
  });

  it('a stored column is read defensively', () => {
    expect(readDeliverables('junk')).toEqual([]);
    expect(readDeliverables([{ title: 'a', criteria: ['x', 3, ' '] }])).toEqual(
      [{ title: 'a', description: '', criteria: ['x'] }],
    );
  });
});

describe('CD-143 approval rules', () => {
  it('only the current locked version, not yet asked or approved, may go', () => {
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'none' }, true),
    ).toBeNull();
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'cancelled' }, true),
    ).toBeNull();
    expect(
      approvalBlocker({ status: 'draft', approvalStatus: 'none' }, true),
    ).not.toBeNull();
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'none' }, false),
    ).not.toBeNull();
    expect(
      approvalBlocker(
        { status: 'superseded', approvalStatus: 'approved' },
        false,
      ),
    ).not.toBeNull();
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'approved' }, true),
    ).toContain('เปิดเวอร์ชันใหม่');
  });

  it('the form carries the locked version as text, leaving out what is empty', () => {
    const form = approvalFormData({
      title: 'SD-WAN',
      versionNo: 3,
      summary: 'สรุป',
      inScope: ['a', 'b'],
      outOfScope: [],
      deliverables: [
        { title: 'ติดตั้ง', description: 'ทุกสาขา', criteria: ['ลิงก์ขึ้น'] },
      ],
      assumptions: [{ category: 'customer', text: 'มี rack' }],
      requirements: [
        {
          kind: 'technical',
          text: 'firewall เดิม',
          assessment: 'needs_info',
          note: 'ยี่ห้อ?',
          customerAnswer: 'Fortinet',
        },
      ],
    });
    expect(form).toEqual({
      solution_title: 'SD-WAN',
      version_no: '3',
      summary: 'สรุป',
      in_scope: '1. a\n2. b',
      deliverables: '1. ติดตั้ง\n   ทุกสาขา\n   - ตรวจรับ: ลิงก์ขึ้น',
      assumptions: '1. [สิ่งที่ต้องพึ่งพาลูกค้า] มี rack',
      requirements:
        '1. [เทคนิค] firewall เดิม — ขอข้อมูลลูกค้า\n   ยี่ห้อ?\n   ลูกค้าตอบ: Fortinet',
    });
  });
});
