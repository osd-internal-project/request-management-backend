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
      {
        upsertFromClaims: jest
          .fn()
          .mockResolvedValue({ user, relinkedFrom: null }),
      } as never,
      org as never,
      {
        rolesForUser: jest.fn().mockResolvedValue([]),
        systemPermissionsOf: jest.fn().mockResolvedValue([]),
      } as never,
      {
        resolveVisibleSensitiveFields: jest.fn().mockResolvedValue([]),
        listAllSensitiveFieldKeys: jest.fn().mockResolvedValue([]),
      } as never,
      { get: () => 'request-form' } as never,
      { record: jest.fn() } as never,
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

describe('identity.relinked — a username match that takes a row is on the record', () => {
  it('writes an audit row with the old and new Keycloak subject', async () => {
    const user = {
      id: 'u-1',
      keycloakId: 'kc-new',
      username: 'somchai',
      displayName: 'Somchai',
      email: null,
      orgUnitId: null,
      supervisorUserId: null,
      lastCompanyId: null,
      primaryCompanyId: 'osd',
      keycloakRoles: [],
      status: 'ACTIVE',
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new PrincipalService(
      {
        upsertFromClaims: jest
          .fn()
          .mockResolvedValue({ user, relinkedFrom: 'kc-old' }),
      } as never,
      { companiesForUser: jest.fn().mockResolvedValue([]) } as never,
      { systemPermissionsOf: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { get: () => 'request-form' } as never,
      audit as never,
    );

    await service.resolve({
      sub: 'kc-new',
      preferred_username: 'somchai',
    } as unknown as KeycloakJwtPayload);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'identity.relinked',
        resourceId: 'u-1',
        before: { keycloakId: 'kc-old' },
        after: { keycloakId: 'kc-new' },
      }),
    );
  });
});
