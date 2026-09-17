import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  permissionModule,
  permissionType,
} from './permissions';

describe('AUTH-06 — permission type', () => {
  it('marks every integration scope as a service-account one', () => {
    for (const code of PERMISSIONS.integration) {
      expect(permissionType(code)).toBe('service');
    }
  });

  it('marks everything else as held by a person', () => {
    const human = ALL_PERMISSIONS.filter(
      (code) => permissionModule(code) !== 'integration',
    );

    expect(human.length).toBeGreaterThan(0);
    for (const code of human) {
      expect(permissionType(code)).toBe('human');
    }
  });

  it('keeps the whole catalog reachable from the role screen', () => {
    // The screen groups by module; a module in no group is a permission
    // nobody can grant, which is how all nine crm.* went missing.
    expect(new Set(ALL_PERMISSIONS.map(permissionModule)).size).toBe(
      Object.keys(PERMISSIONS).length,
    );
  });
});
