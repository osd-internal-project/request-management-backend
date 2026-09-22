import type { Principal } from '@request-management/share';
import { RunNumberService } from './run-number.service';
import { RunNumberSettingsService } from './run-number-settings.service';

function principal(): Principal {
  return {
    userId: 'user-1',
    username: 'somchai',
    activeCompanyId: 'company-osd',
    permissions: ['admin.run-number.manage'],
    isServiceAccount: false,
  } as unknown as Principal;
}

/** setting หนึ่งแถว + counter ที่นับขึ้นทุกครั้งที่ถูกบวก. */
function harness(
  rows: Record<string, unknown>[],
  startAt = 0,
  taken: string[] = [],
) {
  let lastSeq = startAt;
  const bumps: unknown[][] = [];

  const settings = {
    findMany: jest.fn(() => Promise.resolve(rows)),
    findFirst: jest.fn(() => Promise.resolve(rows[0] ?? null)),
  };
  const counters = {
    findFirst: jest.fn(() =>
      Promise.resolve(startAt === 0 ? null : { lastSeq: startAt }),
    ),
  };
  const prisma = {
    $queryRaw: jest.fn((..._args: unknown[]) => {
      bumps.push(_args);
      return Promise.resolve([{ lastSeq: ++lastSeq }]);
    }),
  };
  const transactions = {
    execute: jest.fn((work: (client: unknown) => Promise<unknown>) =>
      work(prisma),
    ),
  };

  const service = new RunNumberService(
    settings as never,
    counters as never,
    transactions as never,
  );

  return { service, settings, counters, prisma, bumps, taken };
}

const requestSetting = {
  scopeKey: 'PS01',
  pattern: 'REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}',
  seqPadding: 4,
  startNumber: 1,
  resetPeriod: 'monthly',
};

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 'company-osd',
    docType: 'REQUEST' as const,
    scopeKey: 'PS01',
    companyPrefix: 'OSD',
    companyCode: 'OSD',
    at: new Date('2026-09-22T03:00:00Z'),
    ...overrides,
  };
}

