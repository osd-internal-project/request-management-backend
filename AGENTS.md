# request-management backend — working rules

This service implements the **CTD Foundation Sprint** specification. Start at
[`docs/ctd-foundation-spec.md`](./docs/ctd-foundation-spec.md); the requirement
codes it defines (`AUTH-01`, `SCOPE-03`, `REQ-02`, …) are referenced throughout
the code and in test names.

## Working to the plan

Multi-phase work is tracked in two files: the plan (under `~/.claude/plans/`) and
[`../PROGRESS.md`](../PROGRESS.md) at the repo parent. Both are authoritative; memory of
them is not. These rules exist because all four were broken in the same sprint.

- Open the plan file and quote the phase heading before starting that phase. Never work
  from a remembered plan — the file has been rewritten mid-sprint before.
- Work phases in the written order. Reordering or skipping needs saying so first, with the
  reason. Phase 6 was built before Phase 1, and the screens that stalled were exactly the
  ones Phase 1 was supposed to supply.
- A phase is not done while an unchecked `- [ ]` remains under it in `PROGRESS.md`.
- Tick `PROGRESS.md` **before** reporting, not after.
- Report closed/outstanding counts. "Done" without a count is how 9/11 got reported as 11.
- The checklist posted in chat mirrors `PROGRESS.md` item for item — same wording, same order.
  Two different lists is how the chat said 11 while the file still held 9 unchecked boxes.
- Tick `PROGRESS.md` first, then the chat line reporting it. Never the other way round.
- Report each item **as it closes**, in the next message, not batched into the final summary.
  A phase here takes dozens of tool calls; a checklist ticked only at the end leaves the whole
  run invisible, which is exactly the state these rules were written to end.

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

### The one declared exception: `uat_superadmin`

§5.4's separation-of-duties guardrail forbids a role holding both `admin.*` and
`approval.decide` / `request.sensitive.read`. The `uat_superadmin` role breaks
that rule deliberately, so that one UAT account can walk every screen. Stated
here rather than done quietly, as the rules above require.

It is contained rather than excused:

- created **only** by `yarn uat:seed`, which writes Prisma directly and refuses
  to run under `NODE_ENV=production` or without `UAT_SEED_ALLOW=1`
- `assertSeparationOfDuties` is **untouched**. Every API path still enforces
  §5.4, so this role can never be created — or re-saved — from the admin screen.
  Saving it from the Roles page answers 422, which is the intended outcome.
- it must not exist in production. If you find it there, delete the role row;
  nothing else depends on it.

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

`libs/share` is consumed as TypeScript **source** — no build step, no ordering.
See "Build traps" below for the four config pieces that make that work.

## Identity and Keycloak

**The Keycloak admin token never leaves `KeycloakAdminService`.** Nothing else
in the codebase calls `/admin/realms/…`, and no endpoint returns that token.

**Every identity write is audited** (SUP-04) — `identity.*` events, through the
existing `AuditService`.

**Escalation is refused, not discouraged.** `admin.identity.manage` administers
*this system's* identities. It must never become a route to administering
Keycloak: the assign endpoints reject `realm-management` roles and
`realm-admin` outright. Without that guard an application admin could promote
themselves to full Keycloak administrator in a realm shared with other
projects.

**Keycloak roles grant nothing until they are mapped.** `yarn keycloak:provision`
creates the realm roles and seeds `keycloak_role_mappings`; a fresh environment
that skips it has every user resolving to no roles at all.

**The org tree lives in this database** (D-08), not in Keycloak groups. It is
the source of truth for supervisors, which drives data scope, approval step 1,
and escalation — none of which a Keycloak group can express.

## หน้าจอ: อ่าน §16 ก่อนเขียนเสมอ

**ทุกหน้าจอต้องอ้าง `docs/ctd-foundation-spec.md` §16** ซึ่งระบุเมนู คอลัมน์
ตาราง ป้ายสถานะ และข้อความจริงของทั้ง 8 หน้า อย่าออกแบบหน้าจอจาก requirement
text — §16 มีของจริงอยู่แล้ว

**ตรวจความครบของเอกสารด้วยการนับหัวข้อ ไม่ใช่ไล่รหัส** — สารบัญต้นฉบับมี 16
หัวข้อ `grep -c '^## ' docs/ctd-foundation-spec.md` ต้องได้ 16 การ audit ที่ไล่
เฉพาะรหัส requirement มองไม่เห็น §16 เพราะ mockup ไม่มีรหัส และนั่นคือเหตุผลที่
มันหายไปโดยไม่มีใครจับได้หลายรอบ

**ไฟล์ artifact ที่แนบมาคือเปลือก** เนื้อหาจริงอยู่ใน
`<artifact>_files/saved_resource.html` อ่านเปลือกจะได้แต่ CSS กับ script

## Approval Engine (S2)

**Never reimplement the chain rules.** `approval-chain.ts` encodes §8.1 —
including the rule that nobody approves their own request. `matrix-rules.ts`
validates a ladder before publish. Both are unit-tested; a second copy of
either will drift.

**Routing is proved possible before a submit writes anything.** The chain is
resolved across a service boundary and cannot join the request's transaction,
so `submit` calls `assertRoutable` *first*. Without it, a submit that fails at
routing leaves a request that consumed a document number, moved to `submitted`
and started its clock, yet sits in nobody's queue and refuses to be submitted
again — invisible to the requester and non-existent to every approver. This
was a real defect, found by raising a type that had no published matrix.

**A published matrix version is immutable.** There is no update route. Editing
means publishing version N+1, which is what lets a case in flight keep the
ceilings it was routed under.

**A delegation is resolved at decision time, not at submit.** That is what makes
work *already sitting* in a queue re-route to whoever is covering. The history
keeps both names: `approverUserId` is who the chain named, `decidedByUserId` is
who acted.

**Batch decisions are one transaction each.** An approver acting on twenty
cases must not lose nineteen good decisions because the twentieth was already
decided.

**A service account has no `User` row.** Use `auditActor(principal)` for audit
entries — writing its Keycloak subject to `actorId` violates a foreign key and
fails the whole transaction.

**Masking is registered in both services.** `SensitiveFieldInterceptor` runs in
core-service as well as user-service, and masks nested containers (`payload`,
`form_data`) — a sensitive field is almost never at the top level.

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
`curl localhost:3002/api/v1/health` must report `"database":"up"` — user-service's
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

**S1 is implemented and re-audited against the code (25 Aug 2026)** — AUTH,
ROLE, SCOPE, SUP-04, including the four requirements that were previously
claimed done but were not: SCOPE-04 masking, SCOPE-05 read auditing, AUTH-06
service-account scoping, and ROLE-03 role mapping. **S2 (Approval Engine) is delivered
and verified live** — APV-01…05 and APV-07 complete, SUP-03 in-app complete
(email blocked on SMTP). **S3 is scaffolded**:
routes and permissions are declared and appear in the OpenAPI, but handlers
throw `501` naming their requirement. The domain rules most at risk of drifting
are already written and unit-tested:

- `services/core-service/src/requests/request-state-machine.ts` (§7.1)
- `services/core-service/src/approvals/approval-chain.ts` (§8.1)
