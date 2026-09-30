import {
  boqGaps,
  boqSummary,
  boqText,
  cleanBoq,
  clausesFromText,
  torCounts,
  torText,
  criteriaFromText,
  demoCloseGaps,
  demoCounts,
  demosText,
  riskCounts,
  riskLevel,
  risksText,
  clarificationCounts,
  clarificationsText,
  scopeResolutionProblem,
  approvalBlocker,
  contractAssumptionsText,
  feasibilityProblem,
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
      'ยังไม่ได้ประเมินความเป็นไปได้',
    ]);
    expect(
      lockGaps({
        summary: 'SD-WAN 12 สาขา',
        design: 'hub-spoke',
        feasibility: 'feasible',
        feasibilityNote: '',
      }),
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

describe('CD-133 feasibility rules', () => {
  it('a verdict is required; conditions and refusals must say why', () => {
    expect(feasibilityProblem('unassessed', '')).toBe(
      'ยังไม่ได้ประเมินความเป็นไปได้',
    );
    expect(feasibilityProblem('conditional', ' ')).not.toBeNull();
    expect(feasibilityProblem('not_feasible', '')).not.toBeNull();
    expect(feasibilityProblem('conditional', 'ลูกค้าต้องขยาย rack')).toBeNull();
    expect(feasibilityProblem('feasible', '')).toBeNull();
  });

  it('a dependency keeps who and by when; other categories do not', () => {
    const { assumptions, problems } = cleanAssumptions([
      {
        category: 'customer',
        text: 'เตรียมพื้นที่ rack',
        owner: ' ฝ่ายไอทีลูกค้า ',
        needed_by: '2026-11-01',
      },
      { category: 'constraint', text: 'ห้ามหยุดระบบเวลาทำการ', owner: 'x' },
    ]);
    expect(problems).toEqual([]);
    expect(assumptions).toEqual([
      {
        category: 'customer',
        text: 'เตรียมพื้นที่ rack',
        owner: 'ฝ่ายไอทีลูกค้า',
        neededBy: '2026-11-01',
      },
      { category: 'constraint', text: 'ห้ามหยุดระบบเวลาทำการ' },
    ]);
    expect(
      cleanAssumptions([
        { category: 'third_party', text: 'ISP', needed_by: '2026-13-40' },
      ]).problems,
    ).toEqual(['สมมติฐานข้อ 1: วันที่ต้องพร้อมไม่ถูกต้อง']);
  });

  it('a not-feasible version cannot be sent for approval', () => {
    expect(
      approvalBlocker(
        {
          status: 'locked',
          approvalStatus: 'none',
          feasibility: 'not_feasible',
        },
        true,
      ),
    ).toContain('ไม่เป็นไปได้');
  });

  it('the contract text puts dependencies and constraints first, then the rest and the conditions', () => {
    expect(
      contractAssumptionsText({
        assumptions: [
          { category: 'technical', text: 'ใช้ SD-WAN' },
          {
            category: 'customer',
            text: 'เตรียม rack',
            owner: 'ไอทีลูกค้า',
            neededBy: '2026-11-01',
          },
          { category: 'constraint', text: 'ติดตั้งนอกเวลาทำการ' },
        ],
        feasibility: 'conditional',
        feasibilityNote: 'ลูกค้าอนุมัติ downtime 2 ชม.',
      }),
    ).toBe(
      [
        '1. [สิ่งที่ต้องพึ่งพาลูกค้า] เตรียม rack (ผู้รับผิดชอบ: ไอทีลูกค้า · ต้องพร้อมภายใน 2026-11-01)',
        '2. [ข้อจำกัด] ติดตั้งนอกเวลาทำการ',
        '3. [ทางเทคนิค] ใช้ SD-WAN',
        'เงื่อนไขความเป็นไปได้: ลูกค้าอนุมัติ downtime 2 ชม.',
      ].join('\n'),
    );
  });
});

describe('CD-140 clarification rules', () => {
  const row = (
    answer: string | null,
    affectsScope = false,
    scopeResolvedVersionNo: number | null = null,
  ) => ({ answer, affectsScope, scopeResolvedVersionNo });

  it('counts open questions and answers the SOW has not followed yet', () => {
    expect(
      clarificationCounts([
        row(null),
        row('ใช้ Fortinet'),
        row('เพิ่มสาขาที่ 13', true),
        row('ย้าย DC', true, 3),
      ]),
    ).toEqual({ total: 4, awaiting_answer: 1, scope_open: 1 });
  });

  it('an open scope change blocks approval', () => {
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'none' }, true, {
        scopeUpdates: 2,
      }),
    ).toBe('มีคำตอบที่กระทบขอบเขตยังไม่ได้แก้ SOW 2 ข้อ');
  });

  it('only a draft, or a version locked after the answer, can close a scope change', () => {
    const answered = {
      answerRecordedAt: new Date('2026-09-29T10:00:00Z'),
      answeredOnVersionNo: 2,
    };
    expect(
      scopeResolutionProblem(answered, {
        versionNo: 3,
        status: 'draft',
        lockedAt: null,
      }),
    ).toBeNull();
    expect(
      scopeResolutionProblem(answered, {
        versionNo: 2,
        status: 'locked',
        lockedAt: new Date('2026-09-29T11:00:00Z'),
      }),
    ).toBeNull();
    expect(
      scopeResolutionProblem(answered, {
        versionNo: 2,
        status: 'locked',
        lockedAt: new Date('2026-09-29T09:00:00Z'),
      }),
    ).toContain('ยืนยันก่อนได้คำตอบ');
    expect(
      scopeResolutionProblem(answered, {
        versionNo: 1,
        status: 'draft',
        lockedAt: null,
      }),
    ).toContain('เก่ากว่า');
  });

  it('the Q&A reads as text with respondent, date and scope impact', () => {
    expect(
      clarificationsText([
        {
          seq: 1,
          question: 'ใช้ firewall ยี่ห้อไหน',
          answer: 'Fortinet 100F',
          respondent: 'คุณเอ · IT Manager',
          answeredOn: new Date('2026-09-28T00:00:00Z'),
          affectsScope: true,
        },
        {
          seq: 2,
          question: 'มี UPS ไหม',
          answer: null,
          respondent: null,
          answeredOn: null,
          affectsScope: false,
        },
      ]),
    ).toBe(
      [
        '1. ถาม: ใช้ firewall ยี่ห้อไหน',
        '   ตอบ: Fortinet 100F (คุณเอ · IT Manager · 2026-09-28) — กระทบขอบเขต',
        '2. ถาม: มี UPS ไหม',
        '   (ยังไม่ได้คำตอบ)',
      ].join('\n'),
    );
  });
});

