import { Principal } from '@request-management/share';
import {
  DEFAULT_LEAD_STATUSES,
  LeadStatusService,
  type LeadStatusRow,
} from './lead-status.service';

function principal(): Principal {
  return {
    userId: 'me',
    displayName: 'ผู้ดูแล',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-admin',
    ledUnitIds: [],
    scopedUnitIds: [],
    permissions: ['admin.crm.manage'],
  } as unknown as Principal;
}

/**
 * ตาราง `lead_statuses` จำลองในหน่วยความจำ. `leadCount` คือจำนวน Lead ที่อ้าง
 * สถานะนั้นอยู่ — ตัวเลขเดียวที่ตัดสินว่าลบได้ไหม.
 */
function harness(options: { leadCount?: number } = {}) {
  const rows: LeadStatusRow[] = DEFAULT_LEAD_STATUSES.map((row, index) => ({
    ...row,
    id: `status-${index}`,
    companyId: 'osd',
  }));

  const statuses = {
    findMany: jest.fn(() => Promise.resolve(rows)),
    findFirst: jest.fn((args: { where: { code?: string } }) =>
      Promise.resolve(rows.find((row) => row.code === args.where.code) ?? null),
    ),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: 'status-new', ...args.data }),
    ),
    update: jest.fn((args: { where: { id: string }; data: object }) =>
      Promise.resolve({
        ...rows.find((row) => row.id === args.where.id),
        ...args.data,
      }),
    ),
    delete: jest.fn(() => Promise.resolve({})),
    createMany: jest.fn(() => Promise.resolve({ count: rows.length })),
  };

  const leads = {
    count: jest.fn(() => Promise.resolve(options.leadCount ?? 0)),
  };

  const service = new LeadStatusService(
    statuses as never,
    leads as never,
    { record: jest.fn(() => Promise.resolve()) } as never,
    {
      execute: jest.fn((work: (prisma: unknown) => unknown) => work({})),
    } as never,
  );

  return { service, statuses, leads, rows };
}

describe('ตั้งค่าสถานะ Lead — รายการสถานะเป็นข้อมูล ไม่ใช่ enum ในโค้ด', () => {
  it('เพิ่มขั้นใหม่ได้ และเป็น open เสมอ — ปลายทางเพิ่มเองไม่ได้', async () => {
    const { service, statuses } = harness();

    await service.create(
      { code: 'follow_up', name_th: 'ตามผลอยู่', color: 'gold' },
      principal(),
    );

    const [created] = statuses.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(created.data).toMatchObject({ code: 'follow_up', kind: 'open' });
    // ไม่มีธงเชิง process หลุดลงตาราง — กฎอยู่บน workflow
    expect(created.data).not.toHaveProperty('requiresActivity');
    expect(created.data).not.toHaveProperty('convertible');
  });

  it('รหัสที่ผิดรูปแบบถูกปฏิเสธก่อนแตะฐานข้อมูล', async () => {
    const { service, statuses } = harness();

    await expect(
      service.create({ code: 'Follow Up!', name_th: 'x' }, principal()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(statuses.create).not.toHaveBeenCalled();
  });

  it('รหัสซ้ำ = 409', async () => {
    const { service } = harness();

    await expect(
      service.create({ code: 'contacted', name_th: 'ซ้ำ' }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('สถานะที่มี Lead ใช้อยู่ ลบไม่ได้ — ตอบ CRM_LEAD_STATUS_IN_USE ให้ปิดใช้งานแทน', async () => {
    const { service, rows, statuses } = harness({ leadCount: 3 });
    const contacted = rows.find((row) => row.code === 'contacted')!;

    await expect(
      service.remove(contacted.id, principal()),
    ).rejects.toMatchObject({ code: 'CRM_LEAD_STATUS_IN_USE' });
    expect(statuses.delete).not.toHaveBeenCalled();
  });

  it('สถานะระบบลบไม่ได้แม้ไม่มี Lead ใช้ — ปุ่มแปลง/คัดออกต้องมีที่ไปเสมอ', async () => {
    const { service, rows } = harness({ leadCount: 0 });
    const converted = rows.find((row) => row.code === 'converted')!;

    await expect(
      service.remove(converted.id, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('ขั้นที่ไม่มี Lead ใช้และไม่ใช่สถานะระบบ ลบได้', async () => {
    const { service, rows, statuses } = harness({ leadCount: 0 });
    const cannotContact = rows.find((row) => row.code === 'cannot_contact')!;

    await service.remove(cannotContact.id, principal());

    expect(statuses.delete).toHaveBeenCalledWith(
      { where: { id: cannotContact.id } },
      expect.anything(),
    );
  });

  it('ปิดขั้นระหว่างทางจนไม่เหลือสักขั้นไม่ได้ — pipeline จะกลายเป็นทางตัน', async () => {
    const { service, rows } = harness();
    // ปิดทีละขั้นจนเหลือขั้น open ที่เปิดอยู่ขั้นเดียว แล้วปิดขั้นสุดท้าย
    for (const row of rows) {
      if (row.kind === 'open' && !row.isSystem) row.active = false;
    }
    const isNew = rows.find((row) => row.code === 'new')!;
    isNew.isSystem = false;

    await expect(
      service.update(isNew.id, { active: false }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('สถานะระบบปิดใช้งานไม่ได้', async () => {
    const { service, rows } = harness();
    const isNew = rows.find((row) => row.code === 'new')!;

    await expect(
      service.update(isNew.id, { active: false }, principal()),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('เปลี่ยนชื่อขั้นได้ โดยรหัสไม่ขยับ — Lead เดิมยังชี้ที่เดิม', async () => {
    const { service, rows, statuses } = harness();
    const qualified = rows.find((row) => row.code === 'qualified')!;

    await service.update(
      qualified.id,
      { name_th: 'ผ่านการคัดกรองเบื้องต้น' },
      principal(),
    );

    const [saved] = statuses.update.mock.calls[0] as [
      { where: { id: string }; data: Record<string, unknown> },
    ];
    expect(saved.where.id).toBe(qualified.id);
    expect(saved.data.nameTh).toBe('ผ่านการคัดกรองเบื้องต้น');
    // รหัสไม่อยู่ในชุดที่เขียนลงไปเลย — Lead เดิมจึงชี้ที่เดิมเสมอ
    expect(saved.data).not.toHaveProperty('code');
  });

  it('defaultCode คืนขั้นที่ติดธงตั้งต้น; closingCode คืนปลายทางตามชนิด', async () => {
    const { service } = harness();

    await expect(service.defaultCode('osd')).resolves.toBe('new');
    await expect(service.closingCode('osd', 'won')).resolves.toBe('converted');
    await expect(service.closingCode('osd', 'lost')).resolves.toBe(
      'disqualified',
    );
  });

  it('reorder ต้องส่ง id ครบทุกแถว — ส่งไม่ครบคือคำสั่งที่ตีความไม่ได้', async () => {
    const { service, rows } = harness();

    await expect(
      service.reorder({ ids: [rows[0].id, rows[1].id] }, principal()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
