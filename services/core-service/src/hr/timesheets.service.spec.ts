import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { TimesheetsService } from './timesheets.service';
import { weekStartOf } from './timesheet-rules';

const actor = (userId: string, permissions: string[] = []) =>
  ({ userId, activeCompanyId: 'osd', permissions }) as unknown as Principal;

const lastMonday = weekStartOf(
  new Date(Date.now() + 7 * 3_600_000 - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10),
);

function sheet(patch: Record<string, unknown> = {}) {
  return {
    id: 'ts-1',
    companyId: 'osd',
    userId: 'me',
    weekStart: new Date(`${lastMonday}T00:00:00Z`),
    status: 'draft',
    submittedAt: null,
    decidedAt: null,
    decidedBy: null,
    returnReason: null,
    lines: [
      {
        workDate: new Date(`${lastMonday}T00:00:00Z`),
        kind: 'project',
        projectId: 'P',
        projectTaskId: null,
        requestId: null,
        solutionId: null,
        internalCode: null,
        workTypeId: 'W',
        hours: new Prisma.Decimal(6),
        billable: true,
        note: '',
      },
    ],
    ...patch,
  };
}

function harness(
  options: {
    found?: unknown;
    below?: string[];
    projects?: { id: string }[];
  } = {},
) {
  const tx = {
    hrTimesheet: {
      create: jest.fn(() => Promise.resolve({ id: 'ts-new' })),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    hrTimesheetLine: {
      deleteMany: jest.fn(() => Promise.resolve({ count: 0 })),
      createMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  };
  const notifications = {
    timesheetSubmitted: jest.fn(() => Promise.resolve()),
    timesheetReturned: jest.fn(() => Promise.resolve()),
  };
  const service = new TimesheetsService(
    {
      findFirst: jest.fn(() =>
        Promise.resolve(options.found === undefined ? sheet() : options.found),
      ),
      findMany: jest.fn(() => Promise.resolve([sheet({ status: 'approved' })])),
    } as never,
    {
      projects: jest.fn(() =>
        Promise.resolve(
          options.projects ?? [{ id: 'P', projectNo: 'PRJ-1', name: 'ระบบ' }],
        ),
      ),
      tasks: jest.fn(() => Promise.resolve([])),
      requests: jest.fn(() => Promise.resolve([])),
      solutions: jest.fn(() => Promise.resolve([])),
      supervisorOf: jest.fn(() =>
        Promise.resolve({ supervisorUserId: 'boss', displayName: 'สมชาย' }),
      ),
      requestTypeNames: jest.fn(() => Promise.resolve(new Map())),
      names: jest.fn(() => Promise.resolve(new Map())),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([{ id: 'W' }])) } as never,
    {
      findMany: jest.fn(() => Promise.resolve([{ code: 'MEETING' }])),
    } as never,
    {
      findMany: jest.fn(() =>
        Promise.resolve([{ userId: 'me', levelId: 'L1' }]),
      ),
    } as never,
    {
      subordinatesOf: jest.fn((id: string) =>
        Promise.resolve(id === 'boss' ? ['me'] : (options.below ?? [])),
      ),
    } as never,
    notifications as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { execute: (fn: (prisma: unknown) => Promise<unknown>) => fn(tx) } as never,
  );
  return { service, tx, notifications };
}

describe('CD-231 Timesheet', () => {
  it('บันทึกสัปดาห์: แทนที่บรรทัดของร่างทั้งชุด', async () => {
    const { service, tx } = harness({ found: null });
    await service.saveWeek(actor('me'), {
      week_start: lastMonday,
      rows: [
        {
          kind: 'project',
          project_id: 'P',
          work_type_id: 'W',
          hours: { [lastMonday]: 6 },
        },
      ],
    });
    expect(tx.hrTimesheet.create).toHaveBeenCalled();
    const [created] = tx.hrTimesheetLine.createMany.mock
      .calls[0] as unknown as [
      { data: { kind: string; hours: number; billable: boolean }[] },
    ];
    expect(created.data).toEqual([
      expect.objectContaining({ kind: 'project', hours: 6, billable: true }),
    ]);
  });

  it('โครงการที่ไม่อยู่ในบริษัท = VALIDATION_FAILED', async () => {
    const { service } = harness({ found: null, projects: [] });
    await expect(
      service.saveWeek(actor('me'), {
        week_start: lastMonday,
        rows: [
          {
            kind: 'project',
            project_id: 'X',
            work_type_id: 'W',
            hours: { [lastMonday]: 1 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('สัปดาห์ที่ส่งหรืออนุมัติแล้วแก้ไม่ได้', async () => {
    const { service } = harness({ found: sheet({ status: 'submitted' }) });
    await expect(
      service.saveWeek(actor('me'), { week_start: lastMonday, rows: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('ส่ง = แจ้งหัวหน้าตามผัง; ส่งของคนอื่นไม่ได้', async () => {
    const { service, notifications } = harness();
    await service.submit(actor('me'), 'ts-1');
    expect(notifications.timesheetSubmitted).toHaveBeenCalledWith(
      'boss',
      'osd',
      { id: 'ts-1', weekStart: lastMonday },
      'สมชาย',
      6,
    );
    await expect(service.submit(actor('other'), 'ts-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('หัวหน้าตามผังอนุมัติ/ตีกลับได้; ตีกลับต้องมีเหตุผล; คนนอกสาย = 404; ตัวเองไม่ได้', async () => {
    const submitted = sheet({ status: 'submitted' });
    const boss = harness({ found: submitted });
    await boss.service.approve(actor('boss'), 'ts-1');
    expect(boss.tx.hrTimesheet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ts-1', status: { in: ['submitted'] } },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        data: expect.objectContaining({
          status: 'approved',
          decidedBy: 'boss',
        }),
      }),
    );
    await expect(
      harness({ found: submitted }).service.returnSheet(
        actor('boss'),
        'ts-1',
        ' ',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      harness({ found: submitted }).service.approve(actor('stranger'), 'ts-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness({ found: submitted }).service.approve(actor('me'), 'ts-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // HR may decide for anyone
    await expect(
      harness({ found: submitted }).service.approve(
        actor('hr', ['hr.employee.manage']),
        'ts-1',
      ),
    ).resolves.toBeDefined();
  });

  it('ชั่วโมงจริงของโครงการ (อนุมัติแล้ว) ต่อคน วัน ประเภทงาน พร้อมระดับ', async () => {
    const { service } = harness();
    const actuals = await service.projectActuals('osd', 'P');
    expect(actuals).toMatchObject({ hours: 6, mandays: 0.75 });
    expect(actuals.lines[0]).toMatchObject({
      userId: 'me',
      levelId: 'L1',
      workTypeId: 'W',
      date: lastMonday,
      hours: 6,
    });
  });

  it('สัปดาห์ที่เปิดดูมีชื่อของทุก id (หัวหน้าอ่านได้)', async () => {
    const { service } = harness();
    const week = await service.findOne(actor('boss'), 'ts-1');
    expect(week.labels).toMatchObject({ P: 'PRJ-1 · ระบบ' });
    expect(week.hours).toBe(6);
  });
});
