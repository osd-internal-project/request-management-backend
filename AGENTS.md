# request-management backend — working rules

This service implements the **CTD Foundation Sprint** specification. Start at
[`docs/ctd-foundation-spec.md`](./docs/ctd-foundation-spec.md); the requirement
codes it defines (`AUTH-01`, `SCOPE-03`, `REQ-02`, …) are referenced throughout
the code and in test names.

## Working to the plan

**The plan lives under `~/.claude/plans/`.** It is authoritative; memory of it is not.

There is deliberately **no progress file**. What was built is established by running
`yarn spec:check`, which reports every difference between the source specification and
this repository and writes [`docs/spec-coverage.md`](./docs/spec-coverage.md). A
hand-maintained checklist is a claim; generated output is evidence.

How to work a plan and report a checklist is in `~/.claude/AGENTS.md` and is not
restated here. What is recorded here is why those rules exist, because every one of
them was broken in this repo in a single sprint:

- The plan file was rewritten mid-sprint, so a remembered plan was a stale plan.
- Phase 6 was built before Phase 1 — and the screens that stalled were exactly the ones
  Phase 1 was supposed to supply.
- "Done" without a count is how 9 of 11 items got reported as 11.
- Every closing report ends with two headed sections — **งานต่อไป** (the next phase's steps)
  and **ที่เหลือ** (a table of every later phase and open item, with who acts) — never a
  one-line "next is Phase N" (user corrected this repeatedly, 22 Oct 2026).
- A screen check that only looked for a marker comment passed A1, A2 and A4 while all
  three were half-built. Check content, not the presence of a label.

## Resolving conflicts and verifying a change

These apply when the code is written or merged — not at deploy. Whoever pushes
later has nothing left to catch.

**Never resolve a conflict by taking one side whole.** For each hunk, state what
each side meant and show the result keeps both. Before committing the merge,
read every hunk of `git show --remerge-diff HEAD`. Merge `9529814` took the
CD-67 side of `listTypes` whole and silently undid `f6fc83d`'s fix; six screens
answered 500 on labs.

**`tsc` and `yarn test` passing proves little about queries.** Unit tests mock
Prisma, and Prisma's types accept inputs its engine rejects at runtime — that
merge passed 954/954. Before calling a change done:

1. List every caller of each function you changed, the endpoints above them,
   and the frontend pages that call those endpoints.
2. Run `make smoke` — every core-service GET against a throwaway Docker
   database (never the one in `.env`). A 5xx on any route fails it, including
   routes your task never touched.
3. `prisma-order-by.spec.ts` guards one known runtime-only trap. When you meet
   another, add a guard like it rather than a note.

**Keep the diff to the task.** `git diff --stat` must list only files the task
needs. Anything else is named, with the reason, before the commit — not found
afterwards.

**A gap in `source/` is reported, never filled.** The petty-cash fund and top-ups were invented from
general accounting and shipped as if specified. Label every requirement `source` or `proposed` before
asking or building on it.

**A seed that publishes configuration checks what is there first.** `disbursement-flow:seed`
published FI05 flow v2 over an existing v1 nobody had mentioned. List the current versions, show
them, and ask before publishing over one.

**A module fed by a request starts after the request is approved.** The request owns asking and
every approval. The module's record is created on `request.approved` and linked by `requestId`; its
work (pay, clear, close) is never added as steps of the request. Disbursement v1 got this backwards.

**A plan for a request-linked module states the system, not the user's words.** Before proposing,
audit the gaps: rights, visibility, money, timers, notifications, external/MCP, live data, and the
dynamic form (read `formData` through `x-bind`, never fixed keys). Then show a "now → new" table.

**Never run `prisma format` on `schema.prisma`.** It realigns every model in the
file (a 160-line addition became 773 changed lines). Format only the block you add.

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

**Adding a company? Re-run `yarn uat:seed`.** The role, the `UserRole` grant and
the `UserCompany` membership are all per company (ROLE-04), and `uat:seed` writes
them for the companies that exist *at the moment it runs*. A company created
afterwards is invisible to the UAT account — it will not appear in the company
switcher, because that list is the user's memberships and nothing else. This is
how `OSD` went missing on 28 Aug 2026 after `OSD_DEMO` was split out of it.

Deliberately left as a re-run rather than made automatic: memberships stay real
rows that an audit can read, instead of a special case in `PrincipalService`
that hands one account a company list it has no roles in.

## Where things go

| Concern | Location |
|---|---|
| Shared guards, error catalog, pagination, scope maths | `libs/share/src/` |
| The permission catalog (declared in code) | `libs/share/src/policy/permissions.ts` |
| One Prisma schema for every service | `libs/prisma/schema.prisma` |
| Identity, org, roles, policy, audit | `services/user-service/src/` |
| Request, approval, SLA, notification, CRM | `services/core-service/src/` |
| The outward-facing API (machines, MCP) | `services/external-service/src/` |
| เลขรันทุกชนิดเอกสาร (`run_number_*` เป็นของที่นี่เท่านั้น) | `services/run-number-service/src/` |
| What external-service may import from core | `services/core-service/src/index.ts` |
| Design reasoning too long for a comment | `docs/<topic>.md`, one file per topic |

Data access goes through repositories extending `BaseRepository`, provided by
the feature module that owns them — never `PrismaService` directly from a
service class.

**Every domain module is split in two.** `requests.module.ts` holds providers
and exports; `requests-http.module.ts` holds the controllers and imports the
first. core-service imports the `-http` half; external-service imports only the
domain half, because Nest registers the controllers of everything it imports
transitively and the screens' routes must never answer on the external port.
`services/core-service/src/index.ts` is the one place that decides what crosses
the boundary — the reasoning is here, not in a comment there.

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

**Keycloak is login only — its roles grant nothing.** Declared deviation from
ROLE-03 (user decision, 29 Sep 2026): the realm moved to the shared `OSD` realm on
id24, where role names belong to other projects too. People get roles only from
`MANUAL` grants on screen A3; machines only from their API key's `scopes`.
`PrincipalService` never reads token roles into permissions, and the
`keycloak_role_mappings` screen is kept but has no effect. user-service sees a
key's scopes through the `x-api-key-scopes` header core forwards on
`resolve-by-email`, honoured only on the integration client's own token.
`route-policy.spec.ts` fails for any user-service route with no access policy.

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

## The request lifecycle is a ticket, and that is an amendment

**A request is handed to a named person, accepted, worked on — possibly broken
into further requests — and only then checked and closed by whoever asked.**
`request-state-machine.ts` is the authority for the transitions. The reasoning
and the list of what to remove if the PO declines are the four points below.

Four things in it are **not** in the source specification, and none of them may
be justified by citing §7.1 or §8.1:

1. **Approval runs after the work, not before it.** §7.1 sequences
   `pending_approval → approved → in_progress` — permission to start. The
   departments' own logs do the opposite, and eighteen of OSD's forty request
   types carry no approval step at all.
2. **`on_hold` and `closed`** exist so the interim Excel logs' eleven statuses
   survive the import.
3. **A type with no approval matrix skips the check entirely.** The absence of a
   matrix is configuration, not a gap — `selectTier` throwing
   `APV_MATRIX_NOT_FOUND` is the wrong answer for those types, which is why
   `complete` asks `hasPublishedMatrix` first.
4. **A type may publish a step flow** (PO, 28 Sep 2026). Steps live inside
   `in_progress`; `advance` moves between them, and a step with an exit ladder
   (`request:<CODE>:step:<STEP>`) waits in `pending_approval`, which is why
   `in_progress → pending_approval` exists. A request with no `flowVersionId`
   runs the fixed lifecycle unchanged. Core owns the flow; a workflow engine
   reacts to its events and acts through the external API, never the reverse.
   The engine is `request-flow.ts`; removing the feature is dropping those
   tables and the `advance` row.

   **Flow v2** (`schemaVersion = 2`, PO 28 Sep 2026) widens this: steps cover
   the whole path, each under a status scope (`draft`, `returned`, `submitted`,
   `in_progress`, `pending_approval`, `approved`). The request's status is the
   current step's scope, the holder follows from it, and a cross-scope exit
   must pass `canTransition` — so the table above stays the authority. Approval
   steps carry their own levels (no matrix), submitting is leaving the draft
   step, leaving the last step closes, and the SLA runs through every step
   after first receipt (D7), so v2 SLA figures include approval time. Engine:
   `request-flow-v2.ts`; v1 flows and flowless types are untouched.

`yarn spec:check` still passes over all of this. It compares the on-screen text
against §16 and **does not read the transition table** — never cite it as
evidence that this design matches the specification.

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

**A test or UAT script is written from the module's doc, checked against the code.** Every action needs
who · accepted status/step · permission · who is refused · resulting status · whether the ticket moves ·
error code; a gap the code reveals goes into the doc first (disbursement UAT, 7 Oct 2026).

**UAT runs on the real people's real roles — never a role made for the test.** A permission the
real role lacks is a finding to report and fix in that role (seed or admin screen), not to bypass:
a stand-in `DISBURSEMENT_UAT` role hid that no seeded role held `disbursement.*` (7 Oct 2026).

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
   `permissions` table syncs from that catalog at boot, and that is now the
   only place a permission has to be declared. An `integration.*` permission
   becomes tickable on the API-key screen the moment it is in the catalog:
   `ISSUABLE_SCOPES` derives from `permissionType`, and a key's `scopes` are
   what the caller may do (`RemotePrincipalGuard.permissionsOfKey`). There is
   no realm role to create — Keycloak authenticates the machine and grants it
   nothing.
2. Filter every read through `buildScopeWhere`.
3. If it changes state, make it transactional and accept `Idempotency-Key`.
4. Write the audit entry inside the same transaction as the change.
5. Add a test named for the requirement code, plus a negative case for a user
   without the permission and a user on the wrong company. The DoD requires
   both.

### On external-service: two gates, not one

An endpoint on the external port declares **both**:

```ts
@Permissions('integration.crm.customer.manage')   // may this machine call it
@ServiceAccountOnly()
@ActingPermissions('crm.customer.manage')         // may this person do it
@UseGuards(ActingUserGuard, ActingPolicyGuard)
```

`PolicyGuard` is global, so it runs before any route guard and always judges
the credential that arrived — the service account. The acting-user swap happens
afterwards, deliberately: swapping earlier would test the human against the
integration's gate, and anyone holding `request.create` would be let through a
door meant only for the robot. `auth/acting-user.guard.ts` is where the order is
implemented; this is where it is explained.

The consequence is that **after the swap, nothing checks the human unless you
say so.** The request API survived that because `RequestsService` re-checks with
`assertMayAct`; CRM declares `crm.*` on its controllers and nowhere else, so
exposing it without the second gate would let an integration act as somebody
who lacks the permission. `@ActingPermissions` must name exactly what the
equivalent screen route names — `crm-route-parity.spec.ts` fails if it does not.

Four routes carry no acting user: `request/intake`, `crm/leads/intake` (plus
`crm/leads/:id/facts|stage`), `approval/cases`, and — since CD-66 —
`request/intake/web-forms|channels|status` (customers raising requests through
a company's intake channel, under their own scope `integration.request.intake`,
which cannot reach an `X-Acting-User` route). The LINE webhook
`request/intake/line/:companyCode` is the one `@Public()` business route on
this service: LINE cannot carry our key, so LINE's signature over the raw body
is checked instead (docs/customer-intake.md). There is nobody at the other
end of those — a customer's web form, a workflow engine, another module. Adding
a fifth is a decision to state out loud here, not a default and not a paragraph
in the controller.

**The fifth: `smart/prospects/ingest` (CD-289, 6 Oct 2026, user decision).** A
licensed crawler or data vendor pushes businesses it found into AI SMART's
staging list, under its own scope `integration.smart.ingest`. Nobody at the
other end is a user, and nothing it sends reaches CRM — rows wait in
`smart_prospects` for screening (CD-290). It writes only to a source the
company set up as kind `push`. A sixth is again a decision to state here.

**The sixth: AI channels that talk to customers — `kb/ai/*` (CD-265, 5 Oct
2026) and `care/*` (CD-280, 6 Oct 2026, user decision).** A channel connector
(LINE, Facebook, Instagram, TikTok, email, web chat, D-Callcenter) or AI CARE
itself posts what a customer wrote and what was answered, under
`integration.care.manage`; AI CARE and AI SMART read customer-facing articles
under `integration.kb.read`. The person at the other end is a customer, never
one of our users. `kb/ai` returns only articles published to customers (all,
or the one named). `care` returns a customer's name, assets and coverage only
once the sender is *verified* — the platform's own identity (LINE id, email
sender, caller number) matched one contact, or the service team confirmed it;
what a sender types only *claims* a customer. A seventh is again a decision to
state here.

