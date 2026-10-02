import type { Principal } from '@request-management/share';
import { EmployeesService } from './employees.service';

const member = {
  user: {
    id: 'u-1',
    displayName: 'สมชาย',
    email: 's@osd.co.th',
    employeeId: 'EMP-001',
    position: 'Engineer',
    phone: null,
    extension: null,
    startWork: new Date('2020-01-01T00:00:00Z'),
    status: 'ACTIVE',
    orgUnit: { id: 'ou', name: 'ทีมติดตั้ง' },
    supervisor: null,
  },
};

const actor = (userId: string, permissions: string[]) =>
  ({ userId, activeCompanyId: 'osd', permissions }) as unknown as Principal;

function harness(
  options: {
    level?: unknown;
    skills?: { id: string }[];
    subordinates?: string[];
    profile?: Record<string, unknown>;
  } = {},
) {
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const tx = {
    hrEmployee: { upsert: jest.fn(() => Promise.resolve({})) },
    hrUserSkill: {
      upsert: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
  const service = new EmployeesService(
    {
      findFirst: jest.fn(() => Promise.resolve(member)),
      findMany: jest.fn(() => Promise.resolve([member])),
    } as never,
    {
      findMany: jest.fn(() =>
        Promise.resolve(
          options.profile
            ? [
                {
                  userId: 'u-1',
                  levelId: 'L1',
                  level: { id: 'L1', code: 'SE-1', name: 'วิศวกร' },
                  employmentType: 'contract',
                  status: 'active',
                  endDate: new Date('2026-12-31T00:00:00Z'),
                  note: 'ต่อสัญญาปีละครั้ง',
                  updatedAt: new Date(),
                  ...options.profile,
                },
              ]
            : [],
        ),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.level === undefined ? { id: 'L1' } : options.level,
        ),
      ),
    } as never,
    {
      findMany: jest.fn(() =>
        Promise.resolve(options.skills ?? [{ id: 'S1' }]),
      ),
    } as never,
    { findMany: jest.fn(() => Promise.resolve([])) } as never,
    {
      subordinatesOf: jest.fn(() =>
        Promise.resolve(options.subordinates ?? []),
      ),
    } as never,
    audit as never,
    { execute: (fn: (prisma: unknown) => Promise<unknown>) => fn(tx) } as never,
  );
  return { service, tx, audit };
}

describe('CD-229 ทะเบียนพนักงาน', () => {
  it('ข้อมูลจากไดเรกทอรี + ของ HR (ยังไม่บันทึก = ค่าตั้งต้น)', async () => {
    const { service } = harness();
    const row = await service.findOne(actor('hr', ['hr.employee.read']), 'u-1');
    expect(row).toMatchObject({
      displayName: 'สมชาย',
      employeeId: 'EMP-001',
      startWork: '2020-01-01',
      orgUnit: { name: 'ทีมติดตั้ง' },
      profile: { saved: false, employmentType: 'permanent', status: 'active' },
      skills: [],
    });
  });

  it('เจ้าตัวเห็นโปรไฟล์ตัวเอง; คนอื่นที่ไม่มีสิทธิ์ = 404', async () => {
    const { service } = harness();
    await expect(
      service.findOne(actor('u-1', []), 'u-1'),
    ).resolves.toBeDefined();
    await expect(
      service.findOne(actor('u-2', []), 'u-1'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('ระดับต้องเป็นของบริษัทนี้', async () => {
    const { service, tx } = harness({ level: null });
    await expect(
      service.saveProfile(actor('hr', ['hr.employee.manage']), 'u-1', {
        level_id: 'other-company-level',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(tx.hrEmployee.upsert).not.toHaveBeenCalled();
  });

  it('บันทึกทักษะทั้งชุด — ที่ไม่ส่งมาถูกถอดแบบไม่ลบจริง', async () => {
    const { service, tx } = harness();
    await service.saveSkills(actor('hr', ['hr.employee.manage']), 'u-1', {
      skills: [{ skill_id: 'S1', proficiency: 2 }],
    });
    expect(tx.hrUserSkill.upsert).toHaveBeenCalledTimes(1);
    const [removal] = tx.hrUserSkill.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: { deletedAt: Date } },
    ];
    expect(removal.where).toMatchObject({
      userId: 'u-1',
      skillId: { notIn: ['S1'] },
    });
    expect(removal.data.deletedAt).toBeInstanceOf(Date);
  });

  it('ทักษะซ้ำ หรือไม่อยู่ในรายการ = VALIDATION_FAILED', async () => {
    const manager = actor('hr', ['hr.employee.manage']);
    await expect(
      harness().service.saveSkills(manager, 'u-1', {
        skills: [
          { skill_id: 'S1', proficiency: 1 },
          { skill_id: 'S1', proficiency: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      harness({ skills: [] }).service.saveSkills(manager, 'u-1', {
        skills: [{ skill_id: 'X', proficiency: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('CD-230 สิทธิ์และการปกปิดข้อมูลพนักงาน', () => {
  it('หัวหน้าเห็นลูกทีมใต้สายบังคับบัญชา — ไม่เห็นเงื่อนไขการจ้างและหมายเหตุ; การเปิดดูถูกบันทึก', async () => {
    const { service, audit } = harness({ subordinates: ['u-1'], profile: {} });
    const row = await service.findOne(actor('boss', []), 'u-1');
    expect(row.profile).toEqual({
      saved: true,
      levelId: 'L1',
      level: { id: 'L1', code: 'SE-1', name: 'วิศวกร' },
      status: 'active',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'hr.employee.viewed',
        resourceId: 'u-1',
        after: { as: 'supervisor' },
      }),
    );
  });

  it('คนที่ไม่ใช่หัวหน้า ไม่ใช่ HR = 404', async () => {
    const { service } = harness({ subordinates: ['someone-else'] });
    await expect(
      service.findOne(actor('peer', []), 'u-1'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('HR เห็นครบ และการดูถูกบันทึก; ดูของตัวเองไม่บันทึก', async () => {
    const hr = harness({ profile: {} });
    const row = await hr.service.findOne(
      actor('hr', ['hr.employee.read']),
      'u-1',
    );
    expect(row.profile).toMatchObject({
      employmentType: 'contract',
      note: 'ต่อสัญญาปีละครั้ง',
    });
    expect(hr.audit.record).toHaveBeenCalled();

    const self = harness({ profile: {} });
    await self.service.findOne(actor('u-1', []), 'u-1');
    expect(self.audit.record).not.toHaveBeenCalled();
  });

  it('รายชื่อทีมงานสำหรับ PM: ชื่อ สังกัด ระดับ ทักษะ — ไม่มีการจ้าง และไม่มีคนที่ลาออก', async () => {
    const working = harness({ profile: {} });
    const { items } = await working.service.staff(
      actor('pm', ['pm.project.manage']),
      {},
    );
    expect(items).toHaveLength(1);
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        'displayName',
        'level',
        'orgUnit',
        'position',
        'skills',
        'userId',
      ].sort(),
    );

    const resigned = harness({ profile: { status: 'resigned' } });
    expect(
      (await resigned.service.staff(actor('pm', ['pm.project.manage']), {}))
        .items,
    ).toHaveLength(0);
  });
});
