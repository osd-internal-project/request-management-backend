import { AppError, type Principal } from '@request-management/share';
import { DeliveriesService } from './deliveries.service';

const actor = (userId: string, permissions: string[] = []) =>
  ({ userId, activeCompanyId: 'osd', permissions }) as unknown as Principal;

function harness(status = 'active') {
  const project = {
    id: 'P',
    companyId: 'osd',
    projectNo: 'PRJ-1',
    name: 'ระบบ',
    status,
    managerUserId: 'pm',
    baseline: {
      boq: [
        {
          kind: 'equipment',
          productCode: 'SW',
          name: 'Switch',
          description: '',
          model: '',
          quantity: 10,
          unit: 'ตัว',
          refUnitCost: null,
        },
      ],
    },
  };
  const access = jest.fn((_id: string, who: Principal) =>
    who.userId === 'pm' || who.userId === 'member'
      ? Promise.resolve({ project, canEdit: false })
      : Promise.reject(new AppError('NOT_FOUND', 'ไม่พบโครงการที่ระบุ')),
  );
  const created: unknown[] = [];
  const tx = {
    projectDelivery: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((args: unknown) => {
        created.push(args);
        return Promise.resolve({ id: 'D1', seq: 1 });
      }),
    },
  };
  const deliveries = {
    findMany: jest.fn(() => Promise.resolve([])),
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'D1',
        projectId: 'P',
        milestoneId: 'M',
        seq: 1,
        plannedOn: new Date('2026-10-20T00:00:00Z'),
        location: 'A',
        receiverName: '',
        receiverPhone: '',
        note: '',
        status: 'planned',
        lines: [],
      }),
    ),
  };
  const service = new DeliveriesService(
    deliveries as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    {} as never,
    { access } as never,
    { findFirst: jest.fn(() => Promise.resolve(project)) } as never,
    {
      findFirst: jest.fn(() => Promise.resolve({ id: 'M', status: 'planned' })),
      findMany: jest.fn(() => Promise.resolve([])),
    } as never,
    {
      across: () =>
        Promise.resolve({
          of: () => ({ enabled: true, params: { days: 7 } }),
        }),
    } as never,
    {} as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { execute: (fn: (p: unknown) => Promise<unknown>) => fn(tx) } as never,
    { get: () => 0 } as never,
  );
  return { service, access, created };
}

const dto = {
  milestone_id: 'M',
  planned_on: '2026-10-20',
  location: 'ไซต์ A',
  lines: [{ boq_index: 0, quantity: 4 }],
};

describe('CD-250 แผนส่งมอบ — สิทธิ์', () => {
  it('ทีม Delivery เห็นทุกโครงการโดยไม่ต้องอยู่ในทีมโครงการ', async () => {
    const { service, access } = harness();
    const view = await service.project(actor('d', ['delivery.read']), 'P');
    expect(access).not.toHaveBeenCalled();
    expect(view.canEdit).toBe(false);
  });

  it('คนนอกโครงการ = 404; สมาชิกทีมอ่านได้แต่แก้ไม่ได้', async () => {
    const { service } = harness();
    await expect(service.project(actor('x'), 'P')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect((await service.project(actor('member'), 'P')).canEdit).toBe(false);
    await expect(
      service.create(actor('member'), 'P', dto),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('ผู้จัดการโครงการ / delivery.manage วางแผนได้; โครงการปิดแล้วแก้ไม่ได้', async () => {
    const { service, created } = harness();
    await service.create(actor('pm'), 'P', dto);
    await service.create(actor('d', ['delivery.manage']), 'P', dto);
    expect(created).toHaveLength(2);
    await expect(
      harness('closed').service.create(
        actor('d', ['delivery.manage']),
        'P',
        dto,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('ยกเลิกต้องมีเหตุผล', async () => {
    const { service } = harness();
    await expect(service.cancel(actor('pm'), 'D1', ' ')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
