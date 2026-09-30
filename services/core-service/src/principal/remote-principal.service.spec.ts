import { API_KEY_SCOPES_HEADER, AppError } from '@request-management/share';
import { RemotePrincipalService } from './remote-principal.service';

/**
 * A 403 from user-service is reported as user-service said it. Folding every
 * 403 into `COMPANY_FORBIDDEN` sent a missing-permission failure of the
 * external API looking for a company problem that did not exist.
 */
describe('RemotePrincipalService — 403 keeps user-service’s own error', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function serviceAnswering(status: number, body: unknown) {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const config = { get: () => 'http://user-service' };
    return new RemotePrincipalService(config as never);
  }

  async function errorOf(promise: Promise<unknown>): Promise<AppError> {
    try {
      await promise;
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
    throw new Error('expected the call to fail');
  }

  it('passes FORBIDDEN through instead of calling it a company problem', async () => {
    const service = serviceAnswering(403, {
      code: 'FORBIDDEN',
      message: 'บัญชีบริการนี้ไม่ได้รับอนุญาตให้ค้นหาผู้ใช้',
      details: [{ field: 'principal', reason: 'service-account-librechat' }],
    });

    const error = await errorOf(
      service.resolveActingUser('Bearer t', 'a@osd.co.th'),
    );

    expect(error.code).toBe('FORBIDDEN');
    expect(error.details).toEqual([
      { field: 'principal', reason: 'service-account-librechat' },
    ]);
  });

  it('keeps COMPANY_FORBIDDEN when that is what user-service answered', async () => {
    const service = serviceAnswering(403, {
      code: 'COMPANY_FORBIDDEN',
      message: 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทนี้',
    });

    const error = await errorOf(service.resolve('Bearer t', 'other-co'));

    expect(error.code).toBe('COMPANY_FORBIDDEN');
  });

  it('falls back to FORBIDDEN for an unreadable body', async () => {
    const service = serviceAnswering(403, 'not json');

    const error = await errorOf(
      service.resolveActingUser('Bearer t', 'b@osd.co.th'),
    );

    expect(error.code).toBe('FORBIDDEN');
  });
});

describe('RemotePrincipalService — forwards the API key scopes', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function recordingService() {
    const inits: RequestInit[] = [];
    const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
      inits.push(init ?? {});
      return Promise.resolve(
        new Response(JSON.stringify({ userId: 'u-1' }), { status: 200 }),
      );
    });
    global.fetch = fetchMock;
    const service = new RemotePrincipalService({
      get: () => 'http://user-service',
    } as never);
    return { service, fetchMock, inits };
  }

  const headersOf = (init: RequestInit) => new Headers(init.headers);

  it('sends the key scopes to user-service on resolve-by-email', async () => {
    const { service, inits } = recordingService();

    await service.resolveActingUser('Bearer t', 'a@osd.co.th', undefined, [
      'integration.request.create',
      'integration.crm.lead.create',
    ]);

    expect(headersOf(inits[0]).get(API_KEY_SCOPES_HEADER)).toBe(
      'integration.crm.lead.create,integration.request.create',
    );
  });

  it('does not reuse a cached answer for a key with different scopes', async () => {
    const { service, fetchMock, inits } = recordingService();

    await service.resolveActingUser('Bearer t', 'a@osd.co.th', undefined, [
      'integration.request.create',
    ]);
    await service.resolveActingUser('Bearer t', 'a@osd.co.th', undefined, []);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(headersOf(inits[1]).get(API_KEY_SCOPES_HEADER)).toBeNull();
  });
});
