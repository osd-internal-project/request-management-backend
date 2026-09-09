import { Principal } from '@request-management/share';
import { CustomerImportService } from './customer-import.service';
import { ImportCustomersDto } from './dto/customer.dto';

/** เลขผู้เสียภาษีที่ checksum ผ่าน (ธนาคารกรุงศรีฯ ใช้ในชุดทดสอบ CRM เดิม). */
const VALID_TAX_ID = '0107536001079';

function principal(): Principal {
  return {
    userId: 'me',
    displayName: 'ทดสอบ นำเข้า',
    activeCompanyId: 'osd',
    orgUnitId: 'unit-1',
    permissions: ['admin.crm.manage'],
  } as unknown as Principal;
}

function harness(options: { existing?: { customerCode: string } | null } = {}) {
  const customers = {
    findFirst: jest.fn(() => Promise.resolve(options.existing ?? null)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'cust-new',
        nameTh: args.data.nameTh,
        taxId: args.data.taxId,
      }),
    ),
  };
  const codes = { issue: jest.fn(() => Promise.resolve('CUS-OSD-000010')) };
  const dedup = { headOfficeOf: jest.fn(() => Promise.resolve(null)) };
  const timeline = { publish: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };

  const service = new CustomerImportService(
    customers as never,
    codes as never,
    dedup as never,
    timeline as never,
    audit as never,
    transactions as never,
  );

  return { service, customers, codes, dedup, timeline, audit };
}

function dto(overrides: Partial<ImportCustomersDto> = {}): ImportCustomersDto {
  return {
    mode: 'commit',
    import_id: 'imp-1',
    rows: [],
    ...overrides,
  } as ImportCustomersDto;
}

describe('CM-10 import ลูกค้าเดิมจาก Excel', () => {
  it('CM-10 a bad row reports and the good rows still land — the file never fails whole', async () => {
    const { service, customers } = harness();

    const result = await service.run(
      dto({
        rows: [
          { row_no: 2, name_th: 'บริษัท ดี จำกัด', tax_id: VALID_TAX_ID },
          { row_no: 3, name_th: 'บริษัท เสีย จำกัด', tax_id: '1234567890123' },
          { row_no: 4, name_th: '' },
        ] as never,
      }),
      principal(),
    );

    expect(result.summary).toEqual({ create: 1, skip: 0, error: 2 });
    expect(customers.create).toHaveBeenCalledTimes(1);
    expect(result.results[1].reasons).toContain('tax_id: checksum');
    expect(result.results[2].reasons).toContain('name_th: required');
  });

  it('CM-10 re-running the same file skips what it already created (idempotent by ภาษี+สาขา)', async () => {
    const { service, customers } = harness({
      existing: { customerCode: 'CUS-OSD-000001' },
    });

    const result = await service.run(
      dto({
        rows: [
          { row_no: 2, name_th: 'บริษัท ดี จำกัด', tax_id: VALID_TAX_ID },
        ] as never,
      }),
      principal(),
    );

    expect(result.summary).toEqual({ create: 0, skip: 1, error: 0 });
    expect(result.results[0].customerCode).toBe('CUS-OSD-000001');
    expect(customers.create).not.toHaveBeenCalled();
  });

  it('CM-10 dry_run writes nothing — no create, no audit, no timeline', async () => {
    const { service, customers, audit, timeline } = harness();

    const result = await service.run(
      dto({
        mode: 'dry_run',
        rows: [
          { row_no: 2, name_th: 'บริษัท ดี จำกัด', tax_id: VALID_TAX_ID },
        ] as never,
      }),
      principal(),
    );

    expect(result.summary.create).toBe(1);
    expect(customers.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(timeline.publish).not.toHaveBeenCalled();
  });

  it('CM-10 every created row carries the importId on its audit entry', async () => {
    const { service, audit } = harness();

    await service.run(
      dto({
        import_id: 'imp-42',
        rows: [
          { row_no: 2, name_th: 'บริษัท ดี จำกัด', tax_id: VALID_TAX_ID },
        ] as never,
      }),
      principal(),
    );

    const imported = (audit.record.mock.calls as never[][])
      .map((call) => call[0] as { eventType: string; after?: { importId?: string } })
      .find((entry) => entry.eventType === 'crm.customer.imported');
    expect(imported?.after?.importId).toBe('imp-42');
  });

  it('CM-10 a row sharing a tax id links to the head office like a normal create', async () => {
    const { service, dedup } = harness();
    dedup.headOfficeOf.mockResolvedValue({
      id: 'hq-1',
      customerCode: 'CUS-OSD-000001',
    } as never);

    const result = await service.run(
      dto({
        mode: 'dry_run',
        rows: [
          {
            row_no: 2,
            name_th: 'บริษัท ดี จำกัด',
            tax_id: VALID_TAX_ID,
            branch_code: '00002',
          },
        ] as never,
      }),
      principal(),
    );

    expect(result.results[0].headOfficeCode).toBe('CUS-OSD-000001');
  });
});
