import { AppError } from '../errors/app-error';
import type { Principal } from './principal';
import { assertCompanyMember, resolveTargetCompany } from './target-company';

const OSD = 'company-osd';
const BCO = 'company-bco';
const OUTSIDER = 'company-someone-else';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    keycloakId: 'kc-1',
    username: 'uatadmin',
    displayName: 'UAT Admin',
    email: null,
    companies: [
      { id: OSD, name: 'OSD', docPrefix: 'OSD', isPrimary: true },
      { id: BCO, name: 'BCO', docPrefix: 'BCO', isPrimary: false },
    ],
    activeCompanyId: OSD,
    orgUnitId: null,
    supervisorUserId: null,
    ledUnitIds: [],
    levelUnitIds: [],
    scopedUnitIds: [],
    scopedActUnitIds: [],
    scopedUserIds: [],
    scopedActUserIds: [],
    scopedByPermission: {},
    roles: [],
    permissions: [],
    sensitiveFieldsVisible: [],
    sensitiveFieldsAll: [],
    isServiceAccount: false,
    pendingOrgAssignment: false,
    ...overrides,
  };
}

describe('resolveTargetCompany (SCOPE-03, D-11)', () => {
  it('falls back to the active company when none is named', () => {
    expect(resolveTargetCompany(principal(), undefined)).toBe(OSD);
  });

  it('allows another company the caller belongs to — A1 configures each from one screen', () => {
    expect(resolveTargetCompany(principal(), BCO)).toBe(BCO);
  });

  it('refuses a company the caller has no membership in', () => {
    expect(() => resolveTargetCompany(principal(), OUTSIDER)).toThrow(AppError);

    try {
      resolveTargetCompany(principal(), OUTSIDER);
    } catch (error) {
      expect((error as AppError).code).toBe('COMPANY_FORBIDDEN');
    }
  });

  it('does not fall back to the active company when the named one is refused', () => {
    // The dangerous failure is not the error — it is silently configuring the
    // caller's own company while the screen says another one.
    expect(() => resolveTargetCompany(principal(), OUTSIDER)).toThrow();
  });

  it('AUTH-06: a service account names its company without membership', () => {
    const integration = principal({
      isServiceAccount: true,
      companies: [],
    });

    expect(resolveTargetCompany(integration, OUTSIDER)).toBe(OUTSIDER);
  });
});

describe('assertCompanyMember', () => {
  it('passes for a company the caller belongs to', () => {
    expect(() => assertCompanyMember(principal(), BCO)).not.toThrow();
  });

  it('throws for one they do not', () => {
    expect(() => assertCompanyMember(principal(), OUTSIDER)).toThrow(AppError);
  });
});
