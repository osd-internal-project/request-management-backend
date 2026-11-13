# System plane (P5–P9)

Who acts above a company, and how a new module gets row visibility for free.
For administrators, in Thai: [`admin-access-guide.md`](./admin-access-guide.md).
Plans: `~/.claude/plans/skill-pstack-crystalline-thacker.md` (parent),
`claude-plans-skill-pstack-crystalline-t-jazzy-patterson.md` (P5–P9).

## Two kinds of role

| | Company role (`Role.level = COMPANY`) | System role (`Role.level = SYSTEM`) |
|---|---|---|
| Held through | `UserRole` (per company) | `SystemUserRole` (no company) |
| Holds | everything except `system.*` | only `system.*` |
| Checked by | `@Permissions` / `@AnyPermission` | `@SystemPermissions` / `@AnySystemPermission` |
| Lands in | `principal.permissions` | `principal.systemPermissions` — never unioned |
| Managed at | `/pages/admin/org` (the company's own roles) | `/pages/system/roles` (templates + system roles) |

A template role is a COMPANY role with `companyId` null: every company may bind it.
`assertPermissionsFitLevel` refuses a role that holds the other level's codes (422).
The first system admin comes from `yarn admin:grant <username>`, which also creates
`system_admin` if it is missing.

## What a person holds in one company

```
(∪ permissions of their roles there) ∪ live GRANT − live REVOKE
```

A `UserPermissionOverride` is live while `revokedAt` is null and `expiresAt` is null or
ahead; nothing sweeps them, expiry is read at resolve time. §5.4 separation of duties is
judged on that combined set when a role is granted and when an override is added.

## Crossing the company boundary

Only two paths, both declared in `AGENTS.md`:

1. `/system/*` routes — read across companies on purpose, gated on `system.*`.
2. System tenant access (P6) — `system.tenant.read` lets a person enter an active
   company they are not a member of. They act with that company's `admin` role;
   `principalFor` adds the company with `via: 'system'`, every guard keeps working,
   `enteredAsSystem(principal)` tells the two apart, and each entry writes
   `system.tenant.entered`.

core-service caches a resolved principal for 60 s, so revoking a role, an override or
tenant access takes up to a minute to reach core.

## Sealed secrets and the keyring (P8)

`sealSecret` writes `v2:<kid>:<iv>.<tag>.<body>` under `CONFIG_SECRET_ACTIVE`;
`openSecret` reads any kid still in `CONFIG_SECRET_KEYS` and the pre-P8 format with
`CONFIG_SECRET_KEY`. With only `CONFIG_SECRET_KEY` set it is kid `k1`. Production refuses
to start without a key.

Rotate: add the new kid, make it active, deploy, run `yarn secrets:reseal` (dry-run) then
`--apply`, rerun until it reports `to reseal 0 · unreadable 0`, then drop the old kid.

## A new module's row visibility

Do not write a `where` by hand. State the owner columns once:

```ts
const where = visibleOwnedWhere(
  subject, // accessSubject(principal)
  { users: ['ownerUserId', 'assigneeUserId'], ownerRelation: 'owner' },
  principal.permissions.includes('mymodule.read.all'),
);
```

That gives the company pin, the people named in those columns (and whoever the viewer
covers through `OrgUnitScope`), and the units the viewer heads or reaches by
`Role.visibilityLevel`; `*.read.all` leaves only the company pin. Add the module's
permissions to `libs/share/src/policy/permissions.ts`; no migration is needed for rights.
