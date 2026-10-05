import type { Principal } from '@request-management/share';
import { InstallConfirmationsService } from './install-confirmations.service';

const actor = (userId: string, permissions: string[] = []) =>
  ({
    userId,
    activeCompanyId: 'osd',
    permissions,
    displayName: userId,
  }) as unknown as Principal;

function harness(passed: number, status = 'active') {
  const created: unknown[] = [];
  const notified: string[] = [];
  const service = new InstallConfirmationsService(
    {
      access: () =>
        Promise.resolve({
          project: {
            id: 'P',
            companyId: 'osd',
            projectNo: 'PRJ-1',
            name: 'ระบบ',
            status,
            managerUserId: 'pm',
          },
        }),
    } as never,
    {
      state: () =>
        Promise.resolve({
          checks: [
            { key: 'delivery_docs', label: 'เอกสาร', ok: false, detail: null },
          ],
          readiness: { total: 2, passed, failed: 0, unchecked: 2 - passed },
        }),
    } as never,
    {
      count: () => Promise.resolve(0),
      create: (args: unknown) => {
        created.push(args);
        return Promise.resolve({});
      },
    } as never,
    { count: () => Promise.resolve(1) } as never,
    {
      findFirst: () =>
        Promise.resolve({ id: 'M', seq: 1, title: 'เฟส 1', status: 'planned' }),
    } as never,
    { holdersOf: () => Promise.resolve(['deliv']) } as never,
    {
      deliveryInstalled: (userId: string) => {
        notified.push(userId);
        return Promise.resolve();
      },
    } as never,
    { record: () => Promise.resolve() } as never,
  );
  return { service, created, notified };
}

describe('CD-254 ยืนยันงานติดตั้งเสร็จ', () => {
  it('ผู้จัดการยืนยันได้เมื่อตรวจความพร้อมผ่าน (ไม่นับเอกสารส่งมอบ) และแจ้งทีม Delivery', async () => {
    const { service, created, notified } = harness(2);
    await service.confirm(actor('pm'), 'P', 'M', '');
    expect(created).toHaveLength(1);
    expect(notified).toEqual(['deliv']);
  });

  it('ตรวจความพร้อมยังไม่ผ่าน = CONFLICT; ไม่ใช่ผู้จัดการ/โครงการปิด = FORBIDDEN', async () => {
    await expect(
      harness(1).service.confirm(actor('pm'), 'P', 'M', ''),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      harness(2).service.confirm(actor('d', ['delivery.manage']), 'P', 'M', ''),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      harness(2, 'closed').service.confirm(actor('pm'), 'P', 'M', ''),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
