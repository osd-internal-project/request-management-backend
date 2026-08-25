/**
 * The complete permission catalog, declared in code.
 *
 * §11.3 exposes this read-only at `GET /admin/permissions`: admins compose
 * roles out of these, but cannot invent new ones from the UI — a permission
 * only exists once an endpoint declares it with `@Permissions()`.
 *
 * Naming is `<module>.<action>`, with `.own` / `.any` suffixes where the same
 * action differs by whose record it touches.
 */
export const PERMISSIONS = {
  request: [
    'request.create',
    'request.read',
    'request.cancel.own',
    'request.cancel.any',
    'request.complete',
    'request.return',
    /** SCOPE-04: unmasks margin, discount, and other flagged fields. */
    'request.sensitive.read',
  ],
  approval: ['approval.decide', 'approval.delegate', 'approval.history.read'],
  report: ['report.request.read'],
  user: ['user.read'],
  notification: ['notification.read'],
  audit: ['audit.read'],
  admin: [
    'admin.role.manage',
    'admin.org.manage',
    'admin.request-type.manage',
    'admin.approval-matrix.manage',
    'admin.sla.manage',
    /**
     * Read and write Keycloak users, realm roles, and groups. Deliberately
     * separate from `admin.role.manage`: this reaches outside our database
     * into the shared corporate realm.
     */
    'admin.identity.manage',
  ],
  /** AUTH-06: service-account scopes, never granted to a human role. */
  integration: ['integration.request.create', 'integration.approval.create'],
} as const;

export type PermissionModule = keyof typeof PERMISSIONS;

export type Permission = (typeof PERMISSIONS)[PermissionModule][number];

/** Flat list, in catalog order — what `GET /admin/permissions` returns. */
export const ALL_PERMISSIONS: readonly Permission[] =
  Object.values(PERMISSIONS).flat();

const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** The module a permission belongs to, for grouping in the admin UI. */
export function permissionModule(permission: Permission): PermissionModule {
  const found = (Object.keys(PERMISSIONS) as PermissionModule[]).find((key) =>
    (PERMISSIONS[key] as readonly string[]).includes(permission),
  );

  // Unreachable for a valid Permission; the type guard above is the gate.
  return found ?? 'request';
}
