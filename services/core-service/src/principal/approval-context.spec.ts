import { ConfigService } from '@nestjs/config';
import { ApprovalContextClient } from './approval-context.client';

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Where the approval context is read FROM.
 *
 * This is not a detail: the client used to read `services.userServiceUrl`, a key
 * configs/index.ts never declares, so every call silently fell back to
 * `http://localhost:3001` — correct on a dev box where user-service runs beside
 * it, and fatal in a container, where localhost is core-service itself. The
 * symptom is a submit that cannot route, far away from the cause.
 */
describe('ApprovalContextClient', () => {
  const CONFIGURED = 'http://user-service:3001/api/v1';
  const originalFetch = global.fetch;

  function clientWith(userServiceUrl: string | undefined) {
    const config = {
      get: (path: string) => ({ userServiceUrl })[path as 'userServiceUrl'],
    } as unknown as ConfigService;

    return new ApprovalContextClient(config);
  }

  /** Records the calls rather than asserting on jest's untyped `mock.calls`. */
  function stubFetch(): Call[] {
    const calls: Call[] = [];

    global.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            orgUnitId: null,
            supervisorUserId: null,
            supervisorChain: [],
            roleHolders: {},
            displayNames: {},
          }),
      });
    }) as unknown as typeof fetch;

    return calls;
  }

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls the user-service URL the configuration names', async () => {
    const calls = stubFetch();

    await clientWith(CONFIGURED).resolve('Bearer t', 'u1', 'c1');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain(
      `${CONFIGURED}/internal/org/approval-context`,
    );
    expect(calls[0].url).not.toContain('localhost');
  });

  it('passes the caller token and company through unchanged', async () => {
    const calls = stubFetch();

    await clientWith(CONFIGURED).resolve('Bearer t', 'u1', 'c1');

    expect(calls[0].init.headers).toEqual({
      Authorization: 'Bearer t',
      'X-Company-Id': 'c1',
    });
  });
});
