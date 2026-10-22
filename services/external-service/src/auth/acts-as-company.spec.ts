import type { ExecutionContext } from '@nestjs/common';
import { setApiKey } from '@request-management/core-service';
import type { RequestWithPrincipal } from '@request-management/share';
import { CompanyModeGuard } from './acts-as-company.decorator';

describe('CompanyModeGuard — routes with nobody at the other end', () => {
  function contextWith(integration?: object): ExecutionContext {
    const request = { headers: {} } as unknown as RequestWithPrincipal;
    setApiKey(request, {
      id: 'k',
      prefix: 'rfk_x',
      name: 'bot',
      companyId: 'osd',
      sourceCode: null,
      scopes: [],
      ...(integration && { integration }),
    } as never);
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  const policy = (modes: string[]) => ({
    id: 'int-1',
    modes,
    allowActingUser: false,
    keycloakClientIds: [],
  });

  it('lets an integration in app mode through', () => {
    expect(
      new CompanyModeGuard().canActivate(contextWith(policy(['app']))),
    ).toBe(true);
  });

  it('refuses an integration that only acts for people', () => {
    expect(() =>
      new CompanyModeGuard().canActivate(contextWith(policy(['delegated']))),
    ).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }) as Error);
  });

  it('keeps a key from before integrations working', () => {
    expect(new CompanyModeGuard().canActivate(contextWith())).toBe(true);
  });
});
