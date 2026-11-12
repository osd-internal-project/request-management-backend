import { ProductCatalogService } from './product-catalog.service';
import type { ErpItem } from '../erp/erp-client';

type Row = {
  id?: string;
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
    findFirst: jest.fn(
      (args: {
        where: { id?: string; active?: boolean; code?: { equals: string } };
      }) =>
        Promise.resolve(
          rows.find(
            (row) =>
              (!args.where.id || row.id === args.where.id) &&
              (args.where.active === undefined ||
                row.active === args.where.active) &&
              (!args.where.code ||
                row.code.toLowerCase() ===
                  args.where.code.equals.toLowerCase()),
          ) ?? null,
        ),
    ),
    create: jest.fn((args: { data: Row }) => {
      const row = { ...args.data, id: `p${rows.length + 1}`, active: true };
      rows.push(row);
      return Promise.resolve(row);
    }),
    createMany: jest.fn((args: { data: Row[] }) => {
      rows.push(...args.data);
      return Promise.resolve({ count: args.data.length });
    }),
    update: jest.fn(
      (args: {
        where: { id?: string; companyId_code?: { code: string } };
        data: Partial<Row>;
      }) => {
        const row = rows.find((r) =>
          args.where.id
            ? r.id === args.where.id
            : r.code === args.where.companyId_code?.code,
        );
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

    it('แก้ชื่อ/หน่วยได้; ลบ = เลิกขาย แถวยังอยู่; เพิ่มรหัสเดิมซ้ำ = เปิดแถวเดิมกลับมา', async () => {
      const { service, rows } = harness();
      const made = await service.createManual(
        { code: 'ATOM', name: 'พิมพ์ผิด', unit: 'ชุด' },
        actor,
      );

      await expect(
        service.updateManual(made.id, { name: 'ATOM Platform' }, actor),
      ).resolves.toMatchObject({ name: 'ATOM Platform', unit: 'ชุด' });
      await expect(
        service.updateManual(made.id, { name: ' ' }, actor),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      await service.removeManual(made.id, actor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ code: 'ATOM', active: false });
      await expect(
        service.updateManual(made.id, { name: 'x' }, actor),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await service.createManual({ code: 'atom', name: 'กลับมา' }, actor);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        code: 'ATOM',
        name: 'กลับมา',
        unit: null,
        active: true,
      });
    });

    it('สินค้าจาก SAP แก้และลบจากที่นี่ไม่ได้ (409)', async () => {
      const { service } = harness({
        existing: [
          {
            id: 's1',
            code: 'IP-PHONE',
            name: 'IP Phone',
            unit: null,
            active: true,
            source: 'sap',
          },
        ],
      });

      await expect(
        service.updateManual('s1', { name: 'x' }, actor),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(service.removeManual('s1', actor)).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    });
  });
});