**The seventh: `smart/calls/callback` (CD-292, 7 Oct 2026, user decision).**
D-Callcenter, the company's own call centre, reports how an AI SMART call ended
(outcome, transcript, recording reference) under `integration.smart.callcenter`.
The person at the other end of the call is a prospect, never one of our users,
and the caller is a machine. The key's company is the call's company; another
company's call id answers 404, and a finished call is not re-recorded. A
`refused` outcome puts the number on the do-not-contact register at once. An
eighth is again a decision to state here.

**The eighth: `process/logs` and `process/refs` (21 Oct 2026, user decision).**
OSD Workflow runs the seven-stage End-to-End process (`ctd-flow-s1…`) under
`integration.process.log`. `logs` appends one `process_flow_logs` row per step;
`refs` reads one deal's document numbers, states and CTD screen links (lead →
OPP → SOL → QT → SO → contract → PRJ → acceptance) so tasks link to the screen
and nobody retypes a number — no amounts, no contacts, the key's company only.
The caller is the engine; whoever completed a human task travels as
`actor_email`, recorded, never authenticated. A ninth is again a decision to
state here.

**The ninth: `crm/ai/leads/*` (22 Oct 2026, user decision).** An AI agent works
leads for the company, not for a person, so there is no person's scope to borrow.
Its rows are every lead of the key's company: `integration.crm.lead.read` sets
`readsAllLeads` in `visibleLeadsWhere` (leads only, the workflow engine's key too),
and these routes refuse a key bound to no company. Only the machine's own
principal reads all: a person it acts for through `X-Acting-User` or MCP keeps
their own rows, even with the scope in their list — `mcp-scope.e2e-spec.ts`
caught that leak on 22 Oct 2026. Its abilities are one scope per
use case — `lead.update` (detail + intake data), `lead.convert` (the deal goes to the
lead's owner; a pool lead answers 409), `lead.contact.read` (email/phone, never in a
webhook payload). Create and status stay on `crm/leads/intake` and `:id/stage`. A
tenth is again a decision to state here.

**core-service's one public business surface: e-signature (CD-14, 30 Sep
2026).** `EsignPublicController` — `esign/public/:token/*` (a signer's link:
view, one-time code, document, sign, decline) and `esign/verify/:code*` (the
verification page) — is `@Public()` on **core-service**, not on
external-service. The link's secret (only its SHA-256 is stored) plus the
one-time code are the credential; the verification page shows only what the
signed paper already prints. It stays on core-service because the signed PDFs
live in core's object storage, which external-service does not configure (and
under `STORAGE_MODE=memory` the two processes could not even share a file).
The web app reaches these from its own server routes (`/api/public/esign/*`),
which rate-limit by address, as the CD-66 intake form does. A second public
core-service route is a decision to state here, like the list above.

