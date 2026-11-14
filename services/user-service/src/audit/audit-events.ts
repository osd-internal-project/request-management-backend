/**
 * Every audit event this service can emit.
 *
 * Kept as one closed list so `GET /audit-logs?event_type=` has a finite
 * vocabulary an auditor can filter on, rather than whatever string a caller
 * happened to pass.
 */
export const AuditEvent = {
  // AUTH-07
  LOGIN_SUCCEEDED: 'auth.login.succeeded',
  LOGIN_FAILED: 'auth.login.failed',
  LOGOUT: 'auth.logout',
  COMPANY_SWITCHED: 'auth.company.switched',
  USER_PROVISIONED: 'auth.user.provisioned',

  // ROLE-05
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_DEACTIVATED: 'role.deactivated',
  ROLE_GRANTED: 'role.granted',
  ROLE_REVOKED: 'role.revoked',
  KEYCLOAK_MAPPING_UPDATED: 'role.keycloak_mapping.updated',
  KEYCLOAK_ROLES_SYNCED: 'role.keycloak_mapping.synced',
  /** A realm role was renamed and this system followed it. */
  KEYCLOAK_ROLE_RENAMED: 'role.keycloak_mapping.renamed',

  // AUTH-04 / D-08
  ORG_UNIT_CREATED: 'org.unit.created',
  ORG_UNIT_UPDATED: 'org.unit.updated',
  ORG_UNIT_DELETED: 'org.unit.deleted',
  /** Which groups this group may see — SCOPE-01's replacement. */
  ORG_UNIT_SCOPES_REPLACED: 'org.unit.scopes.replaced',
  ORG_USER_ASSIGNED: 'org.user.assigned',

  // SCOPE-01 / SCOPE-04 / SCOPE-05
  SENSITIVE_FIELD_RULE_UPDATED: 'scope.sensitive_field_rule.updated',
  SENSITIVE_FIELD_READ: 'scope.sensitive_field.read',

  // admin.identity.manage — writes that leave our database and land in the
  // shared corporate realm, so they matter more than most.
  IDENTITY_ROLE_GRANTED: 'identity.role.granted',
  IDENTITY_ROLE_REVOKED: 'identity.role.revoked',
  IDENTITY_GROUP_JOINED: 'identity.group.joined',
  IDENTITY_GROUP_LEFT: 'identity.group.left',
  // A login matched by username took over a row under a new Keycloak subject
  // (the id24 realm move). Kept visible because the same path is a takeover.
  IDENTITY_RELINKED: 'identity.relinked',

  // P5 — ระดับระบบ (companyId null ใน audit ยกเว้นงานที่ลงบริษัทเดียว)
  ORG_USER_REMOVED: 'org.user.removed',
  SYSTEM_USER_SUSPENDED: 'system.user.suspended',
  SYSTEM_USER_REACTIVATED: 'system.user.reactivated',
  SYSTEM_USER_COMPANIES_REPLACED: 'system.user.companies.replaced',
  SYSTEM_COMPANY_CREATED: 'system.company.created',
  SYSTEM_COMPANY_UPDATED: 'system.company.updated',
  SYSTEM_ROLE_GRANTED: 'system.role.granted',
  SYSTEM_ROLE_REVOKED: 'system.role.revoked',
  // P6 — one row per switch into a company the system admin is not a member of (Q3)
  SYSTEM_TENANT_ENTERED: 'system.tenant.entered',
  // P7
  PERMISSION_OVERRIDE_SET: 'role.permission_override.set',
  PERMISSION_OVERRIDE_REVOKED: 'role.permission_override.revoked',
} as const;

export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent];
