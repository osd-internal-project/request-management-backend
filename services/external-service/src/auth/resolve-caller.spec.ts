import { setApiKey } from '@request-management/core-service';
import type {
  Principal,
  RequestWithPrincipal,
} from '@request-management/share';
import {
  ACTING_USER_HEADER,
  resolveCaller,
  tokenClientId,
  USER_TOKEN_HEADER,
} from './resolve-caller';

/** วิธีเรียกในนามผู้ใช้ทั้งสามแบบ — กรณีที่ chain spec ไม่ได้ครอบ. */
describe('resolveCaller', () => {
  const jwt = (claims: object) =>
    ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join(
      '.',
    );
  const TOKEN = jwt({ azp: 'aiyara-web' });
  const MACHINE = { isServiceAccount: true } as Principal;
  const PERSON = {
    userId: 'u-1',
    email: 'sales@osd.co.th',
    activeCompanyId: 'osd',
    isServiceAccount: false,
    pendingOrgAssignment: false,
  } as unknown as Principal;
  const DELEGATED = {
    id: 'int-1',
    modes: ['delegated'],
    allowActingUser: false,
    keycloakClientIds: ['aiyara-web'],
  };

  function requestWith(
    headers: Record<string, string>,
    key?: { companyId?: string | null; integration?: object },
  ): RequestWithPrincipal {
    const request = { headers } as unknown as RequestWithPrincipal;
    if (key) {
      setApiKey(request, {
        id: 'k',
        prefix: 'rfk_x',
        name: 'bot',
        companyId: key.companyId ?? null,
        sourceCode: null,
        scopes: ['integration.request.read'],
        ...(key.integration && { integration: key.integration }),
      } as never);
    }
    return request;
  }

  function principalsReturning(person: Principal = PERSON) {
    return {
      resolve: jest.fn().mockResolvedValue(person),
      resolveActingUser: jest.fn().mockResolvedValue(person),
    };
  }

  it('refuses both headers at once', async () => {
    const principals = principalsReturning();
    await expect(
      resolveCaller(
        requestWith(
          { [USER_TOKEN_HEADER]: TOKEN, [ACTING_USER_HEADER]: 'a@b.c' },
          { integration: DELEGATED },
        ),
        MACHINE,
        principals as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(principals.resolve).not.toHaveBeenCalled();
  });

  it('refuses a person in another company than the key’s (404, not a silent switch)', async () => {
    await expect(
      resolveCaller(
        requestWith(
          { [USER_TOKEN_HEADER]: TOKEN },
          { companyId: 'osd-demo', integration: DELEGATED },
        ),
        MACHINE,
        principalsReturning() as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a user token when the integration does not act for people', async () => {
    const principals = principalsReturning();
    await expect(
      resolveCaller(
        requestWith(
          { [USER_TOKEN_HEADER]: TOKEN },
          { integration: { ...DELEGATED, modes: ['app'] } },
        ),
        MACHINE,
        principals as never,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(principals.resolve).not.toHaveBeenCalled();
  });

  it('a key from before integrations keeps X-Acting-User working', async () => {
    const principals = principalsReturning();
    await expect(
      resolveCaller(
        requestWith({ [ACTING_USER_HEADER]: 'sales@osd.co.th' }, {}),
        MACHINE,
        principals as never,
      ),
    ).resolves.toBe(PERSON);
    expect(principals.resolveActingUser).toHaveBeenCalled();
  });

  it('a person signed in themselves cannot name somebody else', async () => {
    await expect(
      resolveCaller(
        requestWith({ [USER_TOKEN_HEADER]: TOKEN }),
        PERSON,
        principalsReturning() as never,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('reads azp, and nothing from a malformed token', () => {
    expect(tokenClientId(TOKEN)).toBe('aiyara-web');
    expect(tokenClientId('not-a-jwt')).toBeNull();
    expect(tokenClientId('h.%%%.s')).toBeNull();
    expect(tokenClientId(jwt({ azp: 7 }))).toBeNull();
  });
});
