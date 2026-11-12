import { AppError } from '../errors/app-error';
import type { Principal } from './principal';
import {
  assertCompanyMember,
  isCompanyMember,
  requireActiveCompany,
  resolveTargetCompany,
} from './target-company';

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
    systemPermissions: [],
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

describe('requireActiveCompany — reads judged by the active company’s rights', () => {
  it('answers the active company when none is named', () => {
    expect(requireActiveCompany(principal(), undefined)).toBe(OSD);
  });

  it('refuses another company even when the caller belongs to it', () => {
    expect(() => requireActiveCompany(principal(), BCO)).toThrow(AppError);
  });
});

describe('isCompanyMember — what an admin write may touch', () => {
  it('a member company: yes; another company: no', () => {
    expect(isCompanyMember(principal(), BCO)).toBe(true);
    expect(isCompanyMember(principal(), OUTSIDER)).toBe(false);
  });

  it('a row shared by every company is never a company admin’s', () => {
    expect(isCompanyMember(principal(), null)).toBe(false);
  });
});