describe('CD-141 risk rules', () => {
  const risk = (
    likelihood: number,
    impact: number,
    status: 'open' | 'mitigated' | 'accepted' | 'closed' = 'open',
    owner = '',
    mitigation = '',
  ) => ({ likelihood, impact, status, owner, mitigation });

  it('the level follows the score at the agreed bands', () => {
    expect([1, 4, 5, 9, 10, 16, 20, 25].map(riskLevel)).toEqual([
      'low',
      'low',
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
    ]);
  });

  it('only an open high/critical risk without owner or plan needs one', () => {
    expect(
      riskCounts([
        risk(4, 4),
        risk(5, 5, 'open', 'ทีมเครือข่าย', 'สำรองอุปกรณ์'),
        risk(4, 5, 'accepted'),
        risk(2, 2),
        risk(3, 4, 'open', 'ทีมเครือข่าย'),
      ]),
    ).toEqual({ total: 5, open: 4, open_high: 3, needs_plan: 2 });
  });

  it('an unplanned serious risk blocks approval', () => {
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'none' }, true, {
        risksWithoutPlan: 1,
      }),
    ).toContain('ความเสี่ยงระดับสูง/วิกฤติ');
  });

  it('the register reads highest score first', () => {
    expect(
      risksText([
        { seq: 1, title: 'ISP ช้า', description: '', ...risk(2, 3) },
        {
          seq: 2,
          title: 'อุปกรณ์ขาดตลาด',
          description: '',
          ...risk(4, 5, 'open', 'จัดซื้อ', 'สั่งล่วงหน้า'),
        },
      ]),
    ).toBe(
      [
        '2. [วิกฤติ 20 = โอกาส 4 × ผลกระทบ 5 · เปิด] อุปกรณ์ขาดตลาด',
        '   แนวทางลด: สั่งล่วงหน้า',
        '   ผู้รับผิดชอบ: จัดซื้อ',
        '1. [ปานกลาง 6 = โอกาส 2 × ผลกระทบ 3 · เปิด] ISP ช้า',
      ].join('\n'),
    );
  });
});

