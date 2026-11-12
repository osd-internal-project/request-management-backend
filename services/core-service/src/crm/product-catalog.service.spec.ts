import { ProductCatalogService } from './product-catalog.service';
import type { ErpItem } from '../erp/erp-client';

type Row = {
  code: string;
  name: string;
  unit: string | null;
  active: boolean;
  source?: string;
};

function harness(options: { existing?: Row[]; sap?: ErpItem[] } = {}) {
  const rows: Row[] = [...(options.existing ?? [])];

  const products = {
    findMany: jest.fn(
      (args: { where: { code?: { in: string[] }; active?: boolean } }) =>
        Promise.resolve(
          rows.filter(
            (row) =>
              (!args.where.code || args.where.code.in.includes(row.code)) &&
              (args.where.active === undefined ||
                row.active === args.where.active),
          ),
        ),
    ),
    count: jest.fn(() => Promise.resolve(rows.length)),
    findFirst: jest.fn((args: { where: { code: { equals: string } } }) =>
      Promise.resolve(
        rows.find(
          (row) =>
            row.code.toLowerCase() === args.where.code.equals.toLowerCase(),
        ) ?? null,
      ),
    ),
    create: jest.fn((args: { data: Row }) => {
      rows.push({ ...args.data, active: true });
      return Promise.resolve({ id: 'p1', ...args.data, active: true });
    }),
    createMany: jest.fn((args: { data: Row[] }) => {
      rows.push(...args.data);
      return Promise.resolve({ count: args.data.length });
    }),
    update: jest.fn(
      (args: {
        where: { companyId_code: { code: string } };
        data: Partial<Row>;
      }) => {
        const row = rows.find((r) => r.code === args.where.companyId_code.code);
        Object.assign(row ?? {}, args.data);
        return Promise.resolve(row);
      },
    ),
    updateMany: jest.fn(
      (args: { where: { code: { in: string[] } }; data: Partial<Row> }) => {
        for (const row of rows) {
          if (args.where.code.in.includes(row.code))
            Object.assign(row, args.data);
        }
        return Promise.resolve({ count: 0 });
      },
    ),
  };
  const erp = { listItems: jest.fn(() => Promise.resolve(options.sap ?? [])) };

  const service = new ProductCatalogService(
    products as never,
    {} as never,
    erp as never,
    { record: jest.fn() } as never,
    { get: jest.fn(() => 0) } as never,
  );
  return { service, rows, products, erp };
}

const OSD = { id: 'osd', code: 'OSD' };

describe('CD-27 รายการสินค้าจาก SAP', () => {
  it('sync: ใหม่ = สร้าง, เปลี่ยน = แก้, หายจาก SAP = เลิกขาย (ไม่ลบ), ไม่เปลี่ยน = ไม่แตะ', async () => {
    const h = harness({
      existing: [
        { code: 'SIP-TRUNK', name: 'SIP Trunk', unit: 'ช่อง', active: true },
        { code: 'HEADSET', name: 'Headset', unit: 'อัน', active: true },
        { code: 'OLD-PBX', name: 'PBX', unit: null, active: true },
      ],
      sap: [
        { code: 'SIP-TRUNK', name: 'SIP Trunk', unit: 'ช่อง', active: true },
        { code: 'HEADSET', name: 'Headset USB', unit: 'อัน', active: true },
        { code: 'SERVER', name: 'Server', unit: 'เครื่อง', active: true },
      ],
    });

    const result = await h.service.syncCompany(OSD);

    expect(h.erp.listItems).toHaveBeenCalledWith({ companyCode: 'OSD' });
    expect(result).toEqual({
      total: 3,
      created: 1,
      updated: 1,
      deactivated: 1,
    });
    expect(h.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'SERVER', active: true }),
        expect.objectContaining({ code: 'HEADSET', name: 'Headset USB' }),
        expect.objectContaining({ code: 'OLD-PBX', active: false }),
      ]),
    );
    // SIP-TRUNK unchanged — only its syncedAt moves, via updateMany
    expect(h.products.update).toHaveBeenCalledTimes(1);
  });

  it('ตรวจรหัสบนบรรทัด: รหัสที่ SAP ไม่มีหรือเลิกขาย = VALIDATION_FAILED ชี้บรรทัด', async () => {
    const h = harness({
      existing: [
        { code: 'SIP-TRUNK', name: 'SIP Trunk', unit: 'ช่อง', active: true },
        { code: 'OLD-PBX', name: 'PBX', unit: null, active: false },
      ],
    });

    await expect(
      h.service.assertKnownCodes('osd', [
        { product_code: 'SIP-TRUNK' },
        { product_code: null },
        { product_code: 'OLD-PBX' },
        { product_code: 'TYPO-123' },
      ]),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        { field: 'lines[2].product_code', reason: 'OLD-PBX' },
        { field: 'lines[3].product_code', reason: 'TYPO-123' },
      ],
    });
  });

  it('บรรทัดบริการ (ไม่มีรหัส) และรหัสที่มีอยู่ ผ่าน', async () => {
    const h = harness({
      existing: [
        { code: 'SIP-TRUNK', name: 'SIP Trunk', unit: 'ช่อง', active: true },
      ],
    });

    await expect(
      h.service.assertKnownCodes('osd', [
        { product_code: ' SIP-TRUNK ' },
        { product_code: '' },
        {},
      ]),
    ).resolves.toBeUndefined();
  });

  it('บริษัทที่ยังไม่เคย sync → ยังไม่ตรวจ (ไม่มีอะไรให้เทียบ ไม่ขวางการทำงาน)', async () => {
    const h = harness();

    await expect(
      h.service.assertKnownCodes('osd', [{ product_code: 'ANYTHING' }]),
    ).resolves.toBeUndefined();
  });

  describe('สินค้าที่กรอกเอง (ยังไม่มี ERP)', () => {
    const actor = { activeCompanyId: 'osd', userId: 'u1' } as never;

    it('sync ไม่ปิดสินค้าที่กรอกเอง; SAP มีรหัสเดียวกันเมื่อไร SAP เป็นเจ้าของแทน', async () => {
      const { service, rows } = harness({
        existing: [
          {
            code: 'ATOM',
            name: 'ATOM',
            unit: null,
            active: true,
            source: 'manual',
          },
          {
            code: 'VUVA',
            name: 'พิมพ์เอง',
            unit: null,
            active: true,
            source: 'manual',
          },
        ],
        sap: [
          { code: 'VUVA', name: 'Vuvagent', unit: 'license', active: true },
        ],
      });

      const result = await service.syncCompany(OSD);

      expect(result.deactivated).toBe(0);
      expect(rows.find((row) => row.code === 'ATOM')).toMatchObject({
        active: true,
        source: 'manual',
      });
      expect(rows.find((row) => row.code === 'VUVA')).toMatchObject({
        name: 'Vuvagent',
        source: 'sap',
      });
    });

    it('เพิ่มสินค้าเอง: เก็บเป็น manual; รหัสซ้ำ (ไม่สนตัวพิมพ์) = CONFLICT; ไม่มีชื่อ = VALIDATION_FAILED', async () => {
      const { service, rows } = harness();

      await expect(
        service.createManual({ code: ' ATOM ', name: 'ATOM Platform' }, actor),
      ).resolves.toMatchObject({
        code: 'ATOM',
        name: 'ATOM Platform',
        unit: null,
      });
      expect(rows[0]).toMatchObject({ code: 'ATOM', source: 'manual' });

      await expect(
        service.createManual({ code: 'atom', name: 'อีกตัว' }, actor),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(
        service.createManual({ code: 'A B', name: '' }, actor),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });
});
