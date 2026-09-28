import { AppError } from '@request-management/share';
import {
  answersOf,
  assertPublishable,
  assertStepExitable,
  backwardOptions,
  evaluateCondition,
  firstStep,
  isLastStep,
  nextForward,
  type Flow,
  type FlowStep,
  type FlowTransition,
} from './request-flow';

function step(
  code: string,
  sortOrder: number,
  overrides: Partial<FlowStep> = {},
): FlowStep {
  return {
    code,
    name: code,
    sortOrder,
    formSchema: null,
    subRequestTypes: [],
    requiresApproval: false,
    assigneeRule: null,
    slaHours: null,
    ...overrides,
  };
}

function exit(
  fromStepCode: string,
  toStepCode: string,
  sortOrder: number,
  overrides: Partial<FlowTransition> = {},
): FlowTransition {
  return {
    fromStepCode,
    toStepCode,
    sortOrder,
    condition: null,
    backward: false,
    ...overrides,
  };
}

/** ① ตรวจเอกสาร → ② ติดตั้ง → (amount > 1M ? ④ อนุมัติพิเศษ : ③ ทดสอบ); ③ ↩ ①; ④ → ③ */
const INSTALL_FLOW: Flow = {
  steps: [
    step('DOCS', 1),
    step('INSTALL', 2),
    step('TEST', 3),
    step('SPECIAL', 4),
  ],
  transitions: [
    exit('DOCS', 'INSTALL', 1),
    exit('INSTALL', 'SPECIAL', 1, {
      condition: { field: 'amount', op: 'gt', value: 1_000_000 },
    }),
    exit('INSTALL', 'TEST', 2),
    exit('SPECIAL', 'TEST', 1),
    exit('TEST', 'DOCS', 1, { backward: true }),
  ],
};

