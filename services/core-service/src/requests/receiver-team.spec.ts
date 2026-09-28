import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { RequestsService } from './requests.service';

const OSD = 'company-osd';
const PRICING = 'ou-pricing';
const FINANCE = 'ou-finance';

function principal(): Principal {
  return {
    userId: 'user-requester',
    activeCompanyId: OSD,
    username: 'requester',
    orgUnitId: 'ou-sales',
    permissions: ['request.create'],
    // Only the fields this path reads. Double cast because a partial
    // principal no longer overlaps the full one enough for a single one.
  } as unknown as Principal;
}

/**
 * Builds the service with only the collaborators `create` reaches, and hands
 * back the `data` it would have written — which is where the receiving team is
 * decided, before any database is involved.
 */
function serviceWith(options: {
  typeReceiverOrgUnitId: string | null;
  assignableUnitIds?: string[];
}) {
  const created: Record<string, unknown>[] = [];
  const assignable = new Set(options.assignableUnitIds ?? [PRICING, FINANCE]);

  const service = new RequestsService(
    {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'req-1', ...data });
      }),
    } as never,
    {} as never,
    // `RequestCommentRepository` — none of these paths comment.
    {} as never,
    {
      findFirst: jest.fn(() =>
        Promise.resolve({
          id: 'type-1',
          code: 'DSC',
          receiverOrgUnitId: options.typeReceiverOrgUnitId,
        }),
      ),
    } as never,
    {
      findAssignable: jest.fn((id: string, companyId: string) =>
        Promise.resolve(
          assignable.has(id) && companyId === OSD ? { id, name: id } : null,
        ),
      ),
    } as never,
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

describe('REQ-01: ทีมผู้รับ is a default, not a routing rule', () => {
  it('falls back to the type’s team when the requester names none', async () => {
    const { service, created } = serviceWith({
      typeReceiverOrgUnitId: PRICING,
    });

    await service.create({ type_code: 'DSC' }, principal());

    expect(created[0].receiverOrgUnitId).toBe(PRICING);
  });

  it('keeps the team the requester chose over the type’s', async () => {
    const { service, created } = serviceWith({
      typeReceiverOrgUnitId: PRICING,
    });

    await service.create(
      { type_code: 'DSC', receiver_org_unit_id: FINANCE },
      principal(),
    );

    expect(created[0].receiverOrgUnitId).toBe(FINANCE);
  });

  it('leaves the team null when neither the type nor the requester names one', async () => {
    const { service, created } = serviceWith({ typeReceiverOrgUnitId: null });

    await service.create({ type_code: 'DSC' }, principal());

    expect(created[0].receiverOrgUnitId).toBeNull();
  });

  /*
    SCOPE-03. A unit outside the active company, one that does not exist, and a
    deactivated one are all the same answer: the request is refused rather than
    stored pointing at a queue that nobody works.
  */
  it('refuses a team outside the caller’s company', async () => {
    const { service, created } = serviceWith({
      typeReceiverOrgUnitId: PRICING,
      assignableUnitIds: [PRICING],
    });

    await expect(
      service.create(
        { type_code: 'DSC', receiver_org_unit_id: 'ou-other-company' },
        principal(),
      ),
    ).rejects.toThrow(AppError);

    expect(created).toHaveLength(0);
  });

  it('names the field that failed, so the form can point at it', async () => {
    const { service } = serviceWith({ typeReceiverOrgUnitId: null });

    await service
      .create(
        { type_code: 'DSC', receiver_org_unit_id: 'ou-missing' },
        principal(),
      )
      .catch((error: AppError) => {
        expect(error.code).toBe('VALIDATION_FAILED');
        expect(error.details).toEqual([
          { field: 'receiver_org_unit_id', reason: 'ou-missing' },
        ]);
      });

    expect.assertions(2);
  });
});
