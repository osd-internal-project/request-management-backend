import { Principal } from '@request-management/share';
import { LeadWorkflowService } from './lead-workflow.service';
import type { LeadStatusRow } from './lead-status.service';

function status(over: Partial<LeadStatusRow> = {}): LeadStatusRow {
  return {
    id: 'st-1',
    companyId: 'osd',
    code: 'contacted',
    nameTh: 'ติดต่อแล้ว',
    kind: 'open',
    color: 'blue',
    isDefault: false,
    isSystem: false,
    active: true,
    sortOrder: 2,
    ...over,
  };
}

/** service account ของ workflow — ถือ integration.* และอ่านได้ทั้งบริษัท. */
function robot(
  permissions: string[] = [
    'integration.crm.lead.read',
    'integration.crm.lead.stage',
    'crm.sales.read.all',
  ],
): Principal {
  return {
    userId: 'svc-workflow',
    displayName: 'OSD Workflow',
    activeCompanyId: 'osd',
    orgUnitId: null,
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions,
  } as unknown as Principal;
}

function harness(
  options: {
    lead?: Record<string, unknown> | null;
    completed?: number;
    pending?: number;
    /** CD-85 — completed contacts (call/email/meeting/visit/line/social). */
    contacts?: number;
    discoveryRequired?: boolean;
    rows?: LeadStatusRow[];
  } = {},
) {
  const audits: { eventType: string; after?: Record<string, unknown> }[] = [];

  const lead =
    options.lead === undefined
      ? {
          id: 'lead-1',
          companyId: 'osd',
          name: 'บริษัท มุ่งหวัง จำกัด',
          status: 'contacted',
          ownerUserId: 'sales-1',
          convertedOpportunityId: null,
        }
      : options.lead;

  const rows = options.rows ?? [
    status(),
    status({
      id: 'st-2',
      code: 'qualified',
      nameTh: 'ผ่านคัดกรอง',
      sortOrder: 3,
    }),
    status({
      id: 'st-3',
      code: 'converted',
      nameTh: 'แปลงเป็นโอกาสการขาย',
      kind: 'won',
      isSystem: true,
    }),
    status({
      id: 'st-4',
      code: 'paused',
      nameTh: 'พักไว้',
      active: false,
    }),
  ];

  /* ตัวกรองที่ service สร้างจริง — เก็บไว้ตรงนี้แทนการงัดจาก `mock.calls`
     ซึ่ง strict mode ปฏิเสธการ index. */
  let lastWhere: Record<string, unknown> | undefined;
  let lastUpdate: Record<string, unknown> | undefined;
  const leads = {
    findFirst: jest.fn((args: { where: Record<string, unknown> }) => {
      lastWhere = args.where;
      return Promise.resolve(lead);
    }),
    update: jest.fn((args: { data: Record<string, unknown> }) => {
      lastUpdate = args.data;
      return Promise.resolve({});
    }),
  };
  const activities = {
    count: jest.fn(
      (args: { where: { completedAt: unknown; type?: unknown } }) =>
        Promise.resolve(
          args.where.type
            ? (options.contacts ?? 0)
            : args.where.completedAt === null
              ? (options.pending ?? 2)
              : (options.completed ?? 1),
        ),
    ),
  };
  const statuses = {
    require: jest.fn((_companyId: string, code: string) => {
      const found = rows.find((row) => row.code === code);
      if (!found) {
        return Promise.reject(
          Object.assign(new Error('ไม่พบสถานะ Lead ที่ระบุ'), {
            code: 'VALIDATION_FAILED',
          }),
        );
      }
      return Promise.resolve(found);
    }),
  };
  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };

  const service = new LeadWorkflowService(
    leads as never,
    activities as never,
    statuses as never,
    audit as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.discoveryRequired === undefined
            ? null
            : { discoveryRequired: options.discoveryRequired },
        ),
      ),
    } as never,
    { emit: jest.fn(() => Promise.resolve()) } as never,
  );

  return {
    service,
    leads,
    activities,
    audits,
    whereUsed: () => lastWhere,
    updateData: () => lastUpdate,
  };
}

