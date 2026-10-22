import { LeadWorkflowSyncService } from './lead-workflow-sync.service';

type Job = {
  id: string;
  resourceId: string;
  attempts: number;
  status?: string;
  lastError?: string | null;
  runAfter?: Date;
};

function harness(
  options: {
    lead?: Record<string, unknown> | null;
    startFails?: string;
    queue?: Job[];
    /** the company set "สร้าง Lead" up in admin/workflow-triggers */
    movedToTriggers?: boolean;
  } = {},
) {
  const audits: { eventType: string; after?: Record<string, unknown> }[] = [];
  const created: Record<string, unknown>[] = [];
  const jobUpdates: { id: string; data: Record<string, unknown> }[] = [];

  const lead =
    options.lead === undefined
      ? {
          id: 'lead-1',
          companyId: 'osd',
          name: 'บริษัท มุ่งหวัง จำกัด',
          workflowInstanceId: null,
        }
      : options.lead;

  const leads = {
    findFirst: jest.fn(() => Promise.resolve(lead)),
    update: jest.fn(() => Promise.resolve({})),
  };

  const jobs = {
    findFirst: jest.fn(() => Promise.resolve(null)),
    findMany: jest.fn(() => Promise.resolve(options.queue ?? [])),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      created.push(args.data);
      return Promise.resolve({ id: 'job-1' });
    }),
    update: jest.fn(
      (args: { where: { id: string }; data: Record<string, unknown> }) => {
        jobUpdates.push({ id: args.where.id, data: args.data });
        return Promise.resolve({});
      },
    ),
  };

  const workflow = {
    mode: 'mock' as const,
    startLead: jest.fn(() =>
      options.startFails
        ? Promise.reject(new Error(options.startFails))
        : Promise.resolve({
            instanceId: 'wfi-1',
            workflowKey: 'lwf-0001',
            status: 'ACTIVE',
          }),
    ),
  };

  const audit = {
    record: jest.fn((entry: { eventType: string }) => {
      audits.push(entry);
      return Promise.resolve();
    }),
  };

  // retryIntervalMs = 0 → ไม่มี timer เดินอยู่ข้างล่างเทสต์
  const config = { get: jest.fn(() => 0) };

  const triggers = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.movedToTriggers ? { id: 'trg-1' } : null),
    ),
  };

  const service = new LeadWorkflowSyncService(
    leads as never,
    jobs as never,
    workflow as never,
    audit as never,
    config as never,
    triggers as never,
  );

  return {
    service,
    leads,
    jobs,
    workflow,
    audits,
    created,
    jobUpdates,
    triggers,
  };
}

describe('LeadWorkflowSyncService — Lead ใบใหม่เปิด instance ของ lwf-0001', () => {
  it('บริษัทที่ตั้ง "สร้าง Lead" ในหน้า admin/workflow-triggers แล้ว → ทาง env หยุด ไม่เริ่มซ้ำ', async () => {
    const { service, workflow, leads, triggers } = harness({
      movedToTriggers: true,
    });

    await expect(service.startLead('lead-1')).resolves.toBeNull();

    expect(triggers.findFirst).toHaveBeenCalledWith({
      where: { companyId: 'osd', eventKey: 'lead.created', active: true },
      select: { id: true },
    });
    expect(workflow.startLead).not.toHaveBeenCalled();
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('start สำเร็จ → เก็บ workflowInstanceId + audit integration.workflow.lead_started', async () => {
    const { service, leads, audits } = harness();

    await expect(service.startLead('lead-1')).resolves.toBe('wfi-1');

    expect(leads.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { workflowInstanceId: 'wfi-1' },
    });
    expect(audits[0].eventType).toBe('integration.workflow.lead_started');
    expect(audits[0].after).toMatchObject({
      instanceId: 'wfi-1',
      workflowKey: 'lwf-0001',
    });
  });

  it('Lead ที่มี instance แล้ว ไม่ start ซ้ำ — คิวจะกวาดกี่รอบก็ได้', async () => {
    const { service, workflow, leads } = harness({
      lead: {
        id: 'lead-1',
        companyId: 'osd',
        name: 'x',
        workflowInstanceId: 'wfi-เดิม',
      },
    });

    await expect(service.startLead('lead-1')).resolves.toBe('wfi-เดิม');
    expect(workflow.startLead).not.toHaveBeenCalled();
    expect(leads.update).not.toHaveBeenCalled();
  });

  it('Lead ที่ไม่มีอยู่ (ถูกลบไปแล้ว) ไม่ล้ม — คิวจะได้ไม่ค้างตลอดกาล', async () => {
    const { service, workflow } = harness({ lead: null });

    await expect(service.startLead('lead-ผี')).resolves.toBeNull();
    expect(workflow.startLead).not.toHaveBeenCalled();
  });

  it('workflow ล่ม → kickLead ไม่โยนออกมา แต่ลงคิวไว้ให้ sweeper', async () => {
    const { service, created } = harness({ startFails: 'workflow down' });

    service.kickLead('lead-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(created).toEqual([
      {
        system: 'workflow',
        kind: 'lead_start',
        resourceId: 'lead-1',
        lastError: 'workflow down',
      },
    ]);
  });

  it('มีใบค้างอยู่แล้วไม่ซ้อนใบใหม่ — startLead อ่านสถานะล่าสุดเสมอ', async () => {
    const { service, jobs, created } = harness({ startFails: 'workflow down' });
    jobs.findFirst.mockResolvedValue({ id: 'job-เดิม' } as never);

    service.kickLead('lead-1');
    await new Promise((resolve) => setImmediate(resolve));

    expect(created).toEqual([]);
  });

  it('sweeper: ใบที่ทำสำเร็จถูกปิดเป็น succeeded', async () => {
    const { service, jobUpdates } = harness({
      queue: [{ id: 'job-1', resourceId: 'lead-1', attempts: 0 }],
    });

    await service.processQueue();

    expect(jobUpdates[0]).toMatchObject({
      id: 'job-1',
      data: { status: 'succeeded', attempts: 1, lastError: null },
    });
  });

  it('sweeper: ล้มแล้วเลื่อน runAfter ตาม backoff; ครบ 10 ครั้งจึงเป็น failed', async () => {
    const retry = harness({
      startFails: 'still down',
      queue: [{ id: 'job-1', resourceId: 'lead-1', attempts: 2 }],
    });
    await retry.service.processQueue();
    expect(retry.jobUpdates[0].data).toMatchObject({ attempts: 3 });
    expect(retry.jobUpdates[0].data.runAfter).toBeInstanceOf(Date);
    expect(retry.jobUpdates[0].data.status).toBeUndefined();

    const exhausted = harness({
      startFails: 'still down',
      queue: [{ id: 'job-2', resourceId: 'lead-2', attempts: 9 }],
    });
    await exhausted.service.processQueue();
    expect(exhausted.jobUpdates[0].data).toMatchObject({
      attempts: 10,
      status: 'failed',
    });
  });

  it('sweeper: ใบเดียวล้มไม่ลากใบอื่นในรอบเดียวกัน', async () => {
    const { service, workflow, jobUpdates } = harness({
      queue: [
        { id: 'job-1', resourceId: 'lead-1', attempts: 0 },
        { id: 'job-2', resourceId: 'lead-2', attempts: 0 },
      ],
    });
    workflow.startLead
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        instanceId: 'wfi-2',
        workflowKey: 'lwf-0001',
        status: 'ACTIVE',
      });

    await service.processQueue();

    expect(jobUpdates).toHaveLength(2);
    expect(jobUpdates[1].data).toMatchObject({ status: 'succeeded' });
  });
});
