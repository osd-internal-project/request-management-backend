import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { LeavesService } from './leaves.service';
import { AvailabilityService } from './availability.service';

const actor = (userId: string, permissions: string[] = []) =>
  ({ userId, activeCompanyId: 'osd', permissions }) as unknown as Principal;

const ANNUAL = {
  id: 'T',
  code: 'ANNUAL',
  name: 'ลาพักร้อน',
  annualDays: new Prisma.Decimal(6),
  sortOrder: 0,
  active: true,
};

function leaveRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'L1',
    companyId: 'osd',
    userId: 'me',
    leaveTypeId: 'T',
    startDate: new Date('2026-10-12T00:00:00Z'),
    endDate: new Date('2026-10-14T00:00:00Z'),
    part: 'full',
    days: new Prisma.Decimal(3),
    reason: '',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    cancelledAt: null,
    createdAt: new Date(),
    leaveType: { id: 'T', code: 'ANNUAL', name: 'ลาพักร้อน' },
    ...patch,
  };
}

function harness(held: ReturnType<typeof leaveRow>[] = []) {
  const leaves = {
    findMany: jest.fn(() => Promise.resolve(held)),
    findFirst: jest.fn(() => Promise.resolve(held[0] ?? null)),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(leaveRow({ ...data, id: 'NEW' })),
    ),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
  };
  const notifications = {
    leaveRequested: jest.fn(() => Promise.resolve()),
    leaveDecided: jest.fn(() => Promise.resolve()),
    bookingCreated: jest.fn(() => Promise.resolve()),
  };
  const reporting = {
    subordinatesOf: jest.fn((id: string) =>
      Promise.resolve(id === 'boss' ? ['me'] : []),
    ),
  };
  const refs = {
    supervisorOf: jest.fn(() =>
      Promise.resolve({ supervisorUserId: 'boss', displayName: 'สมชาย' }),
    ),
    names: jest.fn(() => Promise.resolve(new Map())),
    project: jest.fn(() =>
      Promise.resolve({
        id: 'P',
        projectNo: 'PRJ-1',
        name: 'ระบบ',
        status: 'active',
        managerUserId: 'pm',
      }),
    ),
    projectPeople: jest.fn(() => Promise.resolve(['me'])),
    projects: jest.fn(() => Promise.resolve([])),
  };
  const employees = {
    staffRows: jest.fn((_c: string, ids?: string[]) =>
      Promise.resolve(
        (ids ?? ['me', 'boss', 'pm']).map((userId) => ({ userId })),
      ),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new LeavesService(
    {
      findFirst: jest.fn(() => Promise.resolve(ANNUAL)),
      findMany: jest.fn(() => Promise.resolve([ANNUAL])),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    leaves as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          workingWeekdays: [1, 2, 3, 4, 5],
          holidays: ['2026-10-13'],
        }),
      ),
    } as never,
    reporting as never,
    refs as never,
    employees as never,
    notifications as never,
    audit as never,
  );
  const bookings = {
    findMany: jest.fn(() => Promise.resolve([])),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...data, id: 'B', createdAt: new Date() }),
    ),
  };
  const availability = new AvailabilityService(
    bookings as never,
    reporting as never,
    refs as never,
    employees as never,
    service,
    notifications as never,
    audit as never,
  );
  return { service, availability, leaves, notifications, bookings };
}

describe('CD-232 การลา', () => {
  it('ยื่นลา: นับเฉพาะวันทำการ และแจ้งหัวหน้าตามผัง', async () => {
    const { service, leaves, notifications } = harness();
    await service.request(actor('me'), {
      leave_type_id: 'T',
      start_date: '2026-10-12',
      end_date: '2026-10-14',
    });
    expect(leaves.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ days: 2, part: 'full' }) as unknown,
      }),
    );
    expect(notifications.leaveRequested).toHaveBeenCalledWith(
      'boss',
      'osd',
      expect.objectContaining({ days: 2 }),
      'สมชาย',
      'ลาพักร้อน',
    );
  });

  it('ซ้อนกับใบลาเดิม = CONFLICT; เกินสิทธิ์ = VALIDATION_FAILED', async () => {
    await expect(
      harness([leaveRow()]).service.request(actor('me'), {
        leave_type_id: 'T',
        start_date: '2026-10-14',
        end_date: '2026-10-14',
        part: 'pm',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // 6 days a year, 2 already held (12 + 14, the 13th is a holiday).
    await expect(
      harness([leaveRow()]).service.request(actor('me'), {
        leave_type_id: 'T',
        start_date: '2026-11-02',
        end_date: '2026-11-06',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('หัวหน้าตามผังหรือ HR อนุมัติ; ตัวเองไม่ได้; คนนอกสาย 404; ไม่อนุมัติต้องมีเหตุผล', async () => {
    const { service, notifications } = harness([leaveRow()]);
    await expect(service.approve(actor('me'), 'L1', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      service.approve(actor('stranger'), 'L1', {}),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      service.reject(actor('boss'), 'L1', { note: ' ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await service.approve(actor('hr', ['hr.employee.manage']), 'L1', {});
    expect(notifications.leaveDecided).toHaveBeenCalledWith(
      'me',
      'osd',
      expect.objectContaining({ id: 'L1' }),
      'ลาพักร้อน',
      true,
      '',
    );
  });

  it('ลาที่อนุมัติแล้วและเริ่มไปแล้ว เจ้าของยกเลิกเองไม่ได้', async () => {
    const started = leaveRow({
      status: 'approved',
      startDate: new Date('2020-01-06T00:00:00Z'),
      endDate: new Date('2020-01-06T00:00:00Z'),
    });
    await expect(
      harness([started]).service.cancel(actor('me'), 'L1'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('CD-232 ความพร้อมและการจองตัว', () => {
  it('PM เห็นว่าไม่ว่างแต่ไม่เห็นประเภทการลา; หัวหน้าเห็น', async () => {
    const approved = leaveRow({ status: 'approved' });
    const query = { from: '2026-10-12', to: '2026-10-12', user_ids: 'me' };
    const pm = await harness([approved]).availability.availability(
      actor('pm', ['pm.project.manage']),
      query,
    );
    expect(pm.people[0].days[0]).toMatchObject({
      leaveHours: 8,
      leaveType: null,
      free: 0,
    });
    const boss = await harness([approved]).availability.availability(
      actor('boss'),
      query,
    );
    expect(boss.people[0].days[0].leaveType).toBe('ลาพักร้อน');
  });

  it('คนทั่วไปเห็นแค่ตัวเองและลูกทีม', async () => {
    const { availability } = harness();
    const view = await availability.availability(actor('nobody'), {
      from: '2026-10-12',
      to: '2026-10-12',
      user_ids: 'me,boss',
    });
    expect(view.people).toEqual([]);
  });

  it('จองเกินความว่างได้ แต่ตอบวันที่เกิน; คนนอกโครงการจองไม่ได้', async () => {
    const { availability, notifications } = harness([
      leaveRow({ status: 'approved' }),
    ]);
    const result = await availability.createBooking(actor('pm'), {
      user_id: 'me',
      project_id: 'P',
      start_date: '2026-10-12',
      end_date: '2026-10-16',
      hours_per_day: 4,
    });
    expect(result.overbooked.map((d) => d.day)).toEqual([
      '2026-10-12',
      '2026-10-14',
    ]);
    expect(notifications.bookingCreated).toHaveBeenCalled();
    await expect(
      availability.createBooking(actor('someone'), {
        user_id: 'me',
        project_id: 'P',
        start_date: '2026-10-12',
        end_date: '2026-10-12',
        hours_per_day: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
