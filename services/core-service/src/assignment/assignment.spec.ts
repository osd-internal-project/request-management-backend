import { AssignmentService } from './assignment.service';
import {
  cleanConditions,
  pickCandidate,
  ruleMatches,
} from './assignment-rules';

const actor = {
  userId: 'svc-workflow',
  activeCompanyId: 'osd',
  isServiceAccount: true,
  permissions: ['integration.process.dispatch', 'integration.crm.lead.read.all'],
} as never;

const person = (id: string) => ({
  id,
  email: `${id}@osd.co.th`,
  displayName: `คุณ ${id}`,
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'rule-bank',
  companyId: 'osd',
  role: 'sales',
  name: 'ลูกค้าธนาคาร → ทีมขายองค์กร',
  orgUnitId: 'unit-corp',
  conditions: { industry: ['ธนาคาร'] },
  sortOrder: 0,
  active: true,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
  ...over,
});

function build(opts: {
  rules?: ReturnType<typeof rule>[];
  members?: Record<string, ReturnType<typeof person>[]>;
  managers?: Record<string, string | null>;
  fallbackUserId?: string | null;
  loads?: Record<string, number>;
  last?: Record<string, Date>;
  leave?: string[];
  lead?: Record<string, unknown> | null;
  earlier?: Record<string, unknown> | null;
  history?: Record<string, unknown>[];
}) {
  const members = opts.members ?? {};
  const people = Object.values(members).flat();
  const created: Record<string, unknown>[] = [];
  const rules = { findMany: jest.fn(async () => opts.rules ?? []) };
  const roleSettings = {
    findFirst: jest.fn(async () =>
      opts.fallbackUserId === undefined
        ? null
        : { fallbackUserId: opts.fallbackUserId, loadTypeCodes: [] },
    ),
  };
  const assignments = {
    findFirst: jest.fn(async () => opts.earlier ?? null),
    findMany: jest.fn(async () => opts.history ?? []),
    lastAssigned: jest.fn(
      async () => new Map(Object.entries(opts.last ?? {})),
    ),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return { id: 'asg-1', createdAt: new Date(), ...data };
    }),
  };
  const refs = {
    members: jest.fn(async (_c: string, unit: string) => members[unit] ?? []),
    person: jest.fn(
      async (_c: string, id: string) =>
        people.find((p) => p.id === id) ??
        (id.startsWith('mgr') || id.startsWith('fb') ? person(id) : null),
    ),
    managerOf: jest.fn(async (_c: string, unit: string) => ({
      managerUserId: opts.managers?.[unit] ?? null,
      name: unit,
      active: true,
    })),
    salesLoad: jest.fn(async () => new Map(Object.entries(opts.loads ?? {}))),
    requestLoad: jest.fn(async () => new Map()),
    projectLoad: jest.fn(async () => new Map()),
  };
  const leads = {
    findFirst: jest.fn(async () =>
      opts.lead === undefined
        ? {
            id: 'lead-1',
            name: 'ธนาคารกรุงทอง',
            ownerUserId: null,
            industry: 'ธนาคาร',
            productGroup: null,
            companySize: null,
            province: null,
          }
        : opts.lead,
    ),
    findMany: jest.fn(async () => [{ id: 'lead-1', name: 'ธนาคารกรุงทอง' }]),
  };
  const leadsService = { assign: jest.fn(async () => ({})) };
  const availability = {
    availabilityFor: jest.fn(
      async (_c: string, ids: string[]) =>
        new Map(
          ids.map((id) => [
            id,
            [
              {
                capacity: 8,
                leaveHours: opts.leave?.includes(id) ? 8 : 0,
              },
            ],
          ]),
        ),
    ),
  };
  const notifications = { workflowNotice: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new AssignmentService(
    rules as never,
    roleSettings as never,
    assignments as never,
    refs as never,
    leads as never,
    leadsService as never,
    availability as never,
    notifications as never,
    audit as never,
  );
  return { service, created, leadsService, notifications, refs };
}

const leadWork = (over: Record<string, unknown> = {}) => ({
  role: 'sales',
  resource_type: 'lead',
  resource_id: 'lead-1',
  ...over,
});

