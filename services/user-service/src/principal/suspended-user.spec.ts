import type { KeycloakJwtPayload } from '../auth/strategies/jwt.strategy';
import { PrincipalService } from './principal.service';

/** H2: Keycloak still signs a suspended person in; this app must refuse them. */
describe('a suspended person gets no principal', () => {
  function serviceFor(status: 'ACTIVE' | 'SUSPENDED') {
    const user = {
      id: 'u-1',
      keycloakId: 'kc-1',
      username: 'somchai',
      displayName: 'Somchai',
      email: 'somchai@osd.co.th',
      orgUnitId: 'unit-1',
      supervisorUserId: null,
      lastCompanyId: null,
      primaryCompanyId: 'osd',
      keycloakRoles: [],
      status,
    };
    const org = {
      companiesForUser: jest.fn().mockResolvedValue([
        { company: { id: 'osd', name: 'OSD', docPrefix: 'OSD' }, isPrimary: true },
      ]),
      ledUnitIdsOf: jest.fn().mockResolvedValue([]),
      levelUnitIdsOf: jest.fn().mockResolvedValue([]),
      scopedAccessOf: jest.fn().mockResolvedValue({
        readUnits: [],
        actUnits: [],
        readUsers: [],
        actUsers: [],
        byPermission: {},
      }),
    };

    return new PrincipalService(
      { upsertFromClaims: jest.fn().mockResolvedValue(user) } as never,
      org as never,
      { rolesForUser: jest.fn().mockResolvedValue([]) } as never,
      {
        resolveVisibleSensitiveFields: jest.fn().mockResolvedValue([]),
        listAllSensitiveFieldKeys: jest.fn().mockResolvedValue([]),
      } as never,
      { get: () => 'request-form' } as never,
    );
  }

  const payload = {
    sub: 'kc-1',
    preferred_username: 'somchai',
  } as unknown as KeycloakJwtPayload;

  it('answers USER_SUSPENDED (403) for a suspended account', async () => {
    await expect(serviceFor('SUSPENDED').resolve(payload)).rejects.toMatchObject({
      code: 'USER_SUSPENDED',
      httpStatus: 403,
    });
  });

  it('still resolves an active account', async () => {
    await expect(serviceFor('ACTIVE').resolve(payload)).resolves.toMatchObject({
      userId: 'u-1',
    });
  });
});
