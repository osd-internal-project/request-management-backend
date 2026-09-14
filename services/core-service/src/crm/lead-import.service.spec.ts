import { Principal } from '@request-management/share';
import { LeadImportService } from './lead-import.service';
import { ImportLeadsDto } from './dto/sales.dto';

function principal(): Principal {
  return {
    userId: 'me',
    displayName: 'ทดสอบ นำเข้า',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-sales',
    permissions: ['crm.sales.manage'],
  } as unknown as Principal;
}

function harness(
  options: { existing?: { id: string; name: string } | null } = {},
) {
  const leads = {
    findFirst: jest.fn(() => Promise.resolve(options.existing ?? null)),
    create: jest.fn(() => Promise.resolve({ id: 'lead-new' })),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((work: (prisma: unknown) => unknown) => work({})),
  };

  // ขั้นตั้งต้นมาจากหน้าตั้งค่า — importer ถามครั้งเดียวต่อรอบ
  const statuses = { defaultCode: jest.fn(() => Promise.resolve('new')) };

  const service = new LeadImportService(
    leads as never,
    audit as never,
    transactions as never,
    statuses as never,
  );

  return { service, leads, audit };
}

function dto(overrides: Partial<ImportLeadsDto> = {}): ImportLeadsDto {
  return {
    mode: 'commit',
    import_id: 'imp-1',
    rows: [],
    ...overrides,
  };
}

describe('Import Lead จาก Excel — สูตรเดียวกับ CM-10', () => {
  it('แถวดีเข้าได้ แถวเสียรายงานรายแถว ไม่ล้มทั้งไฟล์', async () => {
    const { service, leads } = harness();

    const result = await service.run(
      dto({
        rows: [
          { row_no: 2, name: 'บริษัท เป้าหมาย จำกัด', phone: '0812345678' },
          { row_no: 3, name: '', email: 'x@y.co' },
          { row_no: 4, name: 'อีเมลพัง', email: 'not-an-email' },
        ] as never,
      }),
      principal(),
    );

    expect(result.summary).toEqual({ create: 1, skip: 0, error: 2 });
    expect(leads.create).toHaveBeenCalledTimes(1);
    expect(result.results[1].reasons).toContain('name: required');
    expect(result.results[2].reasons).toContain('email: format');
  });

  it('อีเมล/เบอร์ที่มี Lead อยู่แล้ว = ข้าม (รันไฟล์งานอีเวนต์ซ้ำไม่สร้างซ้ำ)', async () => {
    const { service, leads } = harness({
      existing: { id: 'lead-old', name: 'บริษัท เดิม จำกัด' },
    });

    const result = await service.run(
      dto({
        rows: [
          { row_no: 2, name: 'บริษัท เดิม จำกัด', email: 'a@b.co' },
        ] as never,
      }),
      principal(),
    );

    expect(result.summary).toEqual({ create: 0, skip: 1, error: 0 });
    expect(result.results[0].leadId).toBe('lead-old');
    expect(leads.create).not.toHaveBeenCalled();
  });

  it('dry_run ไม่เขียนอะไร — ไม่ create ไม่ audit', async () => {
    const { service, leads, audit } = harness();

    const result = await service.run(
      dto({
        mode: 'dry_run',
        rows: [{ row_no: 2, name: 'ใหม่', phone: '021234567' }] as never,
      }),
      principal(),
    );

    expect(result.summary.create).toBe(1);
    expect(leads.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ทุกแถวที่สร้างลง audit ระบุ importId', async () => {
    const { service, audit } = harness();

    await service.run(
      dto({
        import_id: 'imp-42',
        rows: [{ row_no: 2, name: 'ใหม่', phone: '021234567' }] as never,
      }),
      principal(),
    );

    const imported = (audit.record.mock.calls as never[][])
      .map(
        (call) =>
          call[0] as { eventType: string; after?: { importId?: string } },
      )
      .find((entry) => entry.eventType === 'crm.lead.imported');
    expect(imported?.after?.importId).toBe('imp-42');
  });
});