**The second: the customer's service survey (CD-248, 5 Oct 2026, user
decision).** `ServiceSurveysPublicController` — `GET/POST
service-surveys/public/:token` (read the job's name and answer once) — is
`@Public()` on core-service on the e-sign pattern: the link's secret is the
credential, only its SHA-256 is stored, it expires (14 days) and takes one
answer. It shows the job's number, subject and done date, nothing else. The
web app reaches it from `/api/public/survey/*`, rate-limited by address. A
third is again a decision to state here.

**The third: the Customer Portal (CD-249, 5 Oct 2026, user decision).**
`ServicePortalPublicController` — `service-portal/public/*` — is `@Public()` on
core-service. No password exists anywhere: the service team invites a person
at a customer, and that private invite link (only its SHA-256 stored, 90 days,
revoked or reissued at will) opens an 8-hour session whose token (also stored
only as a hash) the web app keeps in an httpOnly cookie and passes as
`x-portal-session` from its server routes (`/api/public/portal/*`,
rate-limited by address). Every read is pinned to the session's customer: its
installed assets, covers, service jobs (plain status words), service
reports already sent to it, and knowledge articles published to customers
(all, or that customer) through `KbPortalService` (CD-261); a case it raises is a service job under the
company's configured portal user, as a CD-66 channel's requester is. A
fourth is a decision to state here.

**An MCP tool answers only what the asker's screens would (CD-277).** Every
tool runs as the person — their own token, or `X-Acting-User` — through the
screen's own service, so SCOPE-02's rows, SCOPE-03's 404 and SCOPE-04's masking
come with it. A tool never reads `mart.*`, the lake or a Metabase embed: those
carry no per-person rows. `mcp-permission-gates.spec.ts` holds every catalogue
tool to its gate and to calling as that person (and scans for mart access);
`test/mcp-scope.e2e-spec.ts`, run by `make smoke`, seeds two companies and
fails if any read tool's answer carries the other company's or a colleague's
rows. A new tool needs no new test — both read the generated catalogue.

**Every MCP tool call is logged (CD-279), and the log is the one place rows
are deleted by policy.** `McpService` writes `mcp_calls` (person, tool, a
read's filters or a write's field names, the answer's row ids and count —
never values); `LlmService` writes `llm_calls`. Both are kept for the
company's `ai_audit_policies.retentionDays` (default 365) and the daily
sweep in `AiAuditService` deletes older rows — a declared exception to "no
hard deletes": these are access logs, and keeping them only as long as the
policy says is what the policy is for. `audit_logs` stays append-only.
`integration_calls` (22 Oct 2026) is the same exception: `IntegrationCallMiddleware`
writes one row per external-service request (route template, mode, status — never
body or headers) and the same sweep deletes it on the same retention.

`crm/leads/intake` earned its suffix on 21 Sep 2026: it used to be `POST
crm/leads`, which `ExternalLeadsController.create` also bound. That controller
registers first, so the intake route was unreachable and every web form calling
it got `400 ต้องระบุ header x-acting-user`. Two handlers on one METHOD+path is
always that bug — `yarn openapi` now warns when it sees one.

`POST requests/:ref/actions/:action` is the other exception: one route, fourteen
verbs, a different permission each, so the check reads `ACTION_PERMISSIONS` in
`available-actions.ts` inside `perform` instead of a decorator.

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
(email blocked on SMTP). **S3 (CRM) is implemented, not scaffolded** — customers,
leads, opportunities, quotations and sale orders all resolve to real service
methods with Prisma writes, audit rows, timeline events and unit tests.
`grep -rn NotImplementedException services/ libs/` returns nothing;
`services/core-service/src/common/not-implemented.ts` is declared and imported
nowhere. The lifecycle and what is genuinely still absent are in
[`docs/crm-flow.md`](./docs/crm-flow.md).

The domain rules most at risk of drifting are written and unit-tested:

- `services/core-service/src/requests/request-state-machine.ts` (§7.1)
- `services/core-service/src/approvals/approval-chain.ts` (§8.1)
- `services/core-service/src/crm/customer-state-machine.ts` (CM-04)
- `services/core-service/src/crm/quotation-math.ts` (CD-76)
