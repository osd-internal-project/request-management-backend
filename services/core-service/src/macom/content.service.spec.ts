import type { Principal } from '@request-management/share';
import { ContentService } from './content.service';

const actor = {
  userId: 'u-mkt',
  activeCompanyId: 'osd',
  permissions: ['crm.campaign.manage'],
} as unknown as Principal;

const item = (overrides: Record<string, unknown> = {}) => ({
  id: 'c-1',
  companyId: 'osd',
  campaignId: null,
  channel: 'facebook',
  title: 'โพสต์เปิดตัว',
  caption: 'มาร่วมงาน',
  ownerUserId: 'u-mkt',
  plannedAt: new Date('2026-10-10T03:00:00Z'),
  status: 'draft',
  publishedAt: null,
  publishedUrl: null,
  cancelReason: null,
  version: 1,
  remindedAt: null,
  overdueAt: null,
  copiedFromId: null,
  mentionsCustomer: false,
  mentionsPrice: false,
  mentionsPartner: false,
  approvalStatus: 'none',
  approvalRequestId: null,
  approvedVersion: null,
  approvalNote: null,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

function harness(
  options: {
    found?: unknown;
    member?: unknown;
    due?: unknown[];
    approveAll?: boolean;
  } = {},
) {
  const items = {
    findFirst: jest.fn(() =>
      Promise.resolve(options.found === undefined ? item() : options.found),
    ),
    findMany: jest.fn(() => Promise.resolve(options.due ?? [item()])),
    create: jest.fn(() => Promise.resolve({ id: 'c-new' })),
    update: jest.fn(() => Promise.resolve({})),
  };
  const files = { findMany: jest.fn(() => Promise.resolve([])) };
  const campaigns = {
    findFirst: jest.fn(() => Promise.resolve({ id: 'cmp-1' })),
    findMany: jest.fn(() => Promise.resolve([])),
  };
  const people = {
    findFirst: jest.fn(() =>
      Promise.resolve(
        options.member === undefined ? { id: 'u-mkt' } : options.member,
      ),
    ),
    findMany: jest.fn(() =>
      Promise.resolve([{ id: 'u-mkt', displayName: 'ฝ่ายการตลาด' }]),
    ),
  };
  const notifications = { contentReminder: jest.fn(() => Promise.resolve()) };
  const tx = {
    contentItem: { create: jest.fn(() => Promise.resolve({ id: 'c-copy' })) },
    contentFile: {
      findMany: jest.fn(() =>
        Promise.resolve([
          {
            fileName: 'a.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            storageKey: 'k/a.png',
          },
        ]),
      ),
      createMany: jest.fn(() => Promise.resolve({})),
    },
  };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn(tx)),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const config = { get: jest.fn(() => 0) };
  const configs = {
    findFirst: jest.fn(() =>
      Promise.resolve({ contentApprovalAll: options.approveAll ?? false }),
    ),
  };
  const service = new ContentService(
    items as never,
    files as never,
    campaigns as never,
    people as never,
    notifications as never,
    transactions as never,
    audit as never,
    config as never,
    configs as never,
  );
  return { service, items, notifications, tx };
}

const save = {
  title: 'โพสต์เปิดตัว',
  channel: 'facebook',
  planned_at: '2026-10-10T03:00:00.000Z',
  caption: 'มาร่วมงาน',
};

describe('CD-271 content calendar', () => {
  it('the owner must be a member of this company', async () => {
    const { service, items } = harness({ member: null });
    await expect(
      service.create(actor, { ...save, owner_user_id: 'outsider' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(items.create).not.toHaveBeenCalled();
  });

  it('a change to the words is a new version; a new time is not, but resets reminders', async () => {
    const { service, items } = harness();

    await service.update(actor, 'c-1', { ...save, caption: 'ข้อความใหม่' });
    expect(items.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ version: 2 }),
      }),
    );

    await service.update(actor, 'c-1', {
      ...save,
      planned_at: '2026-10-11T03:00:00.000Z',
    });
    const data = (
      items.update.mock.calls.at(-1) as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.version).toBeUndefined();
    expect(data).toMatchObject({ remindedAt: null, overdueAt: null });
  });

  it('published or cancelled cannot be edited', async () => {
    const { service } = harness({ found: item({ status: 'published' }) });
    await expect(service.update(actor, 'c-1', save)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('published needs the live link; cancelled needs a reason; draft cannot jump to published', async () => {
    const ready = harness({ found: item({ status: 'ready' }) });
    await expect(
      ready.service.move(actor, 'c-1', { status: 'published' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await ready.service.move(actor, 'c-1', {
      status: 'published',
      published_url: 'https://facebook.com/osd/posts/1',
    });
    expect(ready.items.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'published',
          publishedUrl: 'https://facebook.com/osd/posts/1',
        }),
      }),
    );
    await expect(
      ready.service.move(actor, 'c-1', { status: 'cancelled' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const draft = harness();
    await expect(
      draft.service.move(actor, 'c-1', {
        status: 'published',
        published_url: 'https://x.co',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('copying to another channel makes a new draft with the same media', async () => {
    const { service, tx } = harness();
    await service.copy(actor, 'c-1', { channel: 'line_oa' });
    expect(tx.contentItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channel: 'line_oa',
          copiedFromId: 'c-1',
        }),
      }),
    );
    expect(tx.contentFile.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ contentId: 'c-copy', storageKey: 'k/a.png' }),
      ],
    });
  });

  it('SCOPE-03: another company’s item answers 404', async () => {
    const { service } = harness({ found: null });
    await expect(service.one(actor, 'c-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('the sweep reminds the day before and an hour late, marking first', async () => {
    const now = new Date('2026-10-09T04:00:00Z');
    const { service, items, notifications } = harness({
      due: [
        item({ id: 'due', status: 'ready' }),
        item({
          id: 'late',
          status: 'ready',
          plannedAt: new Date('2026-10-09T01:00:00Z'),
        }),
        item({ id: 'quiet', status: 'ready', remindedAt: now }),
      ],
    });

    const result = await service.sweep(now);

    expect(result.sent).toBe(2);
    expect(items.update).toHaveBeenCalledWith({
      where: { id: 'due' },
      data: { remindedAt: now },
    });
    expect(items.update).toHaveBeenCalledWith({
      where: { id: 'late' },
      data: { overdueAt: now },
    });
    expect(notifications.contentReminder).toHaveBeenCalledWith(
      'u-mkt',
      'osd',
      expect.objectContaining({ kind: 'overdue', channel: 'Facebook' }),
    );
  });

  it('CD-272: flagged content cannot go Ready without an approval of this version', async () => {
    const flagged = harness({ found: item({ mentionsPrice: true }) });
    await expect(
      flagged.service.move(actor, 'c-1', { status: 'ready' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const approved = harness({
      found: item({
        mentionsPrice: true,
        approvalStatus: 'approved',
        approvedVersion: 1,
      }),
    });
    await approved.service.move(actor, 'c-1', { status: 'ready' });
    expect(approved.items.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ready' }),
      }),
    );

    const everything = harness({ approveAll: true });
    await expect(
      everything.service.move(actor, 'c-1', { status: 'ready' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('CD-272: editing the words of an approved Ready post drops it to Draft', async () => {
    const { service, items } = harness({
      found: item({
        status: 'ready',
        mentionsCustomer: true,
        approvalStatus: 'approved',
        approvedVersion: 1,
      }),
    });

    await service.update(actor, 'c-1', { ...save, caption: 'แก้ราคาใหม่' });

    expect(items.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'draft', version: 2 }),
      }),
    );
  });
});