describe('team table rules', () => {
  it('a rule matches when every field it names holds one of its values', () => {
    expect(ruleMatches({ industry: ['ธนาคาร'] }, { industry: ' ธนาคาร ' })).toBe(true);
    expect(ruleMatches({ industry: ['ธนาคาร'] }, { industry: 'ค้าปลีก' })).toBe(false);
    expect(ruleMatches({ productGroup: ['Network'] }, { productGroup: 'network' })).toBe(true);
  });

  it('work without the field fails the rule; no conditions catches everything', () => {
    expect(ruleMatches({ industry: ['ธนาคาร'] }, {})).toBe(false);
    expect(ruleMatches({}, {})).toBe(true);
  });

  it('keeps only the role’s own fields and drops empty lists', () => {
    expect(
      cleanConditions('sales', {
        industry: [' ธนาคาร ', 'ธนาคาร', ''],
        severity: ['critical'],
        province: [],
      }),
    ).toEqual({ industry: ['ธนาคาร'] });
  });

  it('least open work first, then whoever waited longest, never-assigned first', () => {
    const old = new Date('2026-10-01T00:00:00Z');
    const recent = new Date('2026-11-01T00:00:00Z');
    expect(
      pickCandidate([
        { userId: 'a', open: 3, lastAssignedAt: null },
        { userId: 'b', open: 1, lastAssignedAt: recent },
        { userId: 'c', open: 1, lastAssignedAt: old },
      ])?.userId,
    ).toBe('c');
    expect(
      pickCandidate([
        { userId: 'b', open: 1, lastAssignedAt: old },
        { userId: 'c', open: 1, lastAssignedAt: null },
      ])?.userId,
    ).toBe('c');
  });
});

