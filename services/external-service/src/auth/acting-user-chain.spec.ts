import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  RemotePrincipalGuard,
  RemotePrincipalService,
} from '@request-management/core-service';
import {
  ACTING_SCOPES,
  ActingPolicyGuard,
  API_KEY_SCOPES_HEADER,
  CompanyGuard,
  decodeKeyScopes,
  getPrincipal,
  PolicyGuard,
} from '@request-management/share';
import type {
  Principal,
  RequestWithPrincipal,
} from '@request-management/share';
import { McpActorService } from '../mcp/mcp-actor';
import { McpController } from '../mcp/mcp.controller';
import { RequestController } from '../request/request.controller';
import { ACTING_USER_HEADER, ActingUserGuard } from './acting-user.guard';

/**
 * Open API and MCP with `X-Acting-User`, through every guard in Nest's order.
 * Only the key lookup and user-service are faked; user-service applies the
 * rule it enforces — `integration.request.create` from the forwarded key scopes.
 */
describe('X-Acting-User through the real guard chain (Open API + MCP)', () => {
  const PERSON = {
    userId: 'u-sales',
    activeCompanyId: 'osd',
    companies: [{ id: 'osd' }],
    isServiceAccount: false,
    pendingOrgAssignment: false,
    permissions: ['request.read', 'request.create'],
  } as unknown as Principal;

  const MACHINE = {
    userId: 'svc',
    username: 'service-account-request-form',
    activeCompanyId: '',
    companies: [],
    isServiceAccount: true,
    permissions: [],
  } as unknown as Principal;

  const originalFetch = global.fetch;
  let forwardedScopes: string[] = [];

  beforeEach(() => {
    forwardedScopes = [];
    global.fetch = jest.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const headers = new Headers(init?.headers);
        if (url.includes('internal/policy/resolve')) return json(200, MACHINE);

        forwardedScopes = decodeKeyScopes(headers.get(API_KEY_SCOPES_HEADER));
        if (!forwardedScopes.some((s) => ACTING_SCOPES.includes(s as never))) {
          return json(403, {
            code: 'FORBIDDEN',
            message: 'ไม่มีสิทธิ์ใช้งานส่วนนี้',
          });
        }
        return json(200, PERSON);
      },
    ) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function json(status: number, body: unknown) {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  function wiring(scopes: string[]) {
    const reflector = new Reflector();
    const principals = new RemotePrincipalService({
      get: () => 'http://user-service',
    } as never);
    const apiKeys = {
      resolve: jest.fn().mockResolvedValue({
        accessToken: 'minted',
        key: {
          id: 'k1',
          prefix: 'rfk_x',
          name: 'bot',
          companyId: null,
          sourceCode: null,
          scopes,
        },
      }),
    };
    return {
      reflector,
      principals,
      global: [
        new RemotePrincipalGuard(reflector, principals, apiKeys as never),
        new CompanyGuard(reflector),
        new PolicyGuard(reflector),
      ],
    };
  }

  function contextFor(
    controller: object,
    handler: unknown,
    request: RequestWithPrincipal,
  ): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function requestWith(): RequestWithPrincipal {
    return {
      headers: {
        authorization: 'Bearer rfk_x',
        [ACTING_USER_HEADER]: 'sales@osd.co.th',
      },
    } as unknown as RequestWithPrincipal;
  }

  async function openApiList(scopes: string[]) {
    const { reflector, principals, global: guards } = wiring(scopes);
    const request = requestWith();
    const context = contextFor(
      RequestController,
      Reflect.get(RequestController.prototype, 'list'),
      request,
    );
    for (const guard of guards) await guard.canActivate(context);
    await new ActingUserGuard(principals).canActivate(context);
    new ActingPolicyGuard(reflector).canActivate(context);
    return request;
  }

  async function mcpCall(scopes: string[]) {
    const { principals, global: guards } = wiring(scopes);
    const request = requestWith();
    const context = contextFor(
      McpController,
      Reflect.get(McpController.prototype, 'handle') as unknown,
      request,
    );
    for (const guard of guards) await guard.canActivate(context);
    const caller = getPrincipal(request)!;
    return new McpActorService(principals).resolve(request, caller);
  }

  it('Open API: a key holding integration.request.read acts as the named person', async () => {
    const request = await openApiList(['integration.request.read']);

    expect(getPrincipal(request)).toEqual(PERSON);
    expect(forwardedScopes).toEqual(['integration.request.read']);
  });

  it('Open API: a key without the scope stops at the external gate', async () => {
    await expect(
      openApiList(['integration.crm.lead.create']),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(forwardedScopes).toEqual([]);
  });

  it('MCP: a key holding integration.request.create resolves the person for a tool call', async () => {
    await expect(mcpCall(['integration.request.create'])).resolves.toEqual(
      PERSON,
    );
    expect(forwardedScopes).toEqual(['integration.request.create']);
  });

  it('MCP: user-service refuses the lookup when the key lacks the scope', async () => {
    await expect(mcpCall(['request.create'])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
