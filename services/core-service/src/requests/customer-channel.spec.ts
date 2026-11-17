import type { Principal } from '@request-management/share';
import {
  hashStatusToken,
  receivedWithin,
  RequestsService,
} from './requests.service';

const robot = {
  userId: 'svc-1',
  username: 'robot',
  isServiceAccount: true,
  activeCompanyId: 'osd',
  companies: [],
  permissions: ['integration.request.create'],
} as unknown as Principal;

const osdKey = {
  id: 'key-1',
  prefix: 'rfk_abcdefgh',
  name: 'D CALL system',
  companyId: 'osd',
};

function harness(
  options: { found?: Record<string, unknown> | null; type?: Record<string, unknown> } = {},
) {
  // system accounts keyed by keycloakId, as the unique index would hold them
  const accounts = new Map<string, { id: string; displayName: string }>();
  const tx = {
    user: {
      upsert: jest.fn(
        ({ where, create, update }: {
          where: { keycloakId: string };
          create: { displayName: string; status: string };
          update: { displayName: string };
        }) => {
          const found = accounts.get(where.keycloakId);
          const row = found
            ? { ...found, ...update }
            : { id: `sys-${accounts.size + 1}`, ...create };
          accounts.set(where.keycloakId, row);
          return Promise.resolve({ id: row.id });
        },
      ),
    },
    userCompany: { upsert: jest.fn(() => Promise.resolve({})) },
  };
  const created: Record<string, unknown>[] = [];
  const requests = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      created.push(data);
      return Promise.resolve({ id: 'req-1', ...data });
    }),
    findFirst: jest.fn(() =>
      Promise.resolve(options.found === undefined ? null : options.found),
    ),
    findWithType: jest.fn(() =>
      Promise.resolve({
        id: 'req-1',
        companyId: 'osd',
        requesterId: 'desk-1',
        status: 'submitted',
        requestType: {},
      }),
    ),
  };
  const types = {
    findFirst: jest.fn(() =>
      Promise.resolve({
        id: 'type-1',
        code: 'IT',
        receiverUserId: 'recv-1',
        formSchema: {},
        ...options.type,
      }),
    ),
  };
  const service = new RequestsService(
    requests as never,
    {} as never,
    {} as never,
    types as never,
    { unitOfMember: jest.fn(() => Promise.resolve('unit-sales')) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { execute: jest.fn((work: (c: unknown) => unknown) => work(tx)) } as never,
    { latestFor: jest.fn(() => Promise.resolve(null)) } as never,
  );
  const submitted = jest
    .spyOn(service, 'submit')
    .mockResolvedValue({ id: 'req-1', requestNo: 'REQ-1' } as never);
  return { service, created, submitted, requests, tx, accounts };
}

