import { EventEmitter } from 'node:events';
import { setPrincipal, type Principal } from '@request-management/share';
import { setApiKey } from '@request-management/core-service';
import { IntegrationCallMiddleware } from './integration-call.middleware';

/** `integration_calls` — หนึ่งแถวต่อคำขอ, route เป็น template, ไม่เก็บ body/header. */
describe('IntegrationCallMiddleware', () => {
  const key = {
    id: 'key-1',
    prefix: 'rfk_x',
    name: 'Aiyara',
    companyId: 'osd',
    sourceCode: null,
    scopes: [],
    integration: {
      id: 'int-1',
      modes: ['app', 'delegated'],
      allowActingUser: false,
      keycloakClientIds: ['aiyara'],
    },
  };

  function run(
    setup: (request: Record<string, unknown>) => void,
    headers: Record<string, string> = {},
    status = 200,
  ) {
    const calls = { record: jest.fn().mockResolvedValue(undefined) };
    const request: Record<string, unknown> = {
      method: 'GET',
      headers,
      baseUrl: '',
      route: { path: '/api/v1/requests/:id' },
      body: { secret: 'never logged' },
    };
    const response = Object.assign(new EventEmitter(), { statusCode: status });
    const next = jest.fn();
    new IntegrationCallMiddleware(calls as never).use(
      request as never,
      response as never,
      next,
    );
    setup(request);
    response.emit('finish');
    expect(next).toHaveBeenCalled();
    return calls.record;
  }

  it('key + X-User-Token: the person after the swap, the key’s integration', () => {
    const record = run(
      (request) => {
        setApiKey(request as never, key);
        setPrincipal(
          request as never,
          {
            userId: 'u-1',
            activeCompanyId: 'osd',
            isServiceAccount: false,
          } as Principal,
        );
      },
      { 'x-user-token': 'eyJ…' },
    );
    expect(record).toHaveBeenCalledWith({
      integrationId: 'int-1',
      apiKeyId: 'key-1',
      companyId: 'osd',
      method: 'GET',
      route: '/api/v1/requests/:id',
      mode: 'user_token',
      actorUserId: 'u-1',
      status: 200,
      durationMs: expect.any(Number) as number,
    });
  });

  it('a call the scope check refused is still logged, in mode app with no person', () => {
    const record = run(
      (request) => {
        setApiKey(request as never, key);
        setPrincipal(
          request as never,
          {
            userId: 'sa-1',
            activeCompanyId: 'osd',
            isServiceAccount: true,
          } as Principal,
        );
      },
      {},
      403,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'app', actorUserId: null, status: 403 }),
    );
  });

  it('a person’s own token is mode person; an unknown caller is not logged', () => {
    const person = run((request) =>
      setPrincipal(
        request as never,
        {
          userId: 'u-2',
          activeCompanyId: 'osd',
          isServiceAccount: false,
        } as Principal,
      ),
    );
    expect(person).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'person',
        integrationId: null,
        actorUserId: 'u-2',
      }),
    );

    expect(run(() => undefined, {}, 401)).not.toHaveBeenCalled();
  });
});
