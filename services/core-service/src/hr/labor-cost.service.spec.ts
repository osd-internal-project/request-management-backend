import { Prisma } from '@prisma/client';
import type { Principal } from '@request-management/share';
import { LaborCostService } from './labor-cost.service';

const actor = {
  userId: 'hr',
  activeCompanyId: 'osd',
  permissions: ['hr.rate.read'],
} as unknown as Principal;

function line(user: string, request: string, date: string, hours: number) {
  return {
    workDate: new Date(`${date}T00:00:00Z`),
    requestId: request,
    workTypeId: 'W',
    hours: new Prisma.Decimal(hours),
    billable: true,
    timesheet: { userId: user },
  };
}

function harness() {
  const lines = {
    findMany: jest.fn(() =>
      Promise.resolve([
        line('a', 'R1', '2026-10-01', 8),
        line('a', 'R2', '2026-10-02', 4),
        line('nolevel', 'R1', '2026-10-02', 2),
      ]),
    ),
  };
  const service = new LaborCostService(
    lines as never,
    {
      findMany: jest.fn(() => Promise.resolve([{ userId: 'a', levelId: 'L' }])),
    } as never,
    {
      requestsByIds: jest.fn(() =>
        Promise.resolve([
          {
            id: 'R1',
            requestNo: 'SR-1',
            typeCode: 'SUP',
            status: 'in_progress',
            contactCompany: 'ลูกค้า ก',
          },
          {
            id: 'R2',
            requestNo: 'SR-2',
            typeCode: 'SUP',
            status: 'completed',
            contactCompany: null,
          },
        ]),
      ),
      requestTypeNames: jest.fn(() =>
        Promise.resolve(new Map([['SUP', 'ซ่อมบำรุง']])),
      ),
      names: jest.fn(() => Promise.resolve(new Map([['a', 'สมชาย']]))),
    } as never,
    {
      rateRows: jest.fn(() =>
        Promise.resolve([
          {
            levelId: 'L',
            workTypeId: 'W',
            validFrom: '2026-01-01',
            validTo: null,
            costPerManday: 4000,
          },
        ]),
      ),
    } as never,
  );
  return { service, lines };
}

describe('CD-234 ต้นทุนแรงงานงานบริการ', () => {
  it('อ่านเฉพาะ Timesheet อนุมัติของงานบริการในช่วงวันที่', async () => {
    const { service, lines } = harness();
    await service.report(actor, { from: '2026-10-01', to: '2026-10-31' });
    expect(lines.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: 'service',
          timesheet: { companyId: 'osd', status: 'approved' },
        }) as unknown,
      }),
    );
  });

  it('รวมตามคำขอ เรียงต้นทุนมากก่อน; คนไม่มีระดับเป็นชั่วโมงที่คิดราคาไม่ได้', async () => {
    const { service } = harness();
    const report = await service.report(actor, {
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(report.totals).toEqual({
      hours: 14,
      mandays: 1.75,
      cost: 6000,
      unpricedHours: 2,
    });
    expect(
      report.rows.map((r) => [r.label, r.cost, r.unpricedHours, r.customer]),
    ).toEqual([
      ['SR-1 · ซ่อมบำรุง', 4000, 2, 'ลูกค้า ก'],
      ['SR-2 · ซ่อมบำรุง', 2000, 0, null],
    ]);
    const byType = await service.report(actor, {
      from: '2026-10-01',
      to: '2026-10-31',
      group: 'type',
    });
    expect(byType.rows).toEqual([
      expect.objectContaining({ key: 'SUP', label: 'ซ่อมบำรุง', cost: 6000 }),
    ]);
  });

  it('ช่วงวันที่เกินปีหรือกลับด้าน = VALIDATION_FAILED', async () => {
    const { service } = harness();
    await expect(
      service.report(actor, { from: '2026-10-31', to: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      service.report(actor, { from: '2025-01-01', to: '2026-10-01' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('forRequests ให้ต้นทุนต่อคำขอสำหรับ margin งานบริการ', async () => {
    const { service } = harness();
    const map = await service.forRequests('osd', ['R1', 'R2']);
    expect(map.get('R2')).toEqual({
      hours: 4,
      mandays: 0.5,
      cost: 2000,
      unpricedHours: 0,
    });
  });
});
