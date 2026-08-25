# request-management backend — working rules

This service implements the **CTD Foundation Sprint** specification. Start at
[`docs/ctd-foundation-spec.md`](./docs/ctd-foundation-spec.md); the requirement
codes it defines (`AUTH-01`, `SCOPE-03`, `REQ-02`, …) are referenced throughout
the code and in test names.

## Non-negotiables

These come from the spec, not from taste. Breaking one is a spec violation, so
say so explicitly in the PR rather than doing it quietly.

1. **Authorisation is enforced at the backend, in one place.** `PolicyGuard` is
   global and deny-by-default: an endpoint declaring neither `@Permissions()`,
   `@Authenticated()`, nor `@Public()` is rejected. Hiding a control in the
   frontend is convenience, never control. (ROLE-01)

2. **Row visibility goes through one filter.** Lists, single reads, and
   dashboard counts all build their `where` with `buildScopeWhere`. A screen
   that writes its own visibility condition is how a summary number and the
   rows behind it start disagreeing. (SCOPE-02)

3. **The company boundary is absolute.** Every query is pinned to the active
   company except scope `all`. Out-of-scope reads answer **404, not 403** — the
   spec does not want existence disclosed. (SCOPE-03)

4. **No hard deletes of transactional data.** Status columns and soft-delete
   timestamps. A cancelled request stays findable, with its reason.

5. **The audit log is append-only.** No update path, no delete path, no route
   that reaches one. (SUP-04)

6. **Configuration over code.** Request types, the approval matrix, SLA values,
   scope rules, and masking rules are all editable from admin screens without a
   deploy. Adding the 3rd..30th request type must not require a migration or a
   code change. (REQ-01, APV-01, D-09, SCOPE-01)

7. **Running work keeps the rules it started under.** A request holds its
   `typeSnapshot`; an approval case holds its matrix version. Editing
   configuration must never reroute or re-judge something already in flight.

8. **Keycloak is a backend concern.** Only the backend holds realm and client
   configuration. There is no code path anywhere that accepts a password.

## Where things go

| Concern | Location |
|---|---|
| Shared guards, error catalog, pagination, scope maths | `libs/share/src/` |
| The permission catalog (declared in code) | `libs/share/src/policy/permissions.ts` |
| One Prisma schema for every service | `libs/prisma/schema.prisma` |
| Identity, org, roles, policy, audit | `services/user-service/src/` |
| Request, approval, SLA, notification | `services/core-service/src/` |

Data access goes through repositories extending `BaseRepository`, provided by
the feature module that owns them — never `PrismaService` directly from a
service class.

`libs/share` is consumed as built `dist`, so it compiles first. `make` encodes
that ordering; don't bypass it.

## Build traps (each of these has bitten once)

**yarn only — never npm.** `yarn.lock` is the lockfile and `packageManager` is
pinned to `yarn@1.22.19`. Mixing package managers is what broke the tree on
24 Aug 2026: an install with the other tool rewrites `node_modules` into a
different layout and leaves it half-broken — missing
`@nestjs/cli/node_modules/glob`, missing webpack internals, `nest start` dead.
Recovery is `rm -rf node_modules && yarn install`. If a stray
`package-lock.json` appears, delete it rather than keeping both.

**`libs/share` is consumed as SOURCE, not a built `dist`.** Its `package.json`
points `main`/`types` at `src/index.ts`; there is no build step and no ordering
requirement. This is what makes `cd services/<name> && yarn start:dev` work on a
cold clone. Three pieces hold it together — change one and you must change all:

- each service's `tsconfig.json` maps the package via `paths` and lists
  `../../libs/share/src/**/*` in `include`
- each service's `tsconfig.build.json` sets `rootDir: "../.."`, because TS
  refuses to compile files outside `rootDir` (`TS6059`)
- `webpack.config.js` aliases the package to `libs/share/src`, and each service's
  jest config maps it the same way so ts-jest transforms the source

**Prisma must stay external to the webpack bundle.** The services build with
`"webpack": true`, which would otherwise inline the Prisma client — and its
generated client loads a native query engine by resolving paths relative to its
own place in `node_modules/.prisma/client`. Inlined, those paths vanish and
every query fails at runtime with *"could not locate the Query Engine"* while
the service still reports a healthy start. The same `webpack.config.js` marks
Prisma external. Don't remove that.

Quickest check that the database is genuinely wired up:
`curl localhost:3002/api/health` must report `"database":"up"` — user-service's
health endpoint is static and will say `ok` either way. That distinction is how
the Prisma failure went unnoticed.

## Adding an endpoint

1. Declare its permission with `@Permissions('module.action')`. If the
   permission is new, add it to the catalog in `libs/share` first — the
   `permissions` table syncs from that catalog at boot.
2. Filter every read through `buildScopeWhere`.
3. If it changes state, make it transactional and accept `Idempotency-Key`.
4. Write the audit entry inside the same transaction as the change.
5. Add a test named for the requirement code, plus a negative case for a user
   without the permission and a user on the wrong company. The DoD requires
   both.

## Errors

One shape everywhere: `{ code, message, details }`. Throw `AppError` with a code
from `ErrorCatalog`; codes are part of the API contract and clients branch on
them. Messages are Thai and may be reworded, so never make behaviour depend on
message text.

## Current state

**S1 is implemented** (AUTH, ROLE, SCOPE, SUP-04). **S2 and S3 are scaffolded**:
routes and permissions are declared and appear in the OpenAPI, but handlers
throw `501` naming their requirement. The domain rules most at risk of drifting
are already written and unit-tested:

- `services/core-service/src/requests/request-state-machine.ts` (§7.1)
- `services/core-service/src/approvals/approval-chain.ts` (§8.1)