describe('CD-139 demo rules', () => {
  it("the request's success criteria become the demo's list, one per line", () => {
    expect(
      criteriaFromText(
        '1. failover ภายใน 30 วินาที\n- ผ่าน firewall เดิม\n\n  ',
      ),
    ).toEqual([
      { text: 'failover ภายใน 30 วินาที', result: 'pending', note: '' },
      { text: 'ผ่าน firewall เดิม', result: 'pending', note: '' },
    ]);
  });

  it('nothing closes with equipment out; done needs every result and a summary', () => {
    const out = [{ name: 'FortiGate 100F', returnedOn: null }];
    expect(
      demoCloseGaps('cancelled', { criteria: [], outcome: '' }, out),
    ).toEqual(['ยังไม่คืนอุปกรณ์ 1 รายการ: FortiGate 100F']);
    expect(
      demoCloseGaps(
        'done',
        {
          criteria: [
            { text: 'failover', result: 'met', note: '' },
            { text: 'throughput', result: 'pending', note: '' },
          ],
          outcome: '',
        },
        [{ name: 'x', returnedOn: new Date() }],
      ),
    ).toEqual(['ยังไม่ได้บันทึกผลตามเกณฑ์ 1 ข้อ', 'ยังไม่ได้สรุปผล']);
    expect(
      demoCloseGaps(
        'done',
        {
          criteria: [{ text: 'a', result: 'not_met', note: '' }],
          outcome: 'ok',
        },
        [],
      ),
    ).toEqual([]);
  });

  it('counts equipment still out and findings still to work in', () => {
    expect(
      demoCounts([
        {
          status: 'planned',
          equipment: [{ returnedOn: null }, { returnedOn: new Date() }],
          findings: [
            { requiresChange: true, resolvedVersionNo: null },
            { requiresChange: true, resolvedVersionNo: 2 },
            { requiresChange: false, resolvedVersionNo: null },
          ],
        },
        { status: 'done', equipment: [], findings: [] },
      ]),
    ).toEqual({ total: 2, planned: 1, equipment_out: 1, findings_open: 1 });
  });

  it('an open demo finding blocks approval', () => {
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'none' }, true, {
        demoFindings: 1,
      }),
    ).toContain('ข้อค้นพบจาก Demo/POC');
  });

  it('the demos read as text with results and findings', () => {
    expect(
      demosText([
        {
          seq: 1,
          kind: 'poc',
          title: 'POC SD-WAN 2 สาขา',
          status: 'done',
          scheduledOn: new Date('2026-10-05T00:00:00Z'),
          criteria: [{ text: 'failover < 30s', result: 'met', note: '12s' }],
          outcome: 'ผ่าน',
          findings: [
            {
              text: 'ต้องเพิ่ม license',
              requiresChange: true,
              resolvedVersionNo: null,
            },
          ],
        },
      ]),
    ).toBe(
      [
        '1. [POC · จัดแล้ว · 2026-10-05] POC SD-WAN 2 สาขา',
        '   - failover < 30s: ผ่าน (12s)',
        '   สรุปผล: ผ่าน',
        '   ข้อค้นพบ: ต้องเพิ่ม license (ต้องปรับ Solution)',
      ].join('\n'),
    );
  });
});

describe('CD-138 TOR rules', () => {
  const clause = (
    mandatory: boolean,
    compliance: 'unanswered' | 'comply' | 'partial' | 'not_comply',
  ) => ({ mandatory, compliance });

  it('a mandatory clause gaps when unanswered or not complied; partial is answered but flagged', () => {
    expect(
      torCounts([
        clause(true, 'comply'),
        clause(true, 'partial'),
        clause(true, 'unanswered'),
        clause(true, 'not_comply'),
        clause(false, 'unanswered'),
      ]),
    ).toEqual({
      total: 5,
      mandatory: 4,
      mandatory_answered: 2,
      mandatory_gaps: 2,
      partial: 1,
      unanswered: 2,
    });
  });

  it('an open mandatory clause blocks approval', () => {
    expect(
      approvalBlocker({ status: 'locked', approvalStatus: 'none' }, true, {
        torMandatoryGaps: 3,
      }),
    ).toContain('ข้อบังคับของ TOR ยังไม่ครบ 3 ข้อ');
  });

  it('pasted clauses split off their numbers', () => {
    expect(
      clausesFromText(
        '3.2.1 รองรับ 13 สาขา\nข้อ 4 รับประกัน 3 ปี\n(ก) มีศูนย์บริการในประเทศ\n\nไม่มีเลขข้อ',
      ),
    ).toEqual([
      { clauseNo: '3.2.1', text: 'รองรับ 13 สาขา' },
      { clauseNo: '4', text: 'รับประกัน 3 ปี' },
      { clauseNo: '(ก)', text: 'มีศูนย์บริการในประเทศ' },
      { clauseNo: '', text: 'ไม่มีเลขข้อ' },
    ]);
  });

  it('the TOR reads as text with its facts and answers', () => {
    expect(
      torText(
        {
          buyer: 'กรมตัวอย่าง',
          projectNo: 'e-GP 123',
          submissionDeadline: new Date('2026-10-15T03:00:00Z'),
          bidBond: '5%',
        },
        [
          {
            seq: 1,
            clauseNo: '3.2.1',
            text: 'รองรับ 13 สาขา',
            mandatory: true,
            compliance: 'comply',
            response: 'รองรับ 20 สาขา',
            reference: 'SOW ข้อ 1',
          },
        ],
      ),
    ).toBe(
      [
        'ผู้ซื้อ: กรมตัวอย่าง',
        'เลขโครงการ: e-GP 123',
        'กำหนดยื่น: 2026-10-15 03:00',
        'หลักประกันซอง: 5%',
        '3.2.1. [บังคับ] รองรับ 13 สาขา — เป็นไปตาม',
        '   ตอบ: รองรับ 20 สาขา',
        '   อ้างอิง: SOW ข้อ 1',
      ].join('\n'),
    );
  });
});