function refusal(work: () => void): AppError {
  try {
    work();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('request flow: walking the steps', () => {
  it('starts at the lowest sortOrder and finishes where no forward exit leaves', () => {
    expect(firstStep(INSTALL_FLOW).code).toBe('DOCS');
    expect(isLastStep(INSTALL_FLOW, 'TEST')).toBe(true);
    expect(isLastStep(INSTALL_FLOW, 'INSTALL')).toBe(false);
  });

  it('takes the first forward exit whose condition holds', () => {
    expect(nextForward(INSTALL_FLOW, 'INSTALL', { amount: 2_000_000 })).toBe(
      'SPECIAL',
    );
  });

  it('falls through to the unconditional exit otherwise', () => {
    expect(nextForward(INSTALL_FLOW, 'INSTALL', { amount: 500 })).toBe('TEST');
    expect(nextForward(INSTALL_FLOW, 'INSTALL', {})).toBe('TEST');
  });

  it('offers only the backward exits the admin configured', () => {
    expect(backwardOptions(INSTALL_FLOW, 'TEST')).toEqual(['DOCS']);
    expect(backwardOptions(INSTALL_FLOW, 'INSTALL')).toEqual([]);
  });
});

describe('request flow: conditions', () => {
  it.each([
    ['gt', 10, 5, true],
    ['gte', 5, 5, true],
    ['lt', 5, 10, true],
    ['lte', 10, 5, false],
    ['eq', 'urgent', 'urgent', true],
    ['neq', 'urgent', 'normal', true],
    ['in', 'B', ['A', 'B'], true],
    ['gt', 'not-a-number', 5, false],
  ] as const)('%s: %p against %p → %p', (op, actual, value, expected) => {
    expect(evaluateCondition({ field: 'x', op, value }, { x: actual })).toBe(
      expected,
    );
  });

  it('treats an unanswered field as not matching', () => {
    expect(evaluateCondition({ field: 'x', op: 'neq', value: 'a' }, {})).toBe(
      false,
    );
  });

  it('lets a later step answer override the requester form', () => {
    expect(answersOf({ amount: 1 }, { INSTALL: { amount: 9 } })).toEqual({
      amount: 9,
    });
  });
});

describe('request flow: leaving a step forward', () => {
  const withForm = step('INSTALL', 2, {
    formSchema: {
      required: ['serial'],
      properties: { serial: { type: 'string', title: 'Serial' } },
    },
    subRequestTypes: [{ code: 'IT_ACCOUNT', required: true }],
  });

  it('refuses while the step form is incomplete', () => {
    expect(refusal(() => assertStepExitable(withForm, {}, [])).code).toBe(
      'REQ_FIELD_MISSING',
    );
  });

  it('refuses while a required child of this step was never raised', () => {
    const child = {
      typeCode: 'IT_ACCOUNT',
      status: 'closed',
      parentStepCode: 'DOCS',
      requestNo: 'X',
    };
    expect(
      refusal(() => assertStepExitable(withForm, { serial: 'S1' }, [child]))
        .code,
    ).toBe('REQ_SUB_REQUEST_MISSING');
  });

  it('refuses while a child of this step is still open', () => {
    const child = {
      typeCode: 'IT_ACCOUNT',
      status: 'in_progress',
      parentStepCode: 'INSTALL',
      requestNo: 'X',
    };
    expect(
      refusal(() => assertStepExitable(withForm, { serial: 'S1' }, [child]))
        .code,
    ).toBe('REQ_CHILDREN_OPEN');
  });

  it('lets the work move on once all three hold', () => {
    const child = {
      typeCode: 'IT_ACCOUNT',
      status: 'closed',
      parentStepCode: 'INSTALL',
      requestNo: 'X',
    };
    expect(() =>
      assertStepExitable(withForm, { serial: 'S1' }, [child]),
    ).not.toThrow();
  });
});

describe('request flow: what an admin may publish', () => {
  const fields = ['amount'];

  function reasons(flow: Flow): string[] {
    return (refusal(() => assertPublishable(flow, fields)).details ?? []).map(
      (detail) => detail.reason,
    );
  }

  it('accepts the install flow', () => {
    expect(() => assertPublishable(INSTALL_FLOW, fields)).not.toThrow();
  });

  it('refuses an empty flow', () => {
    expect(reasons({ steps: [], transitions: [] })).toContain(
      'ต้องมีอย่างน้อยหนึ่งขั้น',
    );
  });

  it('refuses duplicate and malformed codes', () => {
    const flow = {
      steps: [step('A', 1), step('A', 2), step('bad code', 3)],
      transitions: [],
    };
    expect(reasons(flow)).toEqual(
      expect.arrayContaining(['รหัสซ้ำ: A', 'ใช้ A-Z 0-9 _ ไม่เกิน 32 ตัว']),
    );
  });

  it('refuses a branch without an unconditional fallback', () => {
    const flow: Flow = {
      steps: [step('A', 1), step('B', 2)],
      transitions: [
        exit('A', 'B', 1, {
          condition: { field: 'amount', op: 'gt', value: 1 },
        }),
      ],
    };
    expect(reasons(flow)).toContain('ทางออกสุดท้ายต้องไม่มีเงื่อนไข');
  });

  it('refuses a condition on a field no form asks for', () => {
    const flow: Flow = {
      steps: [step('A', 1), step('B', 2), step('C', 3)],
      transitions: [
        exit('A', 'B', 1, {
          condition: { field: 'ghost', op: 'eq', value: 1 },
        }),
        exit('A', 'C', 2),
      ],
    };
    expect(reasons(flow)).toContain('ไม่มีช่อง "ghost" ในฟอร์ม');
  });

  it('refuses a step nothing leads to', () => {
    const flow: Flow = {
      steps: [step('A', 1), step('ORPHAN', 2)],
      transitions: [],
    };
    expect(reasons(flow)).toContain('ไม่มีทางมาถึงขั้นนี้');
  });

  it('refuses a forward loop — going back is what backward exits are for', () => {
    const flow: Flow = {
      steps: [step('A', 1), step('B', 2)],
      transitions: [exit('A', 'B', 1), exit('B', 'A', 1)],
    };
    expect(reasons(flow)).toContain('ทางไปข้างหน้าวนกลับ — ใช้ทางย้อนกลับแทน');
  });
});
