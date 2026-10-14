import type { Principal } from '@request-management/share';
import { ChatWidgetService } from './chat-widget.service';

const admin = {
  userId: 'u-admin',
  activeCompanyId: 'osd',
  permissions: ['admin.chat-widget.manage'],
} as unknown as Principal;

function harness(row: Record<string, unknown> | null = null) {
  const settings = {
    findFirst: jest.fn(() => Promise.resolve(row)),
    upsert: jest.fn(() => Promise.resolve({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };
  const service = new ChatWidgetService(
    settings as never,
    transactions as never,
    audit as never,
  );
  return { service, settings, audit };
}

describe('ChatWidgetService', () => {
  it('reads nulls when the company has no row, so the frontend uses its env', async () => {
    const { service } = harness();
    await expect(service.runtime(admin)).resolves.toEqual({
      http_url: null,
      https_url: null,
      public_id: null,
    });
  });

  it('stores origins only and audits the change', async () => {
    const { service, settings, audit } = harness();
    await service.save(admin, {
      http_url: ' http://192.168.31.52/widget/v1.js ',
      https_url: 'https://aiyara-dev.osd.co.th/',
      public_id: ' abc ',
    });
    const data = {
      httpUrl: 'http://192.168.31.52',
      httpsUrl: 'https://aiyara-dev.osd.co.th',
      publicId: 'abc',
    };
    expect(settings.upsert).toHaveBeenCalledWith(
      {
        where: { companyId: 'osd' },
        create: { companyId: 'osd', ...data, updatedBy: 'u-admin' },
        update: { ...data, updatedBy: 'u-admin' },
      },
      { prisma: {} },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'chat_widget.settings.updated',
        after: data,
      }),
      { prisma: {} },
    );
  });

  it('clears a value sent empty', async () => {
    const { service, settings } = harness();
    await service.save(admin, { http_url: '', https_url: null, public_id: '' });
    expect(settings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          httpUrl: null,
          httpsUrl: null,
          publicId: null,
        }) as unknown,
      }),
      { prisma: {} },
    );
  });

  it.each([
    ['http_url', 'https://aiyara-dev.osd.co.th'],
    ['https_url', 'http://192.168.31.52'],
    ['http_url', 'not a url'],
  ])('refuses %s = %s and writes nothing', async (field, value) => {
    const { service, settings } = harness();
    await expect(service.save(admin, { [field]: value })).rejects.toMatchObject(
      {
        code: 'VALIDATION_FAILED',
      },
    );
    expect(settings.upsert).not.toHaveBeenCalled();
  });
});
