import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';
import { receiverFor } from './submit-rules';

const OSD = 'company-osd';
const FIXED = 'user-fixed-receiver';
const OTHER = 'user-other';

function principal(): Principal {
  return {
    userId: 'user-requester',
    activeCompanyId: OSD,
    username: 'requester',
    orgUnitId: 'ou-sales',
    permissions: ['request.create'],
    // Only the fields these paths read; a partial principal needs the double cast.
  } as unknown as Principal;
}

/** The service with only what `create` and `updateType` reach before the database. */
function serviceWith(options: {
  typeReceiverUserId: string | null;
  members?: string[];
}) {
  const created: Record<string, unknown>[] = [];
  const members = new Set(options.members ?? [FIXED, OTHER]);

  const service = new RequestsService(
    {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'req-1', ...data });
      }),
      findReceiver: jest.fn((id: string, companyId: string) =>
        Promise.resolve(members.has(id) && companyId === OSD ? { id } : null),
      ),
    } as never,
    {} as never,
    {} as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'type-1',
          code: 'DSC',
          receiverOrgUnitId: null,
          receiverUserId: options.typeReceiverUserId,
        }),
      ),
    } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      execute: jest.fn((work: (client: unknown) => unknown) => work({})),
    } as never,
    { latestFor: jest.fn(() => Promise.resolve(null)) } as never, // flows
  );

  return { service, created };
}

describe('REQ-01: ผู้รับเรื่องประจำ type', () => {
  it('fills in the type’s receiver when the requester names none', async () => {
    const { service, created } = serviceWith({ typeReceiverUserId: FIXED });

    await service.create({ type_code: 'DSC' }, principal());

    expect(created[0].receiverUserId).toBe(FIXED);
  });

  it('accepts the requester naming the same person', async () => {
    const { service, created } = serviceWith({ typeReceiverUserId: FIXED });

    await service.create(
      { type_code: 'DSC', receiver_user_id: FIXED },
      principal(),
    );

    expect(created[0].receiverUserId).toBe(FIXED);
  });

  it('refuses anyone else rather than silently overwriting them', async () => {
    const { service, created } = serviceWith({ typeReceiverUserId: FIXED });

    const attempt = service.create(
      { type_code: 'DSC', receiver_user_id: OTHER },
      principal(),
    );

    await expect(attempt).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'receiver_user_id', reason: 'fixed_by_type' }],
    });
    expect(created).toHaveLength(0);
  });

  it('keeps the requester’s choice when the type fixes nobody', async () => {
    const { service, created } = serviceWith({ typeReceiverUserId: null });

    await service.create(
      { type_code: 'DSC', receiver_user_id: OTHER },
      principal(),
    );

    expect(created[0].receiverUserId).toBe(OTHER);
  });

  it('blocks a draft saved with someone else before the type was fixed', () => {
    // What `assertReceivable` runs at submit against the live type.
    expect(() => receiverFor({ receiverUserId: FIXED }, OTHER)).toThrow(
      AppError,
    );
    expect(receiverFor({ receiverUserId: FIXED }, FIXED)).toBe(FIXED);
    expect(receiverFor({ receiverUserId: null }, null)).toBeNull();
  });

  it('refuses a fixed receiver outside the administered company', async () => {
    const { service } = serviceWith({ typeReceiverUserId: null, members: [] });

    const attempt = service.updateType(
      'DSC',
      { receiver_user_id: 'user-elsewhere' },
      principal(),
    );

    await expect(attempt).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'receiver_user_id', reason: 'user-elsewhere' }],
    });
  });
});
