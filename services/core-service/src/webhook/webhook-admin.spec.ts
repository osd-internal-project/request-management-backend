import type { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import {
  AuditWriter,
  PERMISSIONS_KEY,
  PolicyGuard,
} from '@request-management/share';
import type { Principal } from '@request-management/share';

import { openSecret } from '../pm/config-rules';
import { WebhookAdminController } from './webhook-admin.controller';
import { WebhookAdminService } from './webhook-admin.service';
import type {
  WebhookDeliveryRepository,
  WebhookSubscriptionRepository,
} from './webhook.repository';

type Handler = keyof WebhookAdminController;

function handlerOf(name: string): object {
  return Object.getOwnPropertyDescriptor(WebhookAdminController.prototype, name)
    ?.value as object;
}

const HANDLERS = Object.getOwnPropertyNames(WebhookAdminController.prototype)
  .filter((name) => name !== 'constructor')
  .filter((name) =>
    Reflect.hasMetadata('method', handlerOf(name)),
  ) as Handler[];

function guard(name: Handler, permissions: string[]): () => boolean {
  const principal = {
    userId: 'admin-1',
    activeCompanyId: 'osd',
    permissions,
    isServiceAccount: false,
  } as unknown as Principal;
  const context = {
    getHandler: () => handlerOf(name),
    getClass: () => WebhookAdminController,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
  return () => new PolicyGuard(new Reflector()).canActivate(context);
}

describe('G-07 webhook admin routes need admin.integration.manage', () => {
  it('found the routes', () => {
    expect(HANDLERS).toHaveLength(7);
  });

  it.each(HANDLERS)('%s', (name) => {
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handlerOf(name))).toEqual([
      'admin.integration.manage',
    ]);
    expect(guard(name, ['request.read', 'admin.api_key.manage'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(guard(name, ['admin.integration.manage'])()).toBe(true);
  });
});

const KEY = 'test-config-key';

function admin(companyId = 'osd'): Principal {
  return {
    userId: 'admin-1',
    activeCompanyId: companyId,
    permissions: ['admin.integration.manage'],
  } as unknown as Principal;
}

function harness(existing: Record<string, unknown> | null = null) {
  const row = (data: Record<string, unknown>) => ({
    id: 'wh-1',
    companyId: 'osd',
    name: 'ERP',
    url: 'http://erp.local/in',
    events: ['request.approved'],
    active: true,
    createdBy: 'admin-1',
    createdAt: new Date('2026-10-20T00:00:00Z'),
    ...data,
  });
  const subscriptions = {
    findMany: jest.fn().mockResolvedValue(existing ? [row(existing)] : []),
    findFirst: jest.fn((args: { where: { companyId: string } }) =>
      Promise.resolve(
        existing && args.where.companyId === 'osd' ? row(existing) : null,
      ),
    ),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row(args.data)),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ ...existing, ...args.data })),
    ),
  };
  const deliveries = {
    create: jest.fn().mockResolvedValue({}),
    findMany: jest.fn().mockResolvedValue([]),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const values: Record<string, unknown> = {
    'webhook.privateHosts': ['erp.local'],
    'projectConfig.secret': KEY,
  };
  const service = new WebhookAdminService(
    subscriptions as unknown as WebhookSubscriptionRepository,
    deliveries as unknown as WebhookDeliveryRepository,
    audit as unknown as AuditWriter,
    { get: (key: string) => values[key] } as ConfigService,
  );
  return { service, subscriptions, deliveries, audit };
}

describe('G-07 WebhookAdminService', () => {
  it('returns the secret once, stores it sealed, and never audits it', async () => {
    const { service, subscriptions, audit } = harness();

    const out = await service.create(
      {
        name: ' ERP ',
        url: 'http://erp.local/in',
        events: ['request.approved', 'request.approved'],
      },
      admin(),
    );

    const stored = (
      subscriptions.create.mock.calls[0] as [{ data: Record<string, string> }]
    )[0].data;
    expect(out.secret).toMatch(/^whsec_/);
    expect(stored.secretEnc).not.toContain(out.secret);
    expect(openSecret(stored.secretEnc, KEY)).toBe(out.secret);
    expect(stored.companyId).toBe('osd');
    expect(out.events).toEqual(['request.approved']);
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(out.secret);
    expect(JSON.stringify(out)).not.toContain('secretEnc');
  });

  it('refuses http to a host not allow-listed, and unknown events', async () => {
    const { service, subscriptions } = harness();

    await expect(
      service.create(
        { name: 'x', url: 'http://other.example.com', events: ['nope'] },
        admin(),
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [
        expect.objectContaining({ field: 'url' }),
        expect.objectContaining({ field: 'events' }),
      ],
    });
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it('SCOPE-03: another company’s webhook answers 404 on every write', async () => {
    const { service, subscriptions, deliveries } = harness({});
    const other = admin('other-co');

    for (const call of [
      () => service.update('wh-1', { active: false }, other),
      () => service.rotateSecret('wh-1', other),
      () => service.listDeliveries('wh-1', other),
      () => service.test('wh-1', other),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(subscriptions.update).not.toHaveBeenCalled();
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  it('test queues a ping; a disabled webhook cannot be tested', async () => {
    const on = harness({});
    await expect(on.service.test('wh-1', admin())).resolves.toEqual({
      queued: true,
    });
    expect(on.deliveries.create).toHaveBeenCalledWith({
      data: {
        subscriptionId: 'wh-1',
        eventName: 'webhook.ping',
        payload: { company_id: 'osd', webhook_id: 'wh-1' },
      },
    });

    const off = harness({ active: false });
    await expect(off.service.test('wh-1', admin())).rejects.toMatchObject({
      code: 'UNPROCESSABLE',
    });
  });

  it('rotating gives a new secret that the stored one opens to', async () => {
    const { service, subscriptions } = harness({});

    const out = await service.rotateSecret('wh-1', admin());

    const data = (
      subscriptions.update.mock.calls[0] as [{ data: { secretEnc: string } }]
    )[0].data;
    expect(openSecret(data.secretEnc, KEY)).toBe(out.secret);
  });
});
