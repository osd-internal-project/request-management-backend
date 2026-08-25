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

  // AUTH-04 / D-08
  ORG_UNIT_CREATED: 'org.unit.created',
  ORG_UNIT_UPDATED: 'org.unit.updated',
  ORG_USER_ASSIGNED: 'org.user.assigned',

  // SCOPE-01 / SCOPE-04 / SCOPE-05
  SCOPE_RULE_UPDATED: 'scope.rule.updated',
  SENSITIVE_FIELD_RULE_UPDATED: 'scope.sensitive_field_rule.updated',
  SENSITIVE_FIELD_READ: 'scope.sensitive_field.read',

  // admin.identity.manage — writes that leave our database and land in the
  // shared corporate realm, so they matter more than most.
  IDENTITY_ROLE_GRANTED: 'identity.role.granted',
  IDENTITY_ROLE_REVOKED: 'identity.role.revoked',
  IDENTITY_GROUP_JOINED: 'identity.group.joined',
  IDENTITY_GROUP_LEFT: 'identity.group.left',
} as const;

export type AuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent];
