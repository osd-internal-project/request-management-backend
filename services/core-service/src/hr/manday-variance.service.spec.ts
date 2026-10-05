import type { Principal } from '@request-management/share';
import { MandayVarianceService } from './manday-variance.service';

const actor = (userId: string, permissions: string[] = []) =>
  ({ userId, activeCompanyId: 'osd', permissions }) as unknown as Principal;

function harness(
  options: {
    status?: string;
    hours?: number;
    sent?: { budgetVersionNo: number; threshold: number }[];
    budget?: { versionNo: number; lines: unknown } | null;
  } = {},
) {
  const project = {
    id: 'P',
    companyId: 'osd',
    projectNo: 'PRJ-1',
    name: 'ระบบ',
    status: options.status ?? 'active',
    managerUserId: 'pm',
    solutionVersionId: 'SV',
    startOn: null,
    endOn: new Date('2026-12-31T00:00:00Z'),
    updatedAt: new Date(),
  };
  const budget =
    options.budget === undefined
      ? { versionNo: 2, lines: [{ category: 'labor', quantity: 10 }] }
      : options.budget;
  const refs = {
    mandayProjects: jest.fn(() => Promise.resolve([project])),
    lockedBudgets: jest.fn(() =>
      Promise.resolve(new Map(budget ? [['P', budget]] : [])),
    ),
    solutionLabor: jest.fn(() =>
      Promise.resolve(
        new Map([
          ['SV', [{ levelCode: 'SE', workTypeCode: 'GEN', mandays: 8 }]],
        ]),
      ),
    ),
    approvedHours: jest.fn(() =>
      Promise.resolve(new Map([['P', options.hours ?? 0]])),
    ),
    holdersOf: jest.fn(() => Promise.resolve(['pricer', 'pm'])),
  };
  const alerts = {
    findMany: jest.fn(() =>
      Promise.resolve(
        (options.sent ?? []).map((row) => ({ projectId: 'P', ...row })),
      ),
    ),
    create: jest.fn(() => Promise.resolve({})),
  };
  const notifications = {
    mandayThreshold: jest.fn(() => Promise.resolve()),
    mandayClosed: jest.fn(() => Promise.resolve()),
  };
  const rule = { enabled: true, params: { percents: [120, 100, 80] } };
  const service = new MandayVarianceService(
    refs as never,
    alerts as never,
    {} as never,
    {} as never,
    {} as never,
    {
      across: () =>
        Promise.resolve({
          standard: rule,
          byCompany: new Map(),
          of: () => rule,
        }),
    } as never,
    notifications as never,
    { get: () => 0 } as never,
  );
  return { service, alerts, notifications, refs };
}

describe('CD-233 manday แผนเทียบจริง', () => {
  it('แผนจากงบที่ล็อกล่าสุด; ไม่มีงบใช้ Solution', async () => {
    const withBudget = await harness({ hours: 84 }).service.list(
      actor('x', ['pm.project.read']),
    );
    expect(withBudget.items[0]).toMatchObject({
      planned: 10,
      planSource: 'budget',
      actual: 10.5,
      percent: 105,
    });
    const noBudget = await harness({ budget: null }).service.list(
      actor('x', ['pm.project.read']),
    );
    expect(noBudget.items[0]).toMatchObject({
      planned: 8,
      planSource: 'solution',
      budgetVersionNo: 0,
    });
  });

  it('คนทั่วไปเห็นเฉพาะโครงการที่ตัวเองเป็นผู้จัดการ', async () => {
    const { service, refs } = harness();
    await service.list(actor('someone'));
    expect(refs.mandayProjects).toHaveBeenCalledWith(
      expect.objectContaining({ managerUserId: 'someone' }),
    );
  });

  it('ถึงหลายขั้นพร้อมกัน: บันทึกทุกขั้น แจ้งเฉพาะขั้นสูงสุด ถึง PM + ทีมราคา (ไม่ซ้ำ)', async () => {
    const { service, alerts, notifications } = harness({ hours: 84 });
    await service.sweep();
    expect(alerts.create).toHaveBeenCalledTimes(2); // 100 and 80
    expect(notifications.mandayThreshold).toHaveBeenCalledTimes(2);
    const calls = notifications.mandayThreshold.mock.calls as unknown as [
      string,
      string,
      unknown,
      number,
    ][];
    expect(calls.map((c) => c[0]).sort()).toEqual(['pm', 'pricer']);
    expect(calls[0][3]).toBe(105);
  });

  it('ขั้นที่แจ้งแล้วในงบเวอร์ชันเดียวกันไม่แจ้งซ้ำ; งบเวอร์ชันใหม่นับใหม่', async () => {
    const same = harness({
      hours: 84,
      sent: [
        { budgetVersionNo: 2, threshold: 100 },
        { budgetVersionNo: 2, threshold: 80 },
      ],
    });
    await same.service.sweep();
    expect(same.notifications.mandayThreshold).not.toHaveBeenCalled();
    const next = harness({
      hours: 84,
      sent: [{ budgetVersionNo: 1, threshold: 100 }],
    });
    await next.service.sweep();
    expect(next.notifications.mandayThreshold).toHaveBeenCalled();
  });

  it('ปิดโครงการแล้วส่งสรุปส่วนต่างครั้งเดียว', async () => {
    const { service, notifications } = harness({ status: 'closed', hours: 96 });
    await service.sweep();
    expect(notifications.mandayClosed).toHaveBeenCalledWith(
      'pm',
      'osd',
      { id: 'P', label: 'PRJ-1 · ระบบ' },
      12,
      10,
      '+20%',
    );
    const again = harness({
      status: 'closed',
      hours: 96,
      sent: [{ budgetVersionNo: 2, threshold: 0 }],
    });
    await again.service.sweep();
    expect(again.notifications.mandayClosed).not.toHaveBeenCalled();
  });
});
