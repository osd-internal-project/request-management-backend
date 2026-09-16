import { AppError } from '@request-management/share';
import type { Principal } from '@request-management/share';
import { ACTING_USER_HEADER, ActingUserGuard } from './acting-user.guard';

const BOT: Partial<Principal> = {
  userId: 'service-account-aiyara',
  isServiceAccount: true,
};

const PERSON: Principal = {
  userId: 'user-sales',
  isServiceAccount: false,
  pendingOrgAssignment: false,
} as Principal;

/** A Nest execution context carrying one Express-shaped request. */
function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function guardWith(resolved: Principal | Error) {
  const resolveActingUser = jest.fn(() =>
    resolved instanceof Error
      ? Promise.reject(resolved)
      : Promise.resolve(resolved),
  );

  return {
    guard: new ActingUserGuard({ resolveActingUser } as never),
    resolveActingUser,
  };
}

describe('the acting-user swap', () => {
  it('replaces the service account with the person it names', async () => {
    const { guard, resolveActingUser } = guardWith(PERSON);
    const request = {
      headers: {
        authorization: 'Bearer bot-token',
        [ACTING_USER_HEADER]: 'sales@example.com',
        'x-company-id': 'company-osd',
      },
      principal: BOT,
    };

    await guard.canActivate(contextFor(request));

    // From here the request is the person's — which is what makes every
    // downstream rule apply to them rather than to the robot.
    expect(request.principal).toBe(PERSON);
    expect(resolveActingUser).toHaveBeenCalledWith(
      'Bearer bot-token',
      'sales@example.com',
      'company-osd',
    );
  });

  it('trims the address before looking it up', async () => {
    const { guard, resolveActingUser } = guardWith(PERSON);

    await guard.canActivate(
      contextFor({
        headers: {
          authorization: 'Bearer bot-token',
          [ACTING_USER_HEADER]: '  sales@example.com  ',
        },
        principal: BOT,
      }),
    );

    expect(resolveActingUser).toHaveBeenCalledWith(
      'Bearer bot-token',
      'sales@example.com',
      undefined,
    );
  });

  /*
    The controller carries `@ServiceAccountOnly`, so this should be
    unreachable. Checked anyway: if these routes were ever opened to people,
    honouring the header would turn the API into an impersonation endpoint,
    and that failure must not depend on a decorator somewhere else.
  */
  it("refuses a person's own token outright", async () => {
    const { guard, resolveActingUser } = guardWith(PERSON);

    await expect(
      guard.canActivate(
        contextFor({
          headers: { [ACTING_USER_HEADER]: 'someone.else@example.com' },
          principal: PERSON,
        }),
      ),
    ).rejects.toThrow(AppError);

    expect(resolveActingUser).not.toHaveBeenCalled();
  });

  it('refuses a call that names nobody', async () => {
    const { guard, resolveActingUser } = guardWith(PERSON);

    await expect(
      guard.canActivate(
        contextFor({
          headers: { authorization: 'Bearer bot' },
          principal: BOT,
        }),
      ),
    ).rejects.toThrow(AppError);

    expect(resolveActingUser).not.toHaveBeenCalled();
  });

  /**
   * AUTH-04: somebody not yet placed in the org chart has no supervisor, so
   * nothing they submit could route. Refused here with a reason rather than
   * left to fail further in with a message about approval chains.
   */
  it('refuses somebody who has not been placed in the org chart', async () => {
    const { guard } = guardWith({
      ...PERSON,
      pendingOrgAssignment: true,
    });

    await expect(
      guard.canActivate(
        contextFor({
          headers: {
            authorization: 'Bearer bot',
            [ACTING_USER_HEADER]: 'newjoiner@example.com',
          },
          principal: BOT,
        }),
      ),
    ).rejects.toThrow(AppError);
  });
});
