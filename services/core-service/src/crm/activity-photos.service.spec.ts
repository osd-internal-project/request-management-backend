import { Readable } from 'node:stream';
import type { Principal } from '@request-management/share';
import {
  ActivityPhotosService,
  MAX_PHOTOS_PER_ACTIVITY,
} from './activity-photos.service';

const me = {
  userId: 'sales-1',
  activeCompanyId: 'osd',
  ledUnitIds: [],
  permissions: ['crm.sales.manage', 'crm.sales.read'],
} as unknown as Principal;
const photo = (
  overrides: Partial<{ mimetype: string; size: number }> = {},
) => ({
  originalname: 'ไวท์บอร์ด.jpg',
  mimetype: 'image/jpeg',
  size: 1024,
  buffer: Buffer.from('x'),
  ...overrides,
});

function harness(options: {
  deal?: Record<string, unknown> | null;
  activity?: Record<string, unknown> | null;
  count?: number;
  stored?: Record<string, unknown> | null;
  failWrite?: boolean;
}) {
  const storage = {
    put: jest.fn(() => Promise.resolve()),
    get: jest.fn(() => Promise.resolve(Readable.from(['x']))),
    remove: jest.fn(() => Promise.resolve()),
  };
  const photos = {
    count: jest.fn(() => Promise.resolve(options.count ?? 0)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      options.failWrite
        ? Promise.reject(new Error('db down'))
        : Promise.resolve({ id: args.data.id, fileName: args.data.fileName }),
    ),
    findFirst: jest.fn(() => Promise.resolve(options.stored ?? null)),
    update: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new ActivityPhotosService(
    {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.deal === undefined
            ? { id: 'opp-1', companyId: 'osd', stage: 'proposing' }
            : options.deal,
        ),
      ),
    } as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve(
          options.activity === undefined ? { id: 'act-1' } : options.activity,
        ),
      ),
    } as never,
    photos as never,
    audit as never,
    { execute: jest.fn((work: (p: unknown) => unknown) => work({})) } as never,
    storage,
  );
  return { service, storage, photos, audit };
}

describe('CD-75 activity photos', () => {
  it('CD-75: a phone photo is stored first, then recorded and audited under the deal', async () => {
    const { service, storage, photos, audit } = harness({});
    await service.upload('opp-1', 'act-1', photo(), me);

    const key = (storage.put.mock.calls[0] as unknown as [string])[0];
    expect(key).toMatch(
      /^opportunities\/opp-1\/activities\/act-1\/.+\/ไวท์บอร์ด\.jpg$/,
    );
    expect(photos.create).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'crm.opportunity.activity_photo_added',
      }),
      { prisma: {} },
    );
  });

  it('an iPhone HEIC photo is accepted; a PDF or a video is not', async () => {
    const { service } = harness({});
    await expect(
      service.upload('opp-1', 'act-1', photo({ mimetype: 'image/heic' }), me),
    ).resolves.toBeDefined();
    await expect(
      service.upload(
        'opp-1',
        'act-1',
        photo({ mimetype: 'application/pdf' }),
        me,
      ),
    ).rejects.toThrow('เฉพาะรูปภาพ');
    await expect(
      service.upload('opp-1', 'act-1', photo({ mimetype: 'video/mp4' }), me),
    ).rejects.toThrow('เฉพาะรูปภาพ');
  });

  it('refuses too big, too many, a closed deal, and a deal out of reach (404)', async () => {
    await expect(
      harness({}).service.upload(
        'opp-1',
        'act-1',
        photo({ size: 16 * 1024 * 1024 }),
        me,
      ),
    ).rejects.toThrow('15 MB');
    await expect(
      harness({ count: MAX_PHOTOS_PER_ACTIVITY }).service.upload(
        'opp-1',
        'act-1',
        photo(),
        me,
      ),
    ).rejects.toThrow('ไม่เกิน 10 รูป');
    await expect(
      harness({
        deal: { id: 'opp-1', companyId: 'osd', stage: 'won' },
      }).service.upload('opp-1', 'act-1', photo(), me),
    ).rejects.toThrow('ปิดแล้ว');
    await expect(
      harness({ deal: null }).service.upload('opp-1', 'act-1', photo(), me),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      harness({ activity: null }).service.upload('opp-1', 'act-1', photo(), me),
    ).rejects.toThrow('ไม่พบกิจกรรม');
  });

  it('a failed record removes the stored file — no orphan bytes', async () => {
    const { service, storage } = harness({ failWrite: true });
    await expect(service.upload('opp-1', 'act-1', photo(), me)).rejects.toThrow(
      'db down',
    );
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });

  it('only the person who took a photo removes it; removal is soft and drops the object', async () => {
    const stored = {
      id: 'ph-1',
      fileName: 'a.jpg',
      uploadedBy: 'sales-1',
      storageKey: 'k',
    };
    const mine = harness({ stored });
    await mine.service.remove('opp-1', 'act-1', 'ph-1', me);
    expect(mine.photos.update).toHaveBeenCalledWith(
      {
        where: { id: 'ph-1' },
        data: { deletedAt: expect.any(Date) as unknown },
      },
      { prisma: {} },
    );
    expect(mine.storage.remove).toHaveBeenCalledWith('k');

    const theirs = harness({
      stored: { ...stored, uploadedBy: 'someone-else' },
    });
    await expect(
      theirs.service.remove('opp-1', 'act-1', 'ph-1', me),
    ).rejects.toThrow('เฉพาะรูปที่คุณแนบเอง');
  });

  it('a photo is streamed only for a deal the viewer can see', async () => {
    const stored = {
      id: 'ph-1',
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1,
      storageKey: 'k',
    };
    const { service, storage } = harness({ stored });
    await service.download('opp-1', 'act-1', 'ph-1', me);
    expect(storage.get).toHaveBeenCalledWith('k');

    await expect(
      harness({ deal: null, stored }).service.download(
        'opp-1',
        'act-1',
        'ph-1',
        me,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