describe('LeadWorkflowService — หน้าต่างที่ workflow engine เรียกเข้ามา', () => {
  it('facts: คืนสถานะ + จำนวนกิจกรรมที่ทำเสร็จ (นับเฉพาะ completedAt ไม่ว่าง)', async () => {
    const { service, activities } = harness({ completed: 3, pending: 1 });

    const facts = await service.facts('lead-1', robot());

    expect(facts).toMatchObject({
      lead_id: 'lead-1',
      status: 'contacted',
      status_kind: 'open',
      open: true,
      completed_activity_count: 3,
      pending_activity_count: 1,
    });
    expect(activities.count).toHaveBeenCalledWith({
      where: { leadId: 'lead-1', completedAt: { not: null } },
    });
  });

  it('CD-85 facts: Discovery ครบไหม ขาดอะไร บริษัทต้องการไหม และจำนวนครั้งที่ติดต่อ — workflow ตัดสินเอง', async () => {
    const empty = harness({ contacts: 2, discoveryRequired: true });
    await expect(empty.service.facts('lead-1', robot())).resolves.toMatchObject(
      {
        contact_attempt_count: 2,
        discovery_complete: false,
        discovery_missing: ['need', 'budget', 'decision_maker', 'timeframe'],
        discovery_required: true,
      },
    );

    const done = harness({
      lead: {
        id: 'lead-1',
        companyId: 'osd',
        name: 'x',
        status: 'contacted',
        ownerUserId: 'sales-1',
        convertedOpportunityId: null,
        discoveryNeed: 'ระบบโทรศัพท์เก่า',
        discoveryBudget: null,
        discoveryBudgetNote: 'ไม่เปิดเผย อยู่ในงบปีหน้า',
        discoveryDecisionMaker: 'ผอ. ไอที',
        discoveryTimeframe: new Date('2026-12-31T00:00:00Z'),
      },
    });
    await expect(done.service.facts('lead-1', robot())).resolves.toMatchObject({
      discovery_complete: true,
      discovery_missing: [],
      // no CRM config row = the standard: not required
      discovery_required: false,
    });
  });

  it('facts: Lead ที่ปิดแล้วตอบ open=false — workflow ตัดสินใจเองว่าจะทำยังไงต่อ', async () => {
    const { service } = harness({
      lead: {
        id: 'lead-1',
        companyId: 'osd',
        name: 'ปิดแล้ว',
        status: 'converted',
        ownerUserId: 'sales-1',
        convertedOpportunityId: 'opp-1',
      },
    });

    const facts = await service.facts('lead-1', robot());

    expect(facts.open).toBe(false);
    expect(facts.status_kind).toBe('won');
  });

  it('applyStage: เขียนสถานะที่ workflow สั่ง + audit crm.lead.stage_applied พร้อม instance', async () => {
    const { service, audits, updateData } = harness();

    const result = await service.applyStage(
      'lead-1',
      { stage: 'qualified', instance_id: 'wfi-77', reason: 'มีกิจกรรมแล้ว' },
      robot(),
    );

    expect(result).toEqual({
      lead_id: 'lead-1',
      status: 'qualified',
      changed: true,
    });
    expect(updateData()).toMatchObject({ status: 'qualified' });
    expect(audits[0].eventType).toBe('crm.lead.stage_applied');
    expect(audits[0].after).toMatchObject({
      status: 'qualified',
      instanceId: 'wfi-77',
    });
  });

  it('applyStage: core ไม่ตัดสินกฎ — เลื่อนถอยหลังหรือข้ามขั้นก็ยอม', async () => {
    const { service, leads } = harness({
      lead: {
        id: 'lead-1',
        companyId: 'osd',
        name: 'x',
        status: 'qualified',
        ownerUserId: 'sales-1',
        convertedOpportunityId: null,
      },
      completed: 0,
    });

    // ถอยจาก ผ่านคัดกรอง กลับไป ติดต่อแล้ว โดยไม่มีกิจกรรมเลย — ไม่ใช่เรื่องของ core
    await expect(
      service.applyStage('lead-1', { stage: 'contacted' }, robot()),
    ).resolves.toMatchObject({ status: 'contacted', changed: true });
    expect(leads.update).toHaveBeenCalled();
  });

  it('applyStage: สั่งซ้ำขั้นเดิม = ไม่เขียน ไม่ลง audit (HTTP task retry ได้)', async () => {
    const { service, leads, audits } = harness();

    const result = await service.applyStage(
      'lead-1',
      { stage: 'contacted' },
      robot(),
    );

    expect(result).toEqual({
      lead_id: 'lead-1',
      status: 'contacted',
      changed: false,
    });
    expect(leads.update).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
  });

  it('applyStage: เขียนทับ Lead ที่ปิดแล้วไม่ได้ — integrity ของข้อมูล', async () => {
    const { service, leads } = harness({
      lead: {
        id: 'lead-1',
        companyId: 'osd',
        name: 'x',
        status: 'converted',
        ownerUserId: 'sales-1',
        convertedOpportunityId: 'opp-1',
      },
    });

    await expect(
      service.applyStage('lead-1', { stage: 'qualified' }, robot()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('applyStage: เลื่อนเข้าปลายทางตรง ๆ ไม่ได้ — ต้องมาจาก convert/disqualify', async () => {
    const { service, leads } = harness();

    await expect(
      service.applyStage('lead-1', { stage: 'converted' }, robot()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('applyStage: สถานะที่ถูกปิดใช้งานอยู่ เลื่อนเข้าไม่ได้', async () => {
    const { service } = harness();

    await expect(
      service.applyStage('lead-1', { stage: 'paused' }, robot()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('applyStage: รหัสสถานะที่ไม่มีในบริษัทนี้ = VALIDATION_FAILED', async () => {
    const { service } = harness();

    await expect(
      service.applyStage('lead-1', { stage: 'ไม่มีจริง' }, robot()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('SCOPE-03: Lead ของบริษัทอื่น (มองไม่เห็น) ตอบ 404 ไม่ใช่ 403 ทั้งอ่านและเขียน', async () => {
    const { service, leads } = harness({ lead: null });

    await expect(service.facts('lead-1', robot())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      service.applyStage('lead-1', { stage: 'qualified' }, robot()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('SCOPE-03: key ที่ถือ integration.crm.lead.read เห็นทั้งบริษัท แต่ไม่ข้ามบริษัท (22 ต.ค. 2569)', async () => {
    const { service, whereUsed } = harness();

    await service.facts('lead-1', robot(['integration.crm.lead.read']));

    // เครื่องทำงานแทนบริษัท ไม่มีขอบเขตของคนให้ยืม — เดิมแคบเป็นเจ้าของ/ผู้สร้าง
    // จนใบที่เซลล์รับไปแล้วตอบ 404
    const where = whereUsed() as { AND: Record<string, unknown>[] };
    expect(where.AND[0]).toEqual({ companyId: 'osd' });
  });

  it('SCOPE-02: ผู้เรียกที่ไม่ได้ถือ lead.read หรือ crm.sales.read.all ถูกจำกัดด้วยตัวกรองเดียวกับหน้าจอ', async () => {
    const { service, whereUsed } = harness();

    await service.applyStage(
      'lead-1',
      { stage: 'contacted' },
      robot(['integration.crm.lead.stage']),
    );

    const where = whereUsed() as { AND: Record<string, unknown>[] };
    expect(where.AND[0]).toMatchObject({
      companyId: 'osd',
      OR: [
        { ownerUserId: 'svc-workflow' },
        { createdBy: 'svc-workflow' },
        // กองกลาง — ใบที่ยังไม่มีเจ้าของอยู่ในขอบเขตของทุกคนในบริษัทนั้น
        { ownerUserId: null },
      ],
    });
  });
});
