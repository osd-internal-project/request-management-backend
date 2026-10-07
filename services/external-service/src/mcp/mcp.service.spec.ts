import { AppError } from '@request-management/share';
import type {
  Principal,
  RequestWithPrincipal,
} from '@request-management/share';
import { McpActorService } from './mcp-actor';
import { McpService } from './mcp.service';

const HUMAN = 'user-human';
const ROBOT = 'service-account-request-form';
const ACTED = 'user-acted-for';

/**
 * The MCP endpoint accepts two kinds of caller, and everything that could go
 * wrong is in how it tells them apart. A person's token names a person; a
 * service account's does not, and `X-Acting-User` is the only thing that can.
 *
 * The case these tests exist for: honouring that header for a *person* would
 * turn a signed-in user into an impersonation endpoint.
 */
function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: HUMAN,
    username: HUMAN,
    activeCompanyId: 'company-osd',
    permissions: ['request.create'],
    isServiceAccount: false,
    pendingOrgAssignment: false,
    ...overrides,
  } as unknown as Principal;
}

function httpRequest(headers: Record<string, string> = {}) {
  return {
    headers: { authorization: 'Bearer t', ...headers },
  } as unknown as RequestWithPrincipal;
}

/** Stands in for user-service's answer about the acted-for person. */
function principalsStub() {
  return {
    resolveActingUser: jest.fn(() =>
      Promise.resolve(
        principal({ userId: ACTED, username: ACTED, isServiceAccount: false }),
      ),
    ),
  };
}

describe('MCP — who the call is done as', () => {
  it('uses the person themselves when a human token calls', async () => {
    const principals = principalsStub();
    const actors = new McpActorService(principals as never);

    const actor = await actors.resolve(httpRequest(), principal());

    expect(actor.userId).toBe(HUMAN);
    // Nothing to look up: the token already named them.
    expect(principals.resolveActingUser).not.toHaveBeenCalled();
  });

  /** The impersonation hole this endpoint must not have. */
  it('refuses X-Acting-User from a human token', async () => {
    const actors = new McpActorService(principalsStub() as never);

    await expect(
      actors.resolve(
        httpRequest({ 'x-acting-user': 'someone.else@osd.co.th' }),
        principal(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('still requires X-Acting-User from a service account', async () => {
    const actors = new McpActorService(principalsStub() as never);

    await expect(
      actors.resolve(
        httpRequest(),
        principal({ userId: ROBOT, isServiceAccount: true }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('swaps to the named person for a service account', async () => {
    const principals = principalsStub();
    const actors = new McpActorService(principals as never);

    const actor = await actors.resolve(
      httpRequest({ 'x-acting-user': 'somebody@osd.co.th' }),
      principal({ userId: ROBOT, isServiceAccount: true }),
    );

    expect(actor.userId).toBe(ACTED);
    expect(principals.resolveActingUser).toHaveBeenCalled();
  });
});

describe('MCP — the protocol', () => {
  function serviceWith(
    toolAnswer: () => Promise<unknown>,
    unavailable: string | null = null,
  ) {
    const tools = {
      list: () => [
        { name: 'get_request_types', description: '', inputSchema: {} },
      ],
      has: (name: string) => name === 'get_request_types',
      call: jest.fn(toolAnswer),
      reasonUnavailable: () => unavailable,
    };

    const actors = { resolve: jest.fn(() => Promise.resolve(principal())) };
    const callLog = { record: jest.fn(() => Promise.resolve()) };

    return {
      service: new McpService(
        tools as never,
        actors as never,
        callLog as never,
      ),
      tools,
      callLog,
    };
  }

  it('CD-279: logs each tool call — the person, the tool, the answer or the code', async () => {
    const ok = serviceWith(() => Promise.resolve({ data: [{ id: 'r-1' }] }));
    await ok.service.handle(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_request_types', arguments: { q: 'it' } },
      },
      httpRequest(),
      principal(),
    );
    expect(ok.callLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: principal().userId,
        tool: 'get_request_types',
        args: { q: 'it' },
        result: { data: [{ id: 'r-1' }] },
      }),
    );

    const refused = serviceWith(() =>
      Promise.reject(new AppError('FORBIDDEN', 'ไม่มีสิทธิ์')),
    );
    await refused.service.handle(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_request_types', arguments: {} },
      },
      httpRequest(),
      principal(),
    );
    expect(refused.callLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'FORBIDDEN' }),
    );
  });

  it('answers initialize with the revision it actually speaks', async () => {
    const { service } = serviceWith(() => Promise.resolve({}));

    const answer = await service.handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      httpRequest(),
      principal(),
    );

    expect(answer).toMatchObject({
      id: 1,
      result: { protocolVersion: '2024-11-05' },
    });
    // CD-278 — the chat is told to cite links and to say "not found"
    const instructions = (answer as { result: { instructions: string } }).result
      .instructions;
    expect(instructions).toContain('link');
    expect(instructions).toContain('ไม่พบข้อมูล');
  });

  /** A notification has no `id`; JSON-RPC forbids answering one. */
  it('says nothing back to a notification', async () => {
    const { service } = serviceWith(() => Promise.resolve({}));

    await expect(
      service.handle(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        httpRequest(),
        principal(),
      ),
    ).resolves.toBeNull();
  });

  it('refuses a tool it does not have', async () => {
    const { service } = serviceWith(() => Promise.resolve({}));

    const answer = await service.handle(
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'nope' } },
      httpRequest(),
      principal(),
    );

    expect(answer).toMatchObject({ error: { code: -32602 } });
  });

  /**
   * A catalogue that never loaded is an operator problem, and answering with
   * an empty list looks exactly like a server that has no tools to offer. The
   * container that would not boot is what made this a degraded mode at all —
   * so the degraded mode has to be audible.
   */
  it('says why it has no tools rather than answering with none', async () => {
    const { service } = serviceWith(
      () => Promise.resolve({}),
      'ไม่พบ docs/openapi/external-tools.json',
    );

    await expect(
      service.handle(
        { jsonrpc: '2.0', id: 9, method: 'tools/list' },
        httpRequest(),
        principal(),
      ),
    ).resolves.toMatchObject({ error: { code: -32603 } });

    await expect(
      service.handle(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'get_request_types', arguments: {} },
        },
        httpRequest(),
        principal(),
      ),
    ).resolves.toMatchObject({ error: { code: -32603 } });
  });

  /**
   * A tool that fails is a *result* carrying `isError`, not a JSON-RPC error:
   * the model has to read the reason and try again, and an error frame reaches
   * it as a broken call instead of an answer.
   */
  it('reports a refused action as a tool result, with its code', async () => {
    const { service } = serviceWith(() =>
      Promise.reject(new AppError('REQ_STATE_INVALID', 'สถานะเปลี่ยนไปแล้ว')),
    );

    const answer = (await service.handle(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'get_request_types', arguments: {} },
      },
      httpRequest(),
      principal(),
    )) as { result: { isError: boolean; content: { text: string }[] } };

    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain('REQ_STATE_INVALID');
  });
});