describe('CD-135 BOQ rules', () => {
  it('a draft saves cleaned lines; blanks dropped; problems named by line', () => {
    const { lines, problems } = cleanBoq([
      {
        kind: 'equipment',
        product_code: ' FG-100F ',
        name: ' FortiGate 100F ',
        model: 'v7.2',
        quantity: 12,
        unit: 'เครื่อง',
        ref_unit_cost: 45000,
      },
      { kind: 'service', name: '', product_code: '', quantity: 1 },
      { kind: 'service', name: 'ติดตั้ง', quantity: 0 },
      { kind: 'magic', name: 'x', quantity: 1 },
      { kind: 'software', name: 'License', quantity: 1, ref_unit_cost: -1 },
    ]);
    expect(lines).toEqual([
      {
        kind: 'equipment',
        productCode: 'FG-100F',
        name: 'FortiGate 100F',
        description: '',
        model: 'v7.2',
        quantity: 12,
        unit: 'เครื่อง',
        refUnitCost: 45000,
      },
    ]);
    expect(problems).toEqual([
      'BOQ บรรทัด 3: จำนวนต้องมากกว่า 0',
      'BOQ บรรทัด 4: ไม่รู้จักประเภท "magic"',
      'BOQ บรรทัด 5: ต้นทุนอ้างอิงต้องไม่ติดลบ',
    ]);
  });

  it('handoff 3: a BOQ needs lines, and every line a code', () => {
    expect(boqGaps([])).toEqual(['ยังไม่มีรายการใน BOQ']);
    expect(
      boqGaps([
        { kind: 'equipment', productCode: 'FG', name: 'a', quantity: 1 },
        { kind: 'service', productCode: '', name: 'b', quantity: 1 },
      ]),
    ).toEqual(['BOQ บรรทัดที่ยังไม่มีรหัสสินค้า: 2']);
    expect(
      boqGaps([
        { kind: 'service', productCode: 'SVC-01', name: 'b', quantity: 1 },
      ]),
    ).toEqual([]);
  });

  it('the summary flags lines without a code or a reference cost, and totals the rest', () => {
    expect(
      boqSummary([
        {
          kind: 'equipment',
          productCode: 'FG',
          name: 'a',
          quantity: 2,
          refUnitCost: 100,
        },
        {
          kind: 'service',
          productCode: '',
          name: 'b',
          quantity: 3,
          refUnitCost: null,
        },
      ]),
    ).toEqual({ lines: 2, missing_code: 1, missing_cost: 1, ref_total: 200 });
  });

  it('the BOQ reads as text', () => {
    expect(
      boqText([
        {
          kind: 'equipment',
          productCode: 'FG-100F',
          name: 'FortiGate 100F',
          model: 'v7.2',
          quantity: 12,
          unit: 'เครื่อง',
          refUnitCost: 45000,
        },
        { kind: 'service', productCode: '', name: 'ติดตั้ง', quantity: 1 },
      ]),
    ).toBe(
      [
        '1. [อุปกรณ์] FG-100F FortiGate 100F · v7.2 × 12 เครื่อง · ต้นทุนอ้างอิง 45,000',
        '2. [งานบริการ] (ไม่มีรหัส) ติดตั้ง × 1 · ยังไม่มีต้นทุนอ้างอิง',
      ].join('\n'),
    );
  });
});
