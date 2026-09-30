import type { Principal } from '@request-management/share';
import type { ErpVendor } from '../erp/erp-client';
import { PartnersService } from './partners.service';

const presales = {
  userId: 'ps-1',
  activeCompanyId: 'osd',
  permissions: ['presales.solution.manage'],
} as unknown as Principal;

const VENDORS: ErpVendor[] = [
  {
    code: 'V001',
    name: 'ผู้จัดจำหน่าย ก',
    taxId: '0105500000001',
    phone: null,
    email: null,
    currency: 'THB',
    paymentTerms: '30 วัน',
    active: true,
  },
  {
    code: 'V002',
    name: 'ผู้ขายถูกระงับ',
    taxId: null,
    phone: null,
    email: null,
    currency: null,
    paymentTerms: null,
    active: false,
  },
];

function harness(
  options: { sapDown?: boolean; profile?: Record<string, unknown> | null } = {},
) {
  const profile =
    options.profile === undefined
      ? {
          id: 'p-1',
          companyId: 'osd',
          vendorCode: 'V001',
          vendorNameSeen: 'ชื่อเก่า',
          summary: 'ทีม SD-WAN',
          brands: [
            { brand: 'Fortinet', level: 'Gold', expiresOn: '2000-01-01' },
          ],
          certifications: [],
          contacts: [],
          updatedAt: new Date(),
          updatedBy: 'ps-1',
        }
      : options.profile;
  const partners = {
    findMany: jest.fn(() => Promise.resolve(profile ? [profile] : [])),
    findFirst: jest.fn(({ where }: { where: { vendorCode: string } }) =>
      Promise.resolve(
        profile && where.vendorCode === profile.vendorCode ? profile : null,
      ),
    ),
    create: jest.fn(() => Promise.resolve({ id: 'p-new' })),
    update: jest.fn(() => Promise.resolve({ id: 'p-1' })),
  };
  const files = {
    findMany: jest.fn(() => Promise.resolve([])),
    findFirst: jest.fn(() => Promise.resolve(null)),
    count: jest.fn(() => Promise.resolve(0)),
    create: jest.fn(() => Promise.resolve({ id: 'f-1' })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const companies = {
    findFirst: jest.fn(() => Promise.resolve({ code: 'OSD' })),
  };
  const erp = {
    listVendors: jest.fn(() =>
      options.sapDown
        ? Promise.reject(new Error('SAP down'))
        : Promise.resolve(VENDORS),
    ),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => Promise<unknown>) => fn({})),
  };
  const storage = {
    put: jest.fn(() => Promise.resolve()),
    remove: jest.fn(() => Promise.resolve()),
  };
  const service = new PartnersService(
    partners as never,
    files as never,
    companies as never,
    erp as never,
    audit as never,
    transactions as never,
    storage as never,
  );
  return { service, partners, files, erp, audit, storage };
}

describe('PartnersService (CD-142)', () => {
  it('lists SAP suppliers, profiled first, with name and status from SAP', async () => {
    const { service } = harness();
    const result = await service.list(presales);
    expect(result.sap_available).toBe(true);
    expect(
      result.items.map((row) => [row.code, row.name, row.has_profile]),
    ).toEqual([
      ['V001', 'ผู้จัดจำหน่าย ก', true],
      ['V002', 'ผู้ขายถูกระงับ', false],
    ]);
    expect(result.items[0].expiry).toEqual({ expired: 1, expiring: 0 });
  });

  it('active=1 leaves out suppliers blocked in SAP; q searches brands too', async () => {
    const { service } = harness();
    expect((await service.list(presales, '', true)).items).toHaveLength(1);
    expect(
      (await service.list(presales, 'forti')).items.map((row) => row.code),
    ).toEqual(['V001']);
  });

  it('reads SAP once per cache window', async () => {
    const { service, erp } = harness();
    await service.list(presales);
    await service.findOne('V001', presales);
    expect(erp.listVendors).toHaveBeenCalledTimes(1);
  });

  it('with SAP down, shows kept profiles by the name last seen', async () => {
    const { service } = harness({ sapDown: true });
    const result = await service.list(presales);
    expect(result.sap_available).toBe(false);
    expect(result.items).toEqual([
      expect.objectContaining({ code: 'V001', name: 'ชื่อเก่า', active: null }),
    ]);
  });

  it('starts a profile only for a code SAP confirms, and audits it', async () => {
    const { service, partners, audit } = harness({ profile: null });
    await expect(
      service.save('NOPE', { summary: 'x' }, presales),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await service.save('V002', { summary: 'ทีมเดินสาย' }, presales);
    expect(partners.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          companyId: 'osd',
          vendorCode: 'V002',
          vendorNameSeen: 'ผู้ขายถูกระงับ',
          summary: 'ทีมเดินสาย',
        }) as unknown,
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'presales.partner.created' }),
      { prisma: {} },
    );
  });

  it('refuses to start a profile while SAP is down, but edits an existing one', async () => {
    const down = harness({ sapDown: true, profile: null });
    await expect(
      down.service.save('V001', { summary: 'x' }, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const kept = harness({ sapDown: true });
    await kept.service.save('V001', { summary: 'แก้ไข' }, presales);
    expect(kept.partners.update).toHaveBeenCalledWith(
      {
        where: { id: 'p-1' },
        data: expect.objectContaining({
          summary: 'แก้ไข',
          vendorNameSeen: 'ชื่อเก่า',
        }) as unknown,
      },
      { prisma: {} },
    );
  });

  it('rejects an invalid profile with the problems', async () => {
    const { service, partners } = harness();
    await expect(
      service.save(
        'V001',
        { brands: [{ brand: 'A', expires_on: 'soon' }] },
        presales,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(partners.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a code neither SAP nor a profile knows (SCOPE-03)', async () => {
    const { service } = harness();
    await expect(service.findOne('ZZZ', presales)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('needs a saved profile before a file, and stores it under the partner', async () => {
    const file = {
      originalname: 'cert.pdf',
      mimetype: 'application/pdf',
      size: 10,
      buffer: Buffer.from('x'),
    };
    const none = harness({ profile: null });
    await expect(
      none.service.uploadFile('V001', 'certificate', file, presales),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const { service, files, storage } = harness();
    await service.uploadFile('V001', 'certificate', file, presales);
    expect(storage.put).toHaveBeenCalledWith(
      expect.stringMatching(/^partners\/p-1\/.+\/cert\.pdf$/),
      file.buffer,
      expect.anything(),
    );
    expect(files.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          partnerId: 'p-1',
          category: 'certificate',
        }) as unknown,
      },
      { prisma: {} },
    );
  });
});
