import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, PolicyGuard } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { openSecret, sealSecret } from '../pm/config-rules';
import { SoftphoneController } from './softphone.controller';
import { SoftphoneService } from './softphone.service';

const KEY = 'test-config-secret';

const agent = {
  userId: 'u-agent',
  activeCompanyId: 'osd',
  orgUnitId: 'team',
  permissions: ['request.create'],
} as unknown as Principal;

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'x1',
  companyId: 'osd',
  userId: 'u-agent',
  extension: '1023',
  passwordSealed: sealSecret('s3cret', KEY),
  wssUrl: 'wss://pbx.example.com:8089/ws',
  sipServer: '10.0.0.5',
  active: true,
  createdAt: new Date(),
  createdBy: null,
  updatedBy: null,
  updatedAt: new Date(),
  ...extra,
});

function harness(options: {
  existing?: ReturnType<typeof row> | null;
  member?: boolean;
  callLog?: { id: string } | null;
  typeEnabled?: boolean;
  contacts?: { id: string; customerId: string; name: string }[];
}) {
  const extensions = {
    findFirst: jest.fn(() => Promise.resolve(options.existing ?? null)),
    findForCompany: jest.fn(() => Promise.resolve([row()])),
    usersByIds: jest.fn(() =>
      Promise.resolve([
        { id: 'u-agent', username: 'agent', displayName: 'คุณเอเจนต์' },
      ]),
    ),
    isMember: jest.fn(() => Promise.resolve(options.member ?? true)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ ...args.data, id: 'new' })),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve(row({ ...options.existing, ...args.data })),
    ),
    delete: jest.fn(() => Promise.resolve({})),
    findCallLog: jest.fn(() => Promise.resolve(options.callLog ?? null)),
    callLogTypeEnabled: jest.fn(() =>
      Promise.resolve(options.typeEnabled ?? true),
    ),
  };
  const requests = {
    create: jest.fn(() => Promise.resolve({ id: 'req-1' })),
  };
  const requestRows = { update: jest.fn(() => Promise.resolve({})) };
  const contacts = {
    byField: jest.fn(() => Promise.resolve(options.contacts ?? [])),
  };
  const transactions = {
    execute: jest.fn((fn: (prisma: unknown) => unknown) => fn({})),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const config = { get: jest.fn(() => KEY) };
  const service = new SoftphoneService(
    extensions as never,
    requests as never,
    requestRows as never,
    contacts as never,
    transactions as never,
    audit as never,
    config as never,
  );
  return { service, extensions, requests, requestRows, contacts, audit };
}

const save = {
  user_id: 'u-agent',
  extension: '1023',
  password: 'n3w',
  wss_url: 'wss://pbx.example.com:8089/ws',
  sip_server: '10.0.0.5',
};

describe('runtime — the caller’s own line', () => {
  it('is disabled when the user has no line', async () => {
    const { service } = harness({ existing: null });
    await expect(service.runtime(agent)).resolves.toEqual({ enabled: false });
  });

  it('opens the sealed password for its owner only', async () => {
    const { service, extensions } = harness({ existing: row() });
    const result = await service.runtime(agent);
    expect(result).toMatchObject({ enabled: true, password: 's3cret' });
    expect(extensions.findFirst).toHaveBeenCalledWith({
      where: { companyId: 'osd', userId: 'u-agent', active: true },
    });
  });

  it('is disabled, not broken, when the key changed', async () => {
    const { service } = harness({
      existing: row({ passwordSealed: sealSecret('s3cret', 'other-key') }),
    });
    await expect(service.runtime(agent)).resolves.toEqual({
      enabled: false,
      reason: 'PASSWORD_UNREADABLE',
    });
  });
});

