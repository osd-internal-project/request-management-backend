import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { of } from 'rxjs';
import {
  isProtectedRole,
  KeycloakAdminService,
} from './keycloak-admin.service';

describe('Keycloak privilege-escalation guard', () => {
  /**
   * The point of this guard: `admin.identity.manage` lets someone administer
   * *this* system's identities. It must not become a route to administering
   * Keycloak itself, in a realm shared with other projects.
   */
  describe('refuses roles that confer control of Keycloak', () => {
    const forbidden = [
      'realm-admin',
      'manage-realm',
      'manage-users',
      'manage-clients',
      'manage-authorization',
      'create-client',
      'realm-management',
    ];

    it.each(forbidden)('blocks %s', (role) => {
      expect(isProtectedRole(role)).toBe(true);
    });

    it('is case-insensitive, so casing cannot slip past it', () => {
      expect(isProtectedRole('Realm-Admin')).toBe(true);
      expect(isProtectedRole('MANAGE-REALM')).toBe(true);
    });
  });

  describe('allows ordinary application roles', () => {
    const allowed = [
      'sales',
      'team_lead',
      'pricing',
      'employee',
      'auditor',
      // Similar-looking but harmless — the patterns are anchored, so these
      // are not caught by accident.
      'realm-admin-viewer',
      'sales-manager',
    ];

    it.each(allowed)('permits %s', (role) => {
      expect(isProtectedRole(role)).toBe(false);
    });
  });
});

describe('KeycloakAdminService — roles are client roles of request-form', () => {
  const admin = 'http://kc/admin/realms/OSD';
  const role = { id: 'r1', name: 'employee' };

  function setup() {
    const settings: Record<string, string> = {
      'keycloak.clientId': 'request-form',
      'keycloak.clientSecret': 'secret',
      'keycloak.tokenUrl': 'http://kc/token',
      'keycloak.adminBaseUrl': admin,
    };
    const config = { get: (key: string) => settings[key] };
    const get = jest.fn((url: string) => {
      if (url.includes('/clients?clientId='))
        return of({ data: [{ id: 'c-uuid', clientId: 'request-form' }] });
      if (url.endsWith('/clients/c-uuid/roles')) return of({ data: [role] });
      if (url.endsWith('/role-mappings/realm'))
        return of({ data: [{ id: 'x', name: 'offline_access' }] });
      return of({ data: [role] });
    });
    const http = {
      get,
      post: jest.fn((url: string) =>
        url.endsWith('/token')
          ? of({ data: { access_token: 't', expires_in: 300 } })
          : of({ data: undefined }),
      ),
      delete: jest.fn(() => of({ data: undefined })),
      put: jest.fn(),
    };
    const service = new KeycloakAdminService(
      http as unknown as HttpService,
      config as unknown as ConfigService,
    );
    return { service, http };
  }

  it('grants onto the client role mapping, never the realm one', async () => {
    const { service, http } = setup();
    await service.grantClientRole('u1', 'employee');
    expect(http.post).toHaveBeenCalledWith(
      `${admin}/users/u1/role-mappings/clients/c-uuid`,
      [role],
      expect.anything(),
    );
  });

  it('revokes from the client role mapping', async () => {
    const { service, http } = setup();
    await service.revokeClientRole('u1', 'employee');
    expect(http.delete).toHaveBeenCalledWith(
      `${admin}/users/u1/role-mappings/clients/c-uuid`,
      expect.anything(),
    );
  });

  it('lists realm and client roles together, as a token carries them', async () => {
    const { service } = setup();
    const names = (await service.listUserRoles('u1')).map((r) => r.name);
    expect(names).toEqual(['offline_access', 'employee']);
  });

  it('looks the client up once', async () => {
    const { service, http } = setup();
    await service.listClientRoles();
    await service.listClientRoles();
    const lookups = http.get.mock.calls.filter(([url]) =>
      url.includes('/clients?clientId='),
    );
    expect(lookups).toHaveLength(1);
  });

  it('still refuses a Keycloak-controlling role before any call', async () => {
    const { service, http } = setup();
    await expect(
      service.grantClientRole('u1', 'realm-admin'),
    ).rejects.toThrow();
    expect(http.post).not.toHaveBeenCalled();
  });
});
