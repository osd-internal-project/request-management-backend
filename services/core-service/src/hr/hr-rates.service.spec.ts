import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { HrRatesService } from './hr-rates.service';

const D = (value: number) => new Prisma.Decimal(value);
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const shift = (days: number) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const actor = {
  userId: 'hr-1',
  activeCompanyId: 'osd',
  permissions: ['hr.rate.manage', 'hr.rate.read'],
} as unknown as Principal;

function harness(stored: Record<string, unknown>[] = []) {
  const levels = [
    { id: 'L1', code: 'SE-1', name: 'วิศวกร', sortOrder: 0, active: true },
  ];
  const types = [
    { id: 'W1', code: 'INSTALL', name: 'ติดตั้ง', sortOrder: 0, active: true },
  ];
  const rates = stored.map((row) => ({
    id: 'r-old',
    levelId: 'L1',
    workTypeId: 'W1',
    costPerManday: D(4000),
    sellPerManday: null,
    validTo: null,
    note: '',
    createdBy: 'x',
    createdAt: new Date(),
    ...row,
  }));
  const tx = {
    hrLaborRate: {
      findFirst: jest.fn(() => Promise.resolve(rates[0] ?? null)),
      update: jest.fn(() => Promise.resolve({})),
      create: jest.fn(() => Promise.resolve({ id: 'r-new' })),
    },
  };
  const service = new HrRatesService(
    {
      findMany: jest.fn(() => Promise.resolve(levels)),
      findFirst: jest.fn(() => Promise.resolve(levels[0])),
    } as never,
    {
      findMany: jest.fn(() => Promise.resolve(types)),
      findFirst: jest.fn(() => Promise.resolve(types[0])),
    } as never,
    {
      findMany: jest.fn(() => Promise.resolve(rates)),
      findFirst: jest.fn(() => Promise.resolve(rates[0] ?? null)),
    } as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    { execute: (fn: (prisma: unknown) => Promise<unknown>) => fn(tx) } as never,
  );
  return { service, tx };
}

describe('CD-207 ทะเบียนอัตราต้นทุนบุคลากร', () => {
  it('อัตราที่มีผลวันนี้ต่อระดับ × ประเภทงาน พร้อมชื่อที่บรรทัดแรงงานใช้', async () => {
    const { service } = harness([{ validFrom: day(shift(-30)) }]);
    expect(await service.effectiveRates('osd')).toEqual([
      {
        levelCode: 'SE-1',
        workTypeCode: 'INSTALL',
        label: 'SE-1 วิศวกร · ติดตั้ง',
        rate: 4000,
      },
    ]);
  });

  it('เพิ่มอัตราใหม่ = ปิดอัตราเดิมวันก่อนหน้า', async () => {
    const { service, tx } = harness([{ validFrom: day(shift(-30)) }]);
    await service.addRate(actor, {
      level_id: 'L1',
      work_type_id: 'W1',
      cost_per_manday: 4500,
      valid_from: shift(10),
    });
    expect(tx.hrLaborRate.update).toHaveBeenCalledWith({
      where: { id: 'r-old' },
      data: { validTo: day(shift(9)) },
    });
    expect(tx.hrLaborRate.create).toHaveBeenCalled();
  });

  it('อัตราใหม่ต้องเริ่มหลังอัตราล่าสุด — แก้ย้อนหลังไม่ได้', async () => {
    const { service, tx } = harness([{ validFrom: day(shift(-30)) }]);
    await expect(
      service.addRate(actor, {
        level_id: 'L1',
        work_type_id: 'W1',
        cost_per_manday: 4500,
        valid_from: shift(-40),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(tx.hrLaborRate.create).not.toHaveBeenCalled();
  });

  it('ถอนได้เฉพาะอัตราที่ยังไม่มีผล', async () => {
    const started = harness([{ validFrom: day(shift(-1)) }]);
    await expect(
      started.service.withdrawRate(actor, 'r-old'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
