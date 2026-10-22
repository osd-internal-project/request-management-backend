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
import {
  ACTING_USER_HEADER,
  ActingUserGuard,
  USER_TOKEN_HEADER,
} from './acting-user.guard';

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

  /** A person's Keycloak token, issued to the integration's own client. */
  const USER_JWT = [
    'h',
    Buffer.from(JSON.stringify({ azp: 'aiyara-web', sub: 'u-sales' })).toString(
      'base64url',
    ),
    's',
  ].join('.');
  let tokenPerson: Principal = PERSON;

  const originalFetch = global.fetch;
  let forwardedScopes: string[] = [];

  beforeEach(() => {
    forwardedScopes = [];
    tokenPerson = PERSON;
    global.fetch = jest.fn(
      (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const headers = new Headers(init?.headers);
        if (url.includes('internal/policy/resolve')) {
          // user-service verifies the bearer; a person's JWT resolves to that person
          return json(
            200,
            headers.get('authorization') === `Bearer ${USER_JWT}`
              ? tokenPerson
              : MACHINE,
          );
        }

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

  function wiring(scopes: string[], integration?: Record<string, unknown>) {
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
          ...(integration && { integration }),
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

  function requestWith(
    headers: Record<string, string> = {
      [ACTING_USER_HEADER]: 'sales@osd.co.th',
    },
  ): RequestWithPrincipal {
    return {
      headers: { authorization: 'Bearer rfk_x', ...headers },
    } as unknown as RequestWithPrincipal;
  }

  async function openApiList(
    scopes: string[],
    integration?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    const {
      reflector,
      principals,
      global: guards,
    } = wiring(scopes, integration);
    const request = requestWith(headers);
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

  async function mcpCall(
    scopes: string[],
    integration?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    const { principals, global: guards } = wiring(scopes, integration);
    const request = requestWith(headers);
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

  describe('X-User-Token — key ∩ the person who signed in (22 Oct 2026)', () => {
    const DELEGATED = {
      id: 'int-1',
      modes: ['delegated'],
      allowActingUser: false,
      keycloakClientIds: ['aiyara-web'],
    };
    const TOKEN = { [USER_TOKEN_HEADER]: USER_JWT };

    it("Open API: acts as the token's person, never asking for an email", async () => {
      const request = await openApiList(
        ['integration.request.read'],
        DELEGATED,
        TOKEN,
      );

      expect(getPrincipal(request)).toEqual(PERSON);
      expect(forwardedScopes).toEqual([]);
    });

    it('Open API: the person must hold the permission too', async () => {
      tokenPerson = { ...PERSON, permissions: ['request.create'] };

      await expect(
        openApiList(['integration.request.read'], DELEGATED, TOKEN),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('Open API: a token issued to another client is refused', async () => {
      await expect(
        openApiList(
          ['integration.request.read'],
          { ...DELEGATED, keycloakClientIds: ['someone-else'] },
          TOKEN,
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('Open API: X-Acting-User is refused where the integration turned it off', async () => {
      await expect(
        openApiList(['integration.request.read'], DELEGATED),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(forwardedScopes).toEqual([]);
    });

    it("MCP: resolves the token's person for a tool call", async () => {
      await expect(
        mcpCall(['integration.request.read'], DELEGATED, TOKEN),
      ).resolves.toEqual(PERSON);
    });
  });
});