describe('AssignmentService.assign', () => {
  it('a bank Lead goes to the corporate team member with the least open work, and becomes theirs', async () => {
    const { service, created, leadsService, notifications } = build({
      rules: [rule()],
      members: { 'unit-corp': [person('u1'), person('u2')] },
      loads: { u1: 4, u2: 1 },
    });
    const out = await service.assign(leadWork(), actor);
    expect(out).toMatchObject({
      user_id: 'u2',
      user_email: 'u2@osd.co.th',
      reason: 'matched',
      rule_id: 'rule-bank',
      applied: true,
      replayed: false,
    });
    expect(leadsService.assign).toHaveBeenCalledWith(
      'lead-1',
      { owner_user_id: 'u2' },
      actor,
    );
    expect(created[0]).toMatchObject({ companyId: 'osd', userId: 'u2', reason: 'matched' });
    expect(notifications.workflowNotice).toHaveBeenCalledWith(
      'u2',
      'osd',
      'workflow.assigned',
      expect.objectContaining({ subject: 'Lead ธนาคารกรุงทอง' }),
      { type: 'lead', id: 'lead-1' },
    );
  });

  it('skips people on full-day leave', async () => {
    const { service } = build({
      rules: [rule()],
      members: { 'unit-corp': [person('u1'), person('u2')] },
      loads: { u1: 4, u2: 1 },
      leave: ['u2'],
    });
    expect((await service.assign(leadWork(), actor)).user_id).toBe('u1');
  });

  it('a matching team with nobody available falls through to the next matching rule', async () => {
    const { service } = build({
      rules: [rule(), rule({ id: 'rule-any', orgUnitId: 'unit-sme', conditions: {} })],
      members: { 'unit-corp': [person('u1')], 'unit-sme': [person('s1')] },
      leave: ['u1'],
    });
    const out = await service.assign(leadWork(), actor);
    expect(out).toMatchObject({ user_id: 's1', rule_id: 'rule-any' });
  });

  it('no matching rule → the role’s fallback person (the Sales Manager)', async () => {
    const { service } = build({
      rules: [rule()],
      lead: {
        id: 'lead-1',
        ownerUserId: null,
        industry: 'ค้าปลีก',
        productGroup: null,
        companySize: null,
        province: null,
      },
      fallbackUserId: 'fb-manager',
    });
    expect(await service.assign(leadWork(), actor)).toMatchObject({
      user_id: 'fb-manager',
      reason: 'fallback',
      rule_id: null,
    });
  });

  it('no fallback set → the matched team’s head; nobody at all → CONFLICT', async () => {
    const withHead = build({
      rules: [rule()],
      members: { 'unit-corp': [person('u1')] },
      leave: ['u1'],
      managers: { 'unit-corp': 'mgr-corp' },
    });
    expect((await withHead.service.assign(leadWork(), actor)).user_id).toBe('mgr-corp');

    const empty = build({ rules: [rule()] });
    await expect(empty.service.assign(leadWork(), actor)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('a Lead that already has an owner keeps it — nothing written, nobody notified', async () => {
    const { service, created, leadsService, notifications } = build({
      rules: [rule()],
      members: { 'unit-corp': [person('u1')] },
      lead: {
        id: 'lead-1',
        ownerUserId: 'u9',
        industry: 'ธนาคาร',
        productGroup: null,
        companySize: null,
        province: null,
      },
    });
    expect(await service.assign(leadWork(), actor)).toMatchObject({
      user_id: 'u9',
      reason: 'kept',
      applied: false,
    });
    expect(created).toHaveLength(0);
    expect(leadsService.assign).not.toHaveBeenCalled();
    expect(notifications.workflowNotice).not.toHaveBeenCalled();
  });

  it('the same request_key answers the earlier result without picking again', async () => {
    const { service, created, leadsService } = build({
      rules: [rule()],
      members: { 'unit-corp': [person('u1')] },
      earlier: {
        id: 'asg-0',
        role: 'sales',
        resourceType: 'lead',
        resourceId: 'lead-1',
        userId: 'u1',
        ruleId: 'rule-bank',
        orgUnitId: 'unit-corp',
        reason: 'matched',
        criteria: {},
        createdAt: new Date(),
      },
    });
    const out = await service.assign(leadWork({ request_key: 'inst-1:assign' }), actor);
    expect(out).toMatchObject({ assignment_id: 'asg-0', user_id: 'u1', replayed: true });
    expect(created).toHaveLength(0);
    expect(leadsService.assign).not.toHaveBeenCalled();
  });

  it('another company’s Lead answers 404 (SCOPE-03)', async () => {
    const { service } = build({ rules: [rule()], lead: null });
    await expect(service.assign(leadWork(), actor)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a non-lead resource gets a pick but no owner is written', async () => {
    const { service, leadsService } = build({
      rules: [rule({ role: 'presales', conditions: {} })],
      members: { 'unit-corp': [person('p1')] },
    });
    const out = await service.assign(
      { role: 'presales', resource_type: 'request', resource_id: 'req-1' },
      actor,
    );
    expect(out).toMatchObject({ user_id: 'p1', applied: false });
    expect(leadsService.assign).not.toHaveBeenCalled();
  });
});

describe('AssignmentService.notify', () => {
  it('tells a person of the key’s company, linked by document', async () => {
    const { service, notifications } = build({ members: { u: [person('u1')] } });
    await service.notify(
      {
        user_id: 'u1',
        title: 'NDA ลงนามครบแล้ว',
        resource_type: 'opportunity',
        resource_id: 'opp-1',
      },
      actor,
    );
    expect(notifications.workflowNotice).toHaveBeenCalledWith(
      'u1',
      'osd',
      'workflow.notice',
      { title: 'NDA ลงนามครบแล้ว', body: '' },
      { type: 'opportunity', id: 'opp-1' },
    );
  });

  it('someone outside the company answers 404; a half link is refused', async () => {
    const { service } = build({ members: { u: [person('u1')] } });
    await expect(
      service.notify({ user_id: 'stranger', title: 'x' }, actor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.notify({ user_id: 'u1', title: 'x', resource_type: 'lead' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('history names a Lead by its name, other work by type and id', async () => {
    const row = (resourceType: string, resourceId: string) => ({
      id: `a-${resourceId}`,
      role: 'sales',
      resourceType,
      resourceId,
      userId: 'u1',
      ruleId: null,
      orgUnitId: null,
      reason: 'fallback',
      criteria: {},
      createdAt: new Date('2026-11-02T09:00:00Z'),
    });
    const { service } = build({ history: [row('lead', 'lead-1'), row('request', 'req-9')] });
    const out = await service.history(actor);
    expect(out.map((r) => r.resource_label)).toEqual([
      'Lead ธนาคารกรุงทอง',
      'request req-9',
    ]);
  });
});
