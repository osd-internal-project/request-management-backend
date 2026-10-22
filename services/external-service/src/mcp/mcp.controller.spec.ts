import type {
  Principal,
  RequestWithPrincipal,
} from '@request-management/share';
import { McpController } from './mcp.controller';

/** MCP 2025-06-18 — header `MCP-Protocol-Version` and the person token's `aud`. */
describe('McpController', () => {
  const person = { userId: 'u-1', isServiceAccount: false } as Principal;
  const robot = { userId: 'sa-1', isServiceAccount: true } as Principal;

  function jwt(claims: Record<string, unknown>): string {
    const part = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
  }

  function call(
    caller: Principal,
    headers: Record<string, string>,
    audience?: string,
  ) {
    const mcp = { handle: jest.fn().mockResolvedValue({ id: 1 }) };
    const config = { get: () => audience };
    const controller = new McpController(mcp as never, config as never);
    const answer = controller.handle(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { headers } as unknown as RequestWithPrincipal,
      caller,
      { status: jest.fn() } as never,
    );
    return { answer, mcp };
  }

  it('accepts a known MCP-Protocol-Version or none; refuses an unknown one with 400', async () => {
    await expect(
      call(person, { 'mcp-protocol-version': '2025-06-18' }).answer,
    ).resolves.toEqual({ id: 1 });
    await expect(call(person, {}).answer).resolves.toEqual({ id: 1 });

    const refused = call(person, { 'mcp-protocol-version': '2099-01-01' });
    await expect(refused.answer).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(refused.mcp.handle).not.toHaveBeenCalled();
  });

  it('with MCP_TOKEN_AUDIENCE set, a person token must carry it in aud', async () => {
    const aud = 'osd-mcp';
    const ok = call(
      person,
      { authorization: `Bearer ${jwt({ aud: ['account', aud] })}` },
      aud,
    );
    await expect(ok.answer).resolves.toEqual({ id: 1 });

    const other = call(
      person,
      { authorization: `Bearer ${jwt({ aud: 'account' })}` },
      aud,
    );
    await expect(other.answer).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(other.mcp.handle).not.toHaveBeenCalled();
  });

  it('unset audience checks nothing; a key is never a JWT and is not checked', async () => {
    const noAud = { authorization: `Bearer ${jwt({ aud: 'account' })}` };
    await expect(call(person, noAud).answer).resolves.toEqual({ id: 1 });
    await expect(
      call(robot, { authorization: 'Bearer rfk_abc' }, 'osd-mcp').answer,
    ).resolves.toEqual({ id: 1 });
  });
});