describe('REQ-02 ออกเลขรัน', () => {
  it('ออกเลขตามรูปแบบที่ตั้งไว้', async () => {
    const { service } = harness([requestSetting]);

    await expect(service.issue(ctx())).resolves.toMatchObject({
      number: 'REQ-OSD-PS01-26090001',
      seq: 1,
      periodKey: '202609',
    });
  });

  it('บวก counter ด้วย statement เดียว ไม่ใช่อ่านแล้วเขียน', async () => {
    const { service, prisma } = harness([requestSetting]);

    await service.issue(ctx());

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = String(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('RETURNING');
  });

  it('ออกเลขในลำดับต่อกันเมื่อถูกเรียกซ้ำ', async () => {
    const { service } = harness([requestSetting]);

    const first = await service.issue(ctx());
    const second = await service.issue(ctx());

    expect(first.number).toBe('REQ-OSD-PS01-26090001');
    expect(second.number).toBe('REQ-OSD-PS01-26090002');
  });

  /** การวนหาเลขว่างเป็นหน้าที่ของผู้เรียก — ที่นี่หนึ่งคำขอกินลำดับเดียว. */
  it('กินลำดับครั้งเดียวต่อคำขอ', async () => {
    const { service, prisma } = harness([requestSetting]);

    await service.issue(ctx());

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('ใช้แถว scope เจาะจงก่อนแถว * ของชนิดเดียวกัน', async () => {
    const { service } = harness([
      { ...requestSetting, scopeKey: '*', pattern: 'FALLBACK-{SEQ}' },
      { ...requestSetting, scopeKey: 'PS01', pattern: 'EXACT-{SEQ}' },
    ]);

    await expect(service.issue(ctx())).resolves.toMatchObject({
      number: 'EXACT-0001',
    });
  });

  it('ใช้แถว * เมื่อไม่มีแถวของ scope นั้น', async () => {
    const { service } = harness([
      { ...requestSetting, scopeKey: '*', pattern: 'FALLBACK-{TYPE}-{SEQ}' },
    ]);

    await expect(
      service.issue(ctx({ scopeKey: 'XX99' })),
    ).resolves.toMatchObject({ number: 'FALLBACK-XX99-0001' });
  });

  it('ยังออกเลขได้เมื่อบริษัทไม่มีแถวเลย โดยใช้ค่าสำรองในโค้ด', async () => {
    const { service } = harness([]);

    await expect(service.issue(ctx())).resolves.toMatchObject({
      number: 'REQ-OSD-PS01-26090001',
    });
  });

  /** ตัวแปรที่ผู้เรียกลืมส่งต้องหยุดก่อนกินลำดับ ไม่ใช่ปล่อยเลขพิการออกไป. */
  it('ปฏิเสธเมื่อ master token ไม่มีค่า และไม่แตะ counter', async () => {
    const { service, prisma } = harness([
      { ...requestSetting, pattern: 'REQ-{M:ORG_UNIT}-{SEQ}' },
    ]);

    await expect(service.issue(ctx())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('ออกเลขได้เมื่อส่ง master token มาครบ', async () => {
    const { service } = harness([
      { ...requestSetting, pattern: 'REQ-{M:ORG_UNIT}-{SEQ}' },
    ]);

    await expect(
      service.issue(ctx({ master: { 'M:ORG_UNIT': 'IT' } })),
    ).resolves.toMatchObject({ number: 'REQ-IT-0001' });
  });

  it('เริ่มที่ startNumber ที่ตั้งไว้ ไม่ใช่ 1', async () => {
    const { service, prisma } = harness([
      { ...requestSetting, startNumber: 1001 },
    ]);

    await service.issue(ctx());

    // ค่าที่ถูกส่งเข้า INSERT คือ startNumber — แถวแรกของช่วงจึงเป็น 1001
    expect(prisma.$queryRaw.mock.calls[0]).toContain(1001);
  });
});

describe('ดูตัวอย่างเลขโดยไม่กิน counter', () => {
  it('ไม่แตะ counter', async () => {
    const { service, prisma } = harness([requestSetting]);

    await service.preview(ctx());

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('ใช้รูปแบบที่ยังไม่บันทึกเมื่อส่ง override มา', async () => {
    const { service } = harness([requestSetting]);

    await expect(
      service.preview(ctx(), {
        pattern: 'NEW-{BYY}-{SEQ}',
        seqPadding: 5,
        startNumber: 7,
        resetPeriod: 'yearly',
      }),
    ).resolves.toMatchObject({ number: 'NEW-69-00007', periodKey: '2026' });
  });

  it('เลขถัดไปคือ lastSeq + 1 เมื่อมี counter อยู่แล้ว', async () => {
    const { service } = harness([requestSetting], 41);

    await expect(service.preview(ctx())).resolves.toMatchObject({
      number: 'REQ-OSD-PS01-26090042',
      seq: 42,
    });
  });
});

describe('สิทธิ์และขอบเขตของหน้าตั้งค่า', () => {
  function settingsHarness(rows: Record<string, unknown>[]) {
    const audits: { eventType: string }[] = [];
    const store = [...rows];

    const repo = {
      findMany: jest.fn(() => Promise.resolve(store)),
      findFirst: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          store.find((row) =>
            Object.entries(where).every(([key, value]) => row[key] === value),
          ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'new', ...data }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...store[0], ...data }),
      ),
      delete: jest.fn(() => Promise.resolve(store[0])),
      count: jest.fn(() => Promise.resolve(0)),
    };
    const audit = {
      record: jest.fn((entry: { eventType: string }) => {
        audits.push(entry);
        return Promise.resolve();
      }),
    };
    const transactions = {
      execute: jest.fn((work: (client: unknown) => Promise<unknown>) =>
        work({}),
      ),
    };

    return {
      service: new RunNumberSettingsService(
        repo as never,
        audit as never,
        transactions as never,
      ),
      repo,
      audits,
    };
  }

  const row = {
    id: 'setting-1',
    companyId: 'company-osd',
    docType: 'REQUEST',
    scopeKey: 'PS01',
    pattern: 'REQ-{COMPANY_PREFIX}-{TYPE}-{YYMM}{SEQ}',
    seqPadding: 4,
    startNumber: 1,
    resetPeriod: 'monthly',
    active: true,
  };

  it('ปฏิเสธรูปแบบที่ไม่มี {SEQ} ตอนบันทึก', async () => {
    const { service, repo } = settingsHarness([]);

    await expect(
      service.create(
        { doc_type: 'REQUEST', pattern: 'REQ-{BYY}' },
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('เขียน audit ใน transaction เดียวกับการสร้าง', async () => {
    const { service, audits } = settingsHarness([]);

    await service.create(
      { doc_type: 'REQUEST', pattern: 'REQ-{SEQ}' },
      principal(),
    );

    expect(audits.map((entry) => entry.eventType)).toEqual([
      'run_number.setting.created',
    ]);
  });

  it('ตอบ 404 ไม่ใช่ 403 เมื่อแถวเป็นของบริษัทอื่น (SCOPE-03)', async () => {
    const { service } = settingsHarness([
      { ...row, companyId: 'company-other' },
    ]);

    await expect(
      service.update('setting-1', { pattern: 'X-{SEQ}' }, principal()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('ลบแถวที่ใช้งานอยู่แถวสุดท้ายของชนิดเอกสารไม่ได้', async () => {
    const { service } = settingsHarness([row]);

    await expect(
      service.remove('setting-1', principal()),
    ).rejects.toMatchObject({ code: 'RUN_NUMBER_SETTING_IN_USE' });
  });

  it('บอกตัวแปรที่ชนิดเอกสารนั้นใช้ได้ และปฏิเสธชนิดที่ไม่รู้จัก', () => {
    const { service } = settingsHarness([]);

    expect(service.tokens('REQUEST').map((t) => t.token)).toContain(
      'M:REQUEST_TYPE',
    );
    expect(() => service.tokens('NOPE')).toThrow();
  });
});
