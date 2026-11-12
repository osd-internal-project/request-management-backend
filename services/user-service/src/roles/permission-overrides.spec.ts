import type { Permission } from '@request-management/share';
import { applyOverrides } from './permission-overrides';

const NOW = new Date('2026-11-13T10:00:00Z');
const later = new Date('2026-12-01T00:00:00Z');
const earlier = new Date('2026-11-01T00:00:00Z');

const fromRoles = ['request.read', 'crm.sales.read'] as Permission[];

describe('P7 — (roles ∪ GRANT) − REVOKE', () => {
  it('adds a live GRANT and removes a live REVOKE', () => {
    expect(
      applyOverrides(
        fromRoles,
        [
          {
            permissionCode: 'crm.quotation.approve',
            effect: 'GRANT',
            expiresAt: later,
            revokedAt: null,
          },
          {
            permissionCode: 'crm.sales.read',
            effect: 'REVOKE',
            expiresAt: null,
            revokedAt: null,
          },
        ],
        NOW,
      ).sort(),
    ).toEqual(['crm.quotation.approve', 'request.read']);
  });

  it('ignores an expired or revoked row', () => {
    expect(
      applyOverrides(
        fromRoles,
        [
          {
            permissionCode: 'crm.quotation.approve',
            effect: 'GRANT',
            expiresAt: earlier,
            revokedAt: null,
          },
          {
            permissionCode: 'request.read',
            effect: 'REVOKE',
            expiresAt: null,
            revokedAt: earlier,
          },
        ],
        NOW,
      ).sort(),
    ).toEqual(['crm.sales.read', 'request.read']);
  });

  it('a REVOKE wins over a GRANT of the same code', () => {
    expect(
      applyOverrides(
        [],
        [
          {
            permissionCode: 'user.read',
            effect: 'GRANT',
            expiresAt: null,
            revokedAt: null,
          },
          {
            permissionCode: 'user.read',
            effect: 'REVOKE',
            expiresAt: null,
            revokedAt: null,
          },
        ],
        NOW,
      ),
    ).toEqual([]);
  });
});