describe('admin extensions', () => {
  it('never returns the password in the list', async () => {
    const { service } = harness({});
    const [item] = await service.list(agent);
    expect(item).toMatchObject({ user_name: 'คุณเอเจนต์', has_password: true });
    expect(item).not.toHaveProperty('password');
    expect(item).not.toHaveProperty('passwordSealed');
    expect(JSON.stringify(item)).not.toContain('s3cret');
  });

  it('seals the password on create and audits without it', async () => {
    const { service, extensions, audit } = harness({ existing: null });
    await service.create(agent, save);
    const [[args]] = extensions.create.mock.calls as unknown as [
      [{ data: { passwordSealed: string } }],
    ];
    expect(args.data.passwordSealed).not.toContain('n3w');
    expect(openSecret(args.data.passwordSealed, KEY)).toBe('n3w');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('n3w');
  });

  it('refuses a create without a password', async () => {
    const { service } = harness({ existing: null });
    await expect(
      service.create(agent, { ...save, password: ' ' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a user from another company (404)', async () => {
    const { service, extensions } = harness({ existing: null, member: false });
    await expect(service.create(agent, save)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(extensions.create).not.toHaveBeenCalled();
  });

  it('keeps the old password when the update leaves it empty', async () => {
    const { service, extensions } = harness({ existing: row() });
    await service.update(agent, 'x1', { ...save, password: '' });
    const [[args]] = extensions.update.mock.calls as unknown as [
      [{ data: Record<string, unknown> }],
    ];
    expect(args.data).not.toHaveProperty('passwordSealed');
  });

  it('answers 404 for another company’s extension', async () => {
    const { service, extensions } = harness({ existing: null });
    await expect(service.update(agent, 'x1', save)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(extensions.findFirst).toHaveBeenCalledWith({
      where: { id: 'x1', companyId: 'osd' },
    });
  });
});

describe('logCall — CALL_LOG after hang-up', () => {
  const call = {
    call_id: 'c-1',
    phone: '081-234-5678',
    answered_at: '2026-11-10T03:00:00.000Z',
    ended_at: '2026-11-10T03:04:12.000Z',
  };

  it('writes one draft with the matched contact', async () => {
    const { service, requests, requestRows } = harness({
      contacts: [{ id: 'ct-1', customerId: 'cu-1', name: 'คุณสมชาย' }],
    });
    await expect(service.logCall(agent, call)).resolves.toEqual({
      id: 'req-1',
      created: true,
    });
    expect(requests.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type_code: 'CALL_LOG',
        ref_type: 'customer',
        ref_id: 'cu-1',
        form_data: expect.objectContaining({
          call_id: 'c-1',
          contact_name: 'คุณสมชาย',
          duration_sec: 252,
        }),
      }),
      agent,
    );
    expect(requestRows.update).toHaveBeenCalledWith(
      {
        where: { id: 'req-1' },
        data: {
          channel: 'phone',
          contactPhone: '081-234-5678',
          contactName: 'คุณสมชาย',
        },
      },
      { prisma: {} },
    );
  });

  it('returns the first request when the hang-up repeats', async () => {
    const { service, requests } = harness({ callLog: { id: 'req-0' } });
    await expect(service.logCall(agent, call)).resolves.toEqual({
      id: 'req-0',
      created: false,
    });
    expect(requests.create).not.toHaveBeenCalled();
  });

  it('leaves the contact empty for an unknown number', async () => {
    const { service, requests } = harness({ contacts: [] });
    await service.logCall(agent, call);
    expect(requests.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ ref_type: 'customer' }),
      agent,
    );
  });

  it('says what to do when the company has no CALL_LOG type', async () => {
    const { service, requests } = harness({ typeEnabled: false });
    await expect(service.logCall(agent, call)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('CALL_LOG'),
    });
    expect(requests.create).not.toHaveBeenCalled();
  });
});

type Handler = keyof SoftphoneController;

function handlerOf(name: string): object {
  return Object.getOwnPropertyDescriptor(SoftphoneController.prototype, name)
    ?.value as object;
}

function guard(name: Handler, permissions: string[]): () => boolean {
  const principal = {
    userId: 'u-1',
    activeCompanyId: 'osd',
    permissions,
    isServiceAccount: false,
  } as unknown as Principal;
  const context = {
    getHandler: () => handlerOf(name),
    getClass: () => SoftphoneController,
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
  return () => new PolicyGuard(new Reflector()).canActivate(context);
}

describe('softphone routes through the real PolicyGuard', () => {
  it.each(['list', 'create', 'update', 'remove'] as Handler[])(
    '%s needs admin.softphone.manage',
    (name) => {
      expect(Reflect.getMetadata(PERMISSIONS_KEY, handlerOf(name))).toEqual([
        'admin.softphone.manage',
      ]);
      expect(guard(name, ['request.create', 'admin.chat-widget.manage'])).toThrow(
        expect.objectContaining({ code: 'FORBIDDEN' }),
      );
      expect(guard(name, ['admin.softphone.manage'])()).toBe(true);
    },
  );

  it('logCall needs request.create', () => {
    expect(guard('logCall', ['request.read'])).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(guard('logCall', ['request.create'])()).toBe(true);
  });

  it('runtime is open to any signed-in user', () => {
    expect(guard('runtime', [])()).toBe(true);
  });
});
