import type { Principal } from '@request-management/share';
import { ChatWidgetService } from './chat-widget.service';

const admin = {
  userId: 'u-admin',
  activeCompanyId: 'osd',
  orgUnitId: 'team',
  permissions: ['admin.chat-widget.manage'],
} as unknown as Principal;

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'w1',
  companyId: 'osd',
  name: 'ผู้ช่วย AI',
  httpUrl: 'http://192.168.31.52',
  httpsUrl: null,
  publicId: 'pub',
  active: true,
  orgWide: true,
  isDefault: false,
  sortOrder: 0,
  updatedAt: new Date(),
  ...extra,
});

function harness(existing: ReturnType<typeof row> | null = row()) {
  const widgets = {
    ancestorDepths: jest.fn(() =>
      Promise.resolve(
        new Map([
          ['team', 0],
          ['dept', 1],
        ]),
      ),
    ),
    findVisible: jest.fn(() => Promise.resolve([] as unknown[])),
    findFirst: jest.fn(() => Promise.resolve(existing)),
    findMany: jest.fn(() => Promise.resolve([] as { id: string }[])),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ ...args.data, id: 'new' })),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ ...existing, ...args.data })),
    ),
    delete: jest.fn(() => Promise.resolve({})),
    clearOrgDefault: jest.fn(() => Promise.resolve({ count: 1 })),
    findUnit: jest.fn(() => Promise.resolve({ id: 'team', name: 'Team' })),
    activeGroupRows: jest.fn(() => Promise.resolve([])),
    replaceGroup: jest.fn(() => Promise.resolve()),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };
  const service = new ChatWidgetService(
    widgets as never,
    transactions as never,
    audit as never,
  );
  return { service, widgets, audit };
}

const valid = {
  name: ' ผู้ช่วยขาย ',
  http_url: 'http://192.168.31.52/widget/v1.js',
  public_id: ' pub2 ',
};

describe('ChatWidgetService — org', () => {
  it('runtime looks up the user unit and every unit above it', async () => {
    const { service, widgets } = harness();
    widgets.findVisible.mockResolvedValue([
      { ...row(), groups: [{ orgUnitId: 'dept', isDefault: true }] },
    ]);
    await expect(service.runtime(admin)).resolves.toMatchObject({
      widgets: [{ id: 'w1', http_url: 'http://192.168.31.52' }],
      default_id: 'w1',
    });
    expect(widgets.findVisible).toHaveBeenCalledWith('osd', ['team', 'dept']);
  });

  it('stores trimmed values and origins, and audits the create', async () => {
    const { service, widgets, audit } = harness();
    await service.create(admin, valid);
    expect(widgets.create).toHaveBeenCalledWith(
      {
        data: expect.objectContaining({
          companyId: 'osd',
          name: 'ผู้ช่วยขาย',
          httpUrl: 'http://192.168.31.52',
          publicId: 'pub2',
          active: true,
          orgWide: true,
          isDefault: false,
        }) as unknown,
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'chat_widget.created' }),
      { prisma: {} },
    );
  });

  it('a new org default clears the old one in the same transaction', async () => {
    const { service, widgets } = harness();
    await service.create(admin, { ...valid, is_default: true });
    expect(widgets.clearOrgDefault).toHaveBeenCalledWith('osd', 'new', {
      prisma: {},
    });
  });

  it.each([
    [{ is_default: true, active: false }],
    [{ is_default: true, org_wide: false }],
    [{ http_url: '' }],
    [{ public_id: ' ' }],
    [{ https_url: 'http://not-https.test' }],
  ])('refuses %j and writes nothing', async (patch) => {
    const { service, widgets } = harness();
    await expect(
      service.create(admin, { ...valid, ...patch }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(widgets.create).not.toHaveBeenCalled();
  });

  it('switching off the current org default is refused', async () => {
    const { service, widgets } = harness(row({ isDefault: true }));
    await expect(
      service.update(admin, 'w1', { ...valid, active: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(widgets.update).not.toHaveBeenCalled();
  });

  it("another company's widget answers 404", async () => {
    const { service } = harness(null);
    await expect(service.update(admin, 'x', valid)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.remove(admin, 'x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('ChatWidgetService — group', () => {
  it('replaces the unit set with its default and audits it', async () => {
    const { service, widgets, audit } = harness();
    widgets.findMany.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }]);
    await service.saveGroup(admin, 'team', {
      widget_ids: ['w1', 'w2', 'w1'],
      default_id: 'w2',
    });
    expect(widgets.replaceGroup).toHaveBeenCalledWith(
      'team',
      ['w1', 'w2'],
      'w2',
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'chat_widget.group.updated' }),
      { prisma: {} },
    );
  });

  it('refuses an inactive or foreign widget', async () => {
    const { service, widgets } = harness();
    widgets.findMany.mockResolvedValue([{ id: 'w1' }]);
    await expect(
      service.saveGroup(admin, 'team', { widget_ids: ['w1', 'off'] }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(widgets.replaceGroup).not.toHaveBeenCalled();
  });

  it('refuses a group default that was not added', async () => {
    const { service } = harness();
    await expect(
      service.saveGroup(admin, 'team', {
        widget_ids: ['w1'],
        default_id: 'w2',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it("another company's unit answers 404", async () => {
    const { service, widgets } = harness();
    widgets.findUnit.mockResolvedValue(null as never);
    await expect(service.group(admin, 'other')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
