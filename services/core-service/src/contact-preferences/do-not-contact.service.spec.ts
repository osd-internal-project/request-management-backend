import type { Principal } from '@request-management/share';
import { DoNotContactService } from './do-not-contact.service';

const staff = {
  userId: 'u-1',
  username: 'staff',
  isServiceAccount: false,
  activeCompanyId: 'osd',
} as unknown as Principal;

function harness(rows: Record<string, unknown>[] = []) {
  const entries = {
    findMany: jest.fn(() => Promise.resolve(rows)),
    findFirst: jest.fn(() => Promise.resolve(rows[0] ?? null)),
    create: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        id: 'e-1',
        createdAt: new Date(),
        removedAt: null,
        ...args.data,
      }),
    ),
    update: jest.fn((args: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...rows[0], ...args.data }),
    ),
    count: jest.fn(() => Promise.resolve(rows.length)),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new DoNotContactService(
    entries as never,
    audit as never,
    { execute: jest.fn((fn: (p: unknown) => unknown) => fn({})) } as never,
  );
  return { service, entries, audit };
}

describe('CD-291 do-not-contact register', () => {
  it('stores one normalized form, so +66 and 0 are the same number', async () => {
    const h = harness();
    await h.service.add(
      'osd',
      {
        kind: 'phone',
        value: '+66 81-234-5678',
        channel: 'call',
        source: 'manual',
      },
      staff,
    );
    expect(h.entries.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ value: '0812345678' }) as unknown,
      }),
      expect.anything(),
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'contact.optout.added' }),
      expect.anything(),
    );
  });

  it('a refusal heard on a call is recorded by the system, with no person', async () => {
    const h = harness();
    await h.service.add(
      'osd',
      {
        kind: 'phone',
        value: '021234567',
        channel: 'call',
        source: 'call_refusal',
      },
      null,
    );
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: null,
        actorUsername: 'system:ai-smart',
      }),
      expect.anything(),
    );
  });

  it('a `call` entry stops calls but not messages; `all` stops both', async () => {
    const callOnly = harness([
      { id: 'e', kind: 'phone', value: '021234567', channel: 'call' },
    ]);
    await expect(
      callOnly.service.blockFor('osd', { phone: '02-123-4567' }, 'call'),
    ).resolves.toMatchObject({ id: 'e' });
    await expect(
      callOnly.service.blockFor('osd', { phone: '021234567' }, 'message'),
    ).resolves.toBeNull();
    const all = harness([
      { id: 'e', kind: 'email', value: 'a@b.co', channel: 'all' },
    ]);
    await expect(
      all.service.blockFor('osd', { email: 'A@B.CO' }, 'message'),
    ).resolves.toMatchObject({ id: 'e' });
  });

  it('an identical active entry is not added twice; a bad number is refused', async () => {
    const h = harness([
      {
        id: 'e',
        kind: 'phone',
        value: '021234567',
        channel: 'all',
        createdAt: new Date(),
      },
    ]);
    await h.service.add(
      'osd',
      { kind: 'phone', value: '021234567', channel: 'call', source: 'manual' },
      staff,
    );
    expect(h.entries.create).not.toHaveBeenCalled();
    await expect(
      h.service.add(
        'osd',
        { kind: 'phone', value: '12', channel: 'call', source: 'manual' },
        staff,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lifting keeps the row with who and why; another company’s entry is 404', async () => {
    const h = harness([{ id: 'e', removedAt: null }]);
    await h.service.remove(staff, 'e', 'ลูกค้าขอให้ติดต่อได้');
    expect(h.entries.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ removedBy: 'u-1' }) as unknown,
      }),
      expect.anything(),
    );
    await expect(
      harness([]).service.remove(staff, 'x', 'r'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