describe('CD-66 requests from customer channels', () => {
  it('CD-66: raised for the channel requester with the customer as contact, submitted for them; only the token’s hash is kept', async () => {
    const h = harness();
    const { statusToken } = await h.service.createFromChannel(
      {
        companyId: 'osd',
        channel: 'web_form',
        typeCode: 'IT',
        requesterUserId: 'desk-1',
        formData: { detail: 'x' },
        contact: { name: 'คุณเอ', email: 'a@example.com' },
        ref: { type: 'customer', id: 'cus-1' },
      },
      robot,
      'Bearer t',
    );
    expect(h.created[0]).toMatchObject({
      requesterId: 'desk-1',
      // SCOPE-02 — the requester's group is snapshot, as on the screen path
      requesterOrgUnitId: 'unit-sales',
      companyId: 'osd',
      channel: 'web_form',
      contactName: 'คุณเอ',
      contactEmail: 'a@example.com',
      refType: 'customer',
      refId: 'cus-1',
      source: 'SYSTEM',
      status: 'draft',
      statusTokenHash: hashStatusToken(statusToken),
    });
    expect(JSON.stringify(h.created[0])).not.toContain(statusToken);
    expect(statusToken.length).toBeGreaterThanOrEqual(32);
    expect(h.submitted).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ activeCompanyId: 'osd' }),
      'Bearer t',
      { forRequester: true },
    );
  });

  it('CD-282: a channel raising a matter taken earlier passes when it was received', async () => {
    const h = harness();
    const receivedAt = new Date('2026-10-07T01:00:00Z');
    await h.service.createFromChannel(
      {
        companyId: 'osd',
        channel: 'ai_care',
        typeCode: 'IT',
        requesterUserId: 'desk-1',
        formData: {},
        contact: { name: 'คุณเอ' },
        receivedAt,
      },
      robot,
      '',
    );
    expect(h.submitted).toHaveBeenCalledWith('req-1', expect.anything(), '', {
      forRequester: true,
      receivedAt,
    });
  });

  it('CD-282: a received time is used only when past, and at most 7 days back', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const hourAgo = new Date('2026-10-07T11:00:00Z');
    expect(receivedWithin(hourAgo, now)).toEqual(hourAgo);
    expect(
      receivedWithin(new Date('2026-10-07T13:00:00Z'), now),
    ).toBeUndefined();
    expect(receivedWithin(now, now)).toBeUndefined();
    expect(receivedWithin(undefined, now)).toBeUndefined();
    expect(receivedWithin(new Date('invalid'), now)).toBeUndefined();
    expect(receivedWithin(new Date('2026-09-01T00:00:00Z'), now)).toEqual(
      new Date('2026-09-30T12:00:00Z'),
    );
  });

  it('CD-66 fix: a key bound to one company cannot raise work in another through the body', async () => {
    const h = harness();
    await expect(
      h.service.createFromIntegration(
        { type_code: 'IT', requester_user_id: 'u-1', company_id: 'bco' },
        robot,
        'Bearer t',
        osdKey,
      ),
    ).rejects.toMatchObject({ code: 'COMPANY_FORBIDDEN' });
    expect(h.created).toHaveLength(0);

    await h.service.createFromIntegration(
      { type_code: 'IT', requester_user_id: 'u-1', company_id: 'osd' },
      robot,
      'Bearer t',
      osdKey,
    );
    // and the submit runs for the named requester, not as the robot
    expect(h.submitted).toHaveBeenCalledWith(
      'req-1',
      expect.anything(),
      'Bearer t',
      { forRequester: true },
    );
  });

  it('REQ-10: no requester named → filed as the key’s "system (<name>)" account, which cannot log in', async () => {
    const h = harness();
    await h.service.createFromIntegration(
      { type_code: 'IT', company_id: 'osd' },
      robot,
      'Bearer t',
      osdKey,
    );
    expect(h.created[0]).toMatchObject({ requesterId: 'sys-1', source: 'SYSTEM' });
    expect(h.accounts.get('apikey:key-1')).toMatchObject({
      displayName: 'system (D CALL system)',
      status: 'SUSPENDED',
    });
    expect(h.tx.userCompany.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { userId: 'sys-1', companyId: 'osd' },
      }),
    );
  });

  it('a type with only a receiving team hands that team to the request, so the submit can pick a member (D CALL, 17 Nov 2026)', async () => {
    const h = harness({ type: { receiverUserId: null, receiverOrgUnitId: 'rnd-dcall' } });
    await h.service.createFromIntegration(
      { type_code: 'IT', company_id: 'osd' },
      robot,
      'Bearer t',
      osdKey,
    );
    expect(h.created[0]).toMatchObject({ receiverUserId: null, receiverOrgUnitId: 'rnd-dcall' });
  });

  it('REQ-10: the same key reuses its one system account and follows a renamed key', async () => {
    const h = harness();
    const dto = { type_code: 'IT', company_id: 'osd' };
    await h.service.createFromIntegration(dto, robot, 'Bearer t', osdKey);
    await h.service.createFromIntegration(dto, robot, 'Bearer t', {
      ...osdKey,
      name: 'D CALL (renamed)',
    });
    expect(h.accounts.size).toBe(1);
    expect(h.created.map((row) => row.requesterId)).toEqual(['sys-1', 'sys-1']);
    expect(h.accounts.get('apikey:key-1')?.displayName).toBe(
      'system (D CALL (renamed))',
    );
  });

  it('REQ-10: no requester and no API key → VALIDATION_FAILED, nothing written', async () => {
    const h = harness();
    await expect(
      h.service.createFromIntegration(
        { type_code: 'IT', company_id: 'osd' },
        robot,
        'Bearer t',
        null,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(h.created).toHaveLength(0);
    expect(h.tx.user.upsert).not.toHaveBeenCalled();
  });

  it('CD-66 fix: submit skips only the owner check for a machine acting for the requester', async () => {
    const h = harness();
    h.submitted.mockRestore();
    jest
      .spyOn(
        h.service as unknown as { flowV2Of: () => Promise<null> },
        'flowV2Of',
      )
      .mockResolvedValue(null);
    // without the option: the owner check (the robot is not the requester)
    await expect(h.service.submit('req-1', robot, 'x')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // with it: past the owner check, stopped by the next rule (already submitted)
    await expect(
      h.service.submit('req-1', robot, 'x', { forRequester: true }),
    ).rejects.not.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('CD-66: the status by token shows only the public part; an unknown token is 404', async () => {
    const missing = harness({ found: null });
    await expect(
      missing.service.statusByToken('nope-token-123456789012'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });

    const found = harness({
      found: {
        requestNo: 'REQ-1',
        status: 'in_progress',
        submittedAt: new Date('2026-09-29T03:00:00Z'),
        dueAt: null,
        completedAt: null,
        closedAt: null,
        updatedAt: new Date('2026-09-29T04:00:00Z'),
        typeSnapshot: { name: 'แจ้งปัญหาไอที' },
        typeCode: 'IT',
        company: { name: 'OSD' },
      },
    });
    const view = await found.service.statusByToken('some-token-12345678901234');
    expect(view).toEqual({
      request_no: 'REQ-1',
      type_name: 'แจ้งปัญหาไอที',
      company_name: 'OSD',
      status: 'in_progress',
      submitted_at: new Date('2026-09-29T03:00:00Z'),
      due_at: null,
      completed_at: null,
      closed_at: null,
      updated_at: new Date('2026-09-29T04:00:00Z'),
    });
    expect(found.requests.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          statusTokenHash: hashStatusToken('some-token-12345678901234'),
        },
      }),
    );
  });
});
