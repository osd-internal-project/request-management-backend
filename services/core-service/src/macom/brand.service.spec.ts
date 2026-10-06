import type { Principal } from '@request-management/share';
import { BrandService } from './brand.service';
import { BrandFilesService } from './brand-files.service';

const staff = {
  userId: 'u-staff',
  activeCompanyId: 'osd',
  permissions: ['request.read'],
} as unknown as Principal;
const macom = {
  userId: 'u-mkt',
  activeCompanyId: 'osd',
  permissions: ['crm.campaign.manage'],
} as unknown as Principal;

const asset = (overrides: Record<string, unknown> = {}) => ({
  id: 'a-1',
  companyId: 'osd',
  category: 'logo',
  name: 'โลโก้บริษัท',
  description: null,
  tags: ['logo'],
  currentVersionId: 'v-2',
  retiredAt: null,
  retireReason: null,
  updatedAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'v-2',
  companyId: 'osd',
  assetId: 'a-1',
  versionNo: 2,
  fileName: 'logo.png',
  mimeType: 'image/png',
  sizeBytes: 100,
  storageKey: 'brand/a-1/x/logo.png',
  note: null,
  status: 'approved',
  approvalRequestId: 'req-2',
  decidedAt: new Date('2026-10-02T00:00:00Z'),
  decisionNote: null,
  uploadedBy: 'u-mkt',
  createdAt: new Date('2026-10-02T00:00:00Z'),
  ...overrides,
});

function harness(
  options: {
    assetFound?: unknown;
    versions?: unknown[];
    pending?: unknown;
    typeCode?: string | null;
  } = {},
) {
  const assets = {
    findMany: jest.fn(() => Promise.resolve([asset()])),
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.assetFound === undefined ? asset() : options.assetFound,
      ),
    ),
    update: jest.fn(() => Promise.resolve({})),
  };
  const versions = {
    findMany: jest.fn(() =>
      Promise.resolve(
        options.versions ?? [version(), version({ id: 'v-1', versionNo: 1 })],
      ),
    ),
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.pending === undefined ? version() : options.pending,
      ),
    ),
    updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    update: jest.fn(() => Promise.resolve({})),
    create: jest.fn(() => Promise.resolve({ id: 'v-new' })),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-9', requestNo: 'REQ-9' })),
    submit: jest.fn(() => Promise.resolve({})),
    cancel: jest.fn(() => Promise.resolve({})),
  };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        brandApprovalTypeCode:
          options.typeCode === undefined ? 'BRA' : options.typeCode,
      }),
    ),
  };
  const people = {
    findMany: jest.fn(() =>
      Promise.resolve([{ id: 'u-mkt', displayName: 'ฝ่ายการตลาด' }]),
    ),
  };
  const notifications = { brandVersion: jest.fn(() => Promise.resolve()) };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };
  const service = new BrandService(
    assets as never,
    versions as never,
    requests as never,
    configs as never,
    people as never,
    { on: jest.fn() } as never,
    notifications as never,
    audit as never,
    transactions as never,
  );
  const storage = {
    put: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve('stream')),
    remove: jest.fn(() => Promise.resolve()),
  };
  const files = new BrandFilesService(
    service,
    versions as never,
    transactions as never,
    audit as never,
    storage as never,
  );
  return { service, files, assets, versions, requests, notifications, storage };
}

describe('CD-273 brand library', () => {
  it('staff see only assets with an approved version; MACOM sees the rest', async () => {
    const forStaff = harness();
    await forStaff.service.list(staff, {});
    expect(forStaff.assets.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          currentVersionId: { not: null },
          retiredAt: null,
        }),
      }),
    );
    const forMacom = harness();
    await forMacom.service.list(macom, {});
    const where = (
      forMacom.assets.findMany.mock.calls[0] as unknown as [
        { where: Record<string, unknown> },
      ]
    )[0].where;
    expect(where.currentVersionId).toBeUndefined();
  });

  it('the history is MACOM’s; staff get the current version only', async () => {
    const a = await harness().service.one(staff, 'a-1');
    expect(a.current).toMatchObject({ version_no: 2 });
    expect(a.versions).toEqual([]);
    const b = await harness().service.one(macom, 'a-1');
    expect(b.versions.map((v) => v.status)).toEqual(['current', 'approved']);
  });

  it('staff cannot download an old version', async () => {
    const { files } = harness();
    await expect(files.file(staff, 'a-1', 'v-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(files.file(staff, 'a-1')).resolves.toMatchObject({
      fileName: 'logo.png',
    });
  });

  it('a new version waits for approval; one already waiting blocks another', async () => {
    const upload = {
      originalname: 'logo-v3.png',
      mimetype: 'image/png',
      size: 100,
      buffer: Buffer.from('x'),
    };
    const ok = harness();
    await ok.files.addVersion(macom, 'a-1', 'สีใหม่', upload);
    expect(ok.versions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ versionNo: 3, note: 'สีใหม่' }),
      }),
    );
    expect(ok.requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'BRA',
        form_data: expect.objectContaining({
          version_no: '3',
          file_name: 'logo-v3.png',
        }),
      }),
      macom,
    );
    expect(ok.requests.submit).toHaveBeenCalledWith('req-9', macom, '');

    const busy = harness({
      versions: [
        version(),
        version({ id: 'v-3', versionNo: 3, status: 'pending' }),
      ],
    });
    await expect(
      busy.files.addVersion(macom, 'a-1', undefined, upload),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const unset = harness({ typeCode: null });
    await expect(
      unset.files.addVersion(macom, 'a-1', undefined, upload),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(unset.storage.put).not.toHaveBeenCalled();
  });

  it('approved → becomes current and the uploader hears; rejected stays out', async () => {
    const pending = version({
      id: 'v-3',
      versionNo: 3,
      status: 'pending',
      approvalRequestId: 'req-9',
    });
    const ok = harness({ pending });
    await ok.service.onRequestOutcome(
      { request_id: 'req-9', request_no: 'REQ-9' } as never,
      'approved',
    );
    expect(ok.assets.update).toHaveBeenCalledWith(
      { where: { id: 'a-1' }, data: { currentVersionId: 'v-3' } },
      expect.anything(),
    );
    expect(ok.notifications.brandVersion).toHaveBeenCalledWith(
      'u-mkt',
      'osd',
      expect.objectContaining({ kind: 'approved', versionNo: 3 }),
    );

    const no = harness({ pending });
    await no.service.onRequestOutcome(
      { request_id: 'req-9', request_no: 'REQ-9' } as never,
      'rejected',
    );
    expect(no.assets.update).not.toHaveBeenCalled();
    expect(no.versions.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'rejected' }),
      }),
      expect.anything(),
    );
  });

  it('SCOPE-03: another company’s asset answers 404', async () => {
    await expect(
      harness({ assetFound: null }).service.one(macom, 'a-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
