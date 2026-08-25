import { isProtectedRole } from './keycloak-admin.service';

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
