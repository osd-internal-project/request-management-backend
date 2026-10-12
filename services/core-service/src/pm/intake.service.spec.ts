import type { Principal } from '@request-management/share';
import { IntakeService } from './intake.service';

const manager = {
  userId: 'u-pm',
  displayName: 'ผู้จัดการ',
  activeCompanyId: 'osd',
  permissions: [],
} as unknown as Principal;

const baseline = {
  contract: {
    contractNo: 'CTR-1',
    value: 1000,
    currency: 'THB',
    startOn: '2026-10-01',
    endOn: '2026-12-31',
    signedOn: '2026-09-30',
  },
  solution: { title: 'กล้อง', versionNo: 1 },
  scope: { inScope: ['a'], outOfScope: [], deliverables: ['b'] },
  boq: [{}],
  cost: { total: 500, missingCost: 0 },
  installments: [{ amount: 1000 }],
};

function harness(
  options: { status?: string; answers?: unknown[]; canEdit?: boolean } = {},
) {
  const intake = {
    id: 'in-1',
    status: options.status ?? 'pending',
    answers: options.answers ?? [],
    round: 0,
    history: [],
    acceptedBy: null,
    acceptedAt: null,
  };
  const project = {
    id: 'p-1',
    companyId: 'osd',
    projectNo: 'PRJ-1',
    name: 'โครงการ',
    contract: { contractNo: 'CTR-1', ownerUserId: 'u-legal' },
  };
  const projects = {
    access: jest.fn(() =>
      Promise.resolve({ project, canEdit: options.canEdit ?? true }),
    ),
    rebuildBaseline: jest.fn(() => Promise.resolve({ missing: [] })),
  };
  const projectRows = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        opportunityId: 'opp-1',
        solutionVersionId: 'v-1',
        baseline,
        missing: [],
      }),
    ),
  };
  const intakes = {
    findFirst: jest.fn(() => Promise.resolve(intake)),
    update: jest.fn(
      (args: { data: Record<string, unknown> }) => (
        Object.assign(intake, args.data),
        Promise.resolve({})
      ),
    ),
    updateMany: jest.fn(
      (args: { data: Record<string, unknown> }) => (
        Object.assign(intake, args.data),
        Promise.resolve({ count: 1 })
      ),
    ),
  };
  const handovers = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        status: 'accepted',
        round: 1,
        items: [],
        submittedBy: 'u-sales2',
      }),
    ),
  };
  const opportunities = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'opp-1',
        companyId: 'osd',
        customerId: 'c-1',
        opportunityCode: 'OPP-1',
        ownerUserId: 'u-sales',
      }),
    ),
  };
  const versions = {
    findFirst: jest.fn(() =>
      Promise.resolve({ createdBy: 'u-presales', lockedBy: 'u-presales' }),
    ),
  };
  const configs = {
    findFirst: jest.fn(() => Promise.resolve({ projectIntakeChecklist: [] })),
  };
  const people = { findMany: jest.fn(() => Promise.resolve([])) };
  const timeline = { publish: jest.fn(() => Promise.resolve()) };
  const notifications = {
    projectIntakeReturned: jest.fn(() => Promise.resolve()),
    projectIntakeAccepted: jest.fn(() => Promise.resolve()),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: (work: (tx: unknown) => Promise<unknown>) => work({}),
  };
  const service = new IntakeService(
    projects as never,
    projectRows as never,
    intakes as never,
    handovers as never,
    opportunities as never,
    versions as never,
    configs as never,
    people as never,
    timeline as never,
    notifications as never,
    audit as never,
    transactions as never,
  );
  return { service, intake, notifications, timeline, projects };
}

/** Mark every line as `result` through the service, as the manager would. */
async function answerAll(
  h: ReturnType<typeof harness>,
  result: 'ok' | 'incomplete',
  except: Record<string, string> = {},
) {
  const view = await h.service.view('p-1', manager);
  for (const line of view.lines) {
    const note = except[line.code];
    await h.service.answer(
      'p-1',
      note
        ? { code: line.code, result: 'incomplete', note }
        : { code: line.code, result },
      manager,
    );
  }
}

describe('CD-176 receiving the work', () => {
  it('received only once every line is correct, and Sales is told', async () => {
    const h = harness();
    await expect(h.service.accept('p-1', manager)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await answerAll(h, 'ok');
    const done = await h.service.accept('p-1', manager);
    expect(done.status).toBe('accepted');
    expect(h.notifications.projectIntakeAccepted).toHaveBeenCalledWith(
      'u-sales',
      'osd',
      expect.anything(),
    );
    expect(h.timeline.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        refType: 'opportunity',
        eventType: 'opportunity.project_intake_accepted',
      }),
      expect.anything(),
    );
  });

  it('an incomplete line needs a reason', async () => {
    const h = harness();
    await expect(
      h.service.answer(
        'p-1',
        { code: 'technical.boq', result: 'incomplete' },
        manager,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('sent back: each side gets only its own gaps', async () => {
    const h = harness();
    await answerAll(h, 'ok', {
      'technical.boq': 'ขาดสาย LAN',
      'sales.handover': 'ไม่มีผู้ติดต่อ',
      'contract.installments': 'งวดไม่ตรง SOW',
    });
    const back = await h.service.returnWork('p-1', {}, manager);
    expect(back.status).toBe('returned');
    expect(back.round).toBe(1);
    const told = h.notifications.projectIntakeReturned.mock.calls.map(
      (call) => {
        const [userId, , input] = call as unknown as [
          string,
          string,
          { gaps: string },
        ];
        return [userId, input.gaps];
      },
    );
    expect(told).toEqual(
      expect.arrayContaining([
        ['u-sales', 'งานส่งมอบจากทีมขาย — ไม่มีผู้ติดต่อ'],
        ['u-sales2', 'งานส่งมอบจากทีมขาย — ไม่มีผู้ติดต่อ'],
        ['u-presales', 'BOQ และต้นทุน — ขาดสาย LAN'],
        ['u-legal', 'แผนงวดวางบิล — งวดไม่ตรง SOW'],
      ]),
    );
    expect(told).toHaveLength(4);
  });

  it('nothing marked incomplete → nothing to send back', async () => {
    const h = harness();
    await expect(
      h.service.returnWork('p-1', {}, manager),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('only the manager, and not after it is received', async () => {
    await expect(
      harness({ canEdit: false }).service.accept('p-1', manager),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      harness({ status: 'accepted' }).service.refresh('p-1', manager),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('taking the baseline again keeps the work waiting and is recorded', async () => {
    const h = harness({ status: 'returned' });
    const view = await h.service.refresh('p-1', manager);
    expect(h.projects.rebuildBaseline).toHaveBeenCalledWith(
      'p-1',
      'osd',
      expect.any(Date),
    );
    expect(view.status).toBe('returned');
    expect(view.history[0]).toMatchObject({ action: 'refreshed' });
  });
});
