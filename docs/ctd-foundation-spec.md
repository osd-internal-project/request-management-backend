# CTD Foundation Sprint — requirement index

Connect the Dot · Requirement Specification **v1.3** (24 Aug 2026).
Source artifact: `CTD Foundation Sprint.html` (Claude artifact
`2c8d2bf3-2a7a-402f-8439-b3ddcb8db5e8`). This file is the in-repo canonical
index — every requirement code, what it demands, and how it is accepted.

**Delivery status legend:** ✅ implemented *and verified against running code* ·
🟡 scaffolded (route + permission exist, handler pending) · ⬜ not started

> **Re-audited 25 Aug 2026.** The marks below were previously written from
> intent rather than from the code, and four S1 requirements were claimed ✅
> while unimplemented (SCOPE-04, SCOPE-05, AUTH-06, ROLE-03). They have since
> been built and verified. Do not mark a row ✅ without exercising it.

---

## 1. Scope

Foundation every business module (CRM, Sales, Pre-Sales, Pricing, Legal, PM,
Engineer, Delivery, Service, HR, MACOM) calls into. Built **before** the
business modules, because retrofitting a request/approval layer afterwards
means reopening every module already written.

**In scope:** SSO via Keycloak/LDAP · user + org sync · RBAC · row-level data
scope + field masking · multi-company from day one · Platform Request (10
features) · Approval Engine (6 features) · minimum SLA clock · minimum
in-app/email notification · audit log · two pilot request types.

**Out of scope:** the 11 business modules · the full SLA engine (multi-company
calendars, shifts, Data Mart reporting) · the full notification centre ·
central PDPA · e-signature · Odoo/Reserve-phone/D-Callcenter/LLM Gateway ·
Data Lake / Metabase · all AI assistants.

**Pilot types:** ขอส่วนลด (discount) exercises the amount-tiered approval
ladder; ส่งต่อโอกาสการขาย (lead handover) exercises the lightest cross-team
path. Both must fully replace email for those two flows.

> Pricing does not exist yet in this sprint, so margin on a discount request
> is a typed number plus an attachment — not a calculated figure.

---

## 2. Binding agreements (D-codes)

Design must not contradict these without the PO.

| Code | Agreement | Consequence in code |
|---|---|---|
| **D-07** | Keycloak fronts LDAP. LDAP authenticates **only**; roles live in Keycloak. | No password handling of our own. Roles read from token claims. |
| **D-08** | Org chart and supervisors are maintained **in this system**, not synced from LDAP. | `OrgUnit` + `OrgClosure` are our source of truth for scope, step-1 approval, escalation. |
| **D-09** | SLA values are configuration, filled in at go-live. | `SlaConfig` per type per company. Never hardcoded. |
| **D-11** | Multi-company and multi-currency from the start. | `companyId` on every transactional table; approval ceilings carry a currency. |
| **D-02 / D-19** | Document numbers use CE year + month, sequence resets monthly; company prefix configurable per document type. | `DocNumberConfig` + `DocNumberCounter`, e.g. `OSD-DSC-202608-0042`. |
| **D-16** | Internal approval is an in-system click with an audit trail — no e-signature. | Approval Engine is unblocked; no signing dependency. |
| **D-18** | Each company applies its own approval authority. | `ApprovalMatrix` is per company, not one group-wide set. |
| **D-31** | Approval is a **separate central service** from Platform Request. | Own API; callable with no request record (`APV-07`). |
| **D-34** | SLA and notification are separate central services. | Interfaces defined now, minimum implementation only (§9). |

---

## 3. Architecture

```
Browser ──OIDC Authorization Code + PKCE──▶ Keycloak ──▶ LDAP (authn only)
   │  access token (JWT: identity + Keycloak roles)
   ▼
API ──▶ Identity & Org · Policy (RBAC+Scope) · Request · Approval
        · SLA (minimum) · Notification (minimum) · Audit Log
```

**The single most important rule:** authorisation (permission + scope) is
enforced at the **backend, in one place**. Hiding a button or menu in the
frontend is a convenience for the user, never a control.

Services own their own data and call each other over internal APIs. The
frontend is one SPA whose menu is composed from the permissions the backend
returns after login.

**As built:** two deployables. `user-service` = Identity/Org/Policy/Audit;
`core-service` = Request/Approval/SLA/Notification. Each domain is its own Nest
module owning its repositories, so splitting one out later is a move, not a
rewrite. `core-service` resolves callers via `GET /internal/policy/resolve`
rather than reading `user-service` tables.

---

## 4. AUTH — central login (SSO)

| Code | Requirement | Acceptance | Status |
|---|---|---|---|
| **AUTH-01** | OIDC Authorization Code + PKCE against the existing Keycloak. LDAP authenticates only; this system never sees a password. Roles come from Keycloak claims, not LDAP groups. | Login with an LDAP account works; a wrong password is rejected at Keycloak; no password passes through our backend; the token carries roles. | ✅ |
| **AUTH-02** | Short-lived access token (~15 min) + refresh. Idle and max session configured on the realm. | Expired token → 401; refresh renews without the user noticing. | ✅ |
| **AUTH-03** | Logout clears the app session **and** the Keycloak session (single logout). A disabled account loses access within one access-token lifetime. | Old token rejected after logout; disabled test account dead within 15 min. | ✅ |
| **AUTH-04** | JIT-provision the profile on first login from token claims. Org placement and supervisor are maintained here by an admin. Unassigned users land in a "รอจัดสังกัด" queue. | A new LDAP user logs in with no manual account creation; changing their unit changes scope and escalation immediately. | ✅ |
| **AUTH-05** | One user may belong to several companies with one primary; the active company is switchable without re-login. | Switching changes data and permissions at once; single-company users see no switcher. | ✅ |
| **AUTH-06** | Service accounts (client credentials) for system-to-system calls, scoped per client. | A service account may call only its scoped endpoints; anything else is 403. | ✅ enforced by `PolicyGuard` + `@ServiceAccountOnly()`, both directions |
| **AUTH-07** | Record login events: success/failure, time, channel, IP — readable from the admin screen. | Test logins all appear in the log. | ✅ |

**Prerequisite from Infra:** realm/client admin rights on the existing Keycloak,
corporate SMTP settings, and test accounts covering every role.

> **Updated 25 Aug 2026.** The realm is now **`enterprise-request`** with the
> confidential client **`request-form`**, which backs both login and the Admin
> REST API. Two settings had to be corrected before anything worked:
> `redirectUris` was `["/*"]` (relative, so the absolute callback was rejected),
> and the service account held no `realm-management` roles (valid token, 403 on
> every admin call). Open question C is closed for local development; UAT and
> production redirect URIs still need registering.

---

## 5. ROLE — role-based permissions (RBAC)

Authority (*what you may do*) is separate from scope (*what you may see*, §6).
Roles are configuration, never hardcoded.

- **Permission** = `module.action`, e.g. `request.create`, `approval.decide`,
  `admin.role.manage`. Declared in code; admins compose roles from the catalog
  but cannot invent permissions.
- **Role** = a named set of permissions. A user may hold several per company;
  permissions union.
- **Approval authority is not a role** — it is Approval Engine data (D-08). A
  role only decides who can open the approval screen.

### Seed roles (§5.2)

| Role | Who | Core rights |
|---|---|---|
| พนักงาน | everyone, automatically | submit, view/cancel own, receive notifications |
| หัวหน้าทีม | first-line supervisor | see the team's requests, approve step 1 |
| ผู้จัดการฝ่าย | department manager | see the department, approve per matrix, department bottleneck report |
| ผู้บริหาร | director / C-level | see across the company, approve high amounts, all reports |
| ผู้ดูแลระบบ | configuration team | roles, request types, matrix, SLA, audit log — **no approval authority** |
| ผู้ตรวจสอบ | internal audit | read everything including the audit log; read-only, cross-company |

| Code | Requirement | Acceptance | Status |
|---|---|---|---|
| **ROLE-01** | Every endpoint declares its required permission and is checked at the backend. No endpoint is open by default. | Calling without the permission is 403, every time; tests cover every endpoint. | ✅ |
| **ROLE-02** | Admin screen for roles and permissions. A role with holders may be deactivated, never deleted. | A new role can be created and bound with no code change; it takes effect on the next call. | ✅ |
| **ROLE-03** | Map Keycloak role → system role, per company; re-evaluated on every login/refresh. | Revoking in Keycloak revokes here within one token lifetime, with an audit entry. | ✅ realm roles + mappings created by `yarn keycloak:provision`; verified by granting and revoking `team_lead` on a live user |
| **ROLE-04** | Roles are per company; permissions resolve against the active company only. | A manager in company A acting in company B has no manager rights there. | ✅ |
| **ROLE-05** | Every permission change is audited: who, what, to whom, when, before → after. | Five sampled changes answer all of those. | ✅ |
| **ROLE-06** | After login the frontend fetches permissions + scope once and composes the menu from them. | A user without approval rights sees no approval menu and gets 403 if they call it directly. | ✅ |

---

## 6. SCOPE — row visibility and field masking

Two people with identical permissions may legitimately see different rows.

| Level | Meaning |
|---|---|
| `own` | records they raised or are directly involved in |
| `team` | everyone below them in the org chart, all levels |
| `department` | the whole department |
| `company` | everything in the active company |
| `all` | across companies — reserved for group executives and auditors |

| Code | Requirement | Acceptance | Status |
|---|---|---|---|
| **SCOPE-01** | Scope is configured per (role, resource) from the admin screen. | Changing `own` → `team` changes query results with no deploy. | ✅ |
| **SCOPE-02** | Enforced in **one** query filter layer — lists, single reads, and dashboard counts share it. No screen writes its own condition. | Out-of-scope access by URL/API gives 404 or 403; summary numbers always agree with the visible rows. | ✅ |
| **SCOPE-03** | The company boundary is absolute: every query is pinned to the active company except scope `all`. | A company-A user cannot find company-B data by guessing ids; a regression test guards it. | ✅ |
| **SCOPE-04** | Sensitive fields are declared per resource with the permission that reveals them. Masking happens in the **API response**, not just the UI. | Without the permission the field is absent/masked in the response; with it, the real value. | ✅ `SensitiveFieldInterceptor`, registered globally; fields are **deleted**, not nulled |
| **SCOPE-05** | Opening sensitive data is audited (who saw whose, when) — the hook PDPA builds on later. | Viewing a record with sensitive fields produces a log entry. | ✅ emitted by the interceptor when a field is unmasked |
| **SCOPE-06** | Anyone in a record's approval chain can always see it, even outside their normal scope; access ends with the case, except their own history. | A cross-department approver can open what awaits them; unrelated records stay invisible. | ✅ |

> **Technical note (§6.2):** `team`/`department` resolve against a precomputed
> ancestor–descendant closure table, rebuilt whenever an admin edits the org
> chart — not a tree walk per query. This is what lets list endpoints meet
> NFR-02 at 100k rows.

---

## 7. REQ — Platform Request  *(S3)*

One engine for all 30 request types, driven by configuration. Two enabled now.

### State machine (§7.1)

```
draft ──submit──▶ submitted ──▶ pending_approval ──▶ approved ──▶ in_progress ──▶ completed
                      │                  │                            │  ▲
                      │                  └──reject──▶ rejected    hold│  │resume
                      └──return──▶ returned ──resubmit──▶ submitted   ▼  │
                                                                    on_hold

anything before completed ──cancel (with reason)──▶ cancelled
```

The number is issued and the SLA clock starts at **submitted**. The clock pauses
while the request sits `returned` or `on_hold`. Transitions outside this table
must be impossible through every channel, including direct API calls.

> **Amendment (26 Aug 2026):** `on_hold` added — a request parked
> mid-execution waiting on an external factor. Reachable only from
> `in_progress`; leaves by resuming to `in_progress` or by cancel. Not
> editable, not terminal, clock paused. Motivated by the interim Excel request
> logs (`ON_HOLD` status/action), whose backfill must not collapse held work
> into `in_progress`. Implemented in `request-state-machine.ts` + migration
> `20260826040000_request_on_hold`.

| Code | Requirement | Status |
|---|---|---|
| **REQ-01** | Request types are configuration: receiving team, form schema, required documents, approval route, SLA, enabled companies — editable without deploy. A running request keeps the config it was submitted under. | 🟡 |
| **REQ-02** | Number issued at submit, `{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}`, sequence resets monthly, unique under concurrency. | 🟡 |
| **REQ-03** | Required fields and documents block submit, naming what is missing. | 🟡 |
| **REQ-04** | Returns pick from a standard reason list (plus free text) so bounce causes are reportable. | 🟡 |
| **REQ-05** | Cancel by the requester or someone above them, with a reason. Never deleted. | 🟡 |
| **REQ-06** | Requests can reference an originating entity (`ref_type`/`ref_id`) and prefill from it. | 🟡 |
| **REQ-07** | Append-only timeline of every status change: time, actor, before → after. | 🟡 |
| **REQ-08** | One screen for "my requests" and "awaiting my approval" across all types, with filters and due badges. | 🟡 |
| **REQ-09** | Bottleneck report: real time per step by type, approver, period — counting only time the clock ran. | 🟡 |
| **REQ-10** | API for systems to raise requests via a service account; marked as system-sourced. | 🟡 |
| **REQ-11** | Both pilot types configured and running end to end on UAT. | ⬜ |

---

## 8. APV — central Approval Engine  *(S2)*

### Standard route (§8.1, confirmed by PO)

```
Step 1  the requester's team lead   — always, on every request
Step 2  CFO                          — added when the amount exceeds T1
Step 3  CEO                          — added when the amount exceeds T2

amount ≤ T1        : team lead
T1 < amount ≤ T2   : team lead → CFO
amount > T2        : team lead → CFO → CEO
```

T1/T2 are configuration per company and subject type (D-18). **The real numbers
are unconfirmed** — see open question A. A requester with no supervisor in the
org chart cannot submit. Requests with no amount use step 1 only.

| Code | Requirement | Status |
|---|---|---|
| **APV-01** | Central matrix of ceilings and approvers per (company, subject type, amount band + currency), versioned with effective dates. Published versions are immutable. | 🟡 |
| **APV-02** | The chain is computed by the system at submit; the requester cannot choose approvers; nobody approves their own request (team lead escalates to their own supervisor, a named office is skipped). | 🟡 |
| **APV-03** | Temporary delegation with a date window; pending and new work routes to the delegate; history names both people; no sub-delegation. | 🟡 |
| **APV-04** | Batch approval for cases sharing a reference, with per-case results and logs. | 🟡 |
| **APV-05** | A decision is bound to a data snapshot; a material edit voids the approval and forces a new route. | 🟡 |
| **APV-06** | Authority-usage report, exportable, restricted by permission. | 🟡 |
| **APV-07** | Any module may raise an approval case with no Platform Request behind it; the result is published as an event. | 🟡 |

Approval is a click with an audit trail (D-16). The approval screen must show
requester, amount, reason, attachments, and margin (if permitted) before the
decision buttons. Rejection always requires a reason.

---

## 9. SUP — shared minimums

Full SLA and notification services are separate sprints. This sprint builds the
minimum needed for requests and approvals to work, behind interfaces that the
full versions can replace without touching Request or Approval.

| Code | Requirement | Status |
|---|---|---|
| **SUP-01** | SLA clock per request type (configurable). Starts at submit, pauses on return, resumes on resubmit. One holiday calendar per company. | 🟡 |
| **SUP-02** | Overdue escalation to the owner plus one level up, recorded. | 🟡 |
| **SUP-03** | In-app + email (corporate SMTP) for: awaiting approval, returned, decision made, nearing due, overdue. Every send logged. | 🟡 |
| **SUP-04** | One append-only audit log for permissions, request status, approvals, sensitive reads, and admin configuration; searchable by actor, event type, period. No update or delete API exists. | ✅ |

---

## 10. Data model

See [`data-model.md`](./data-model.md). Rules that hold throughout:

- every transactional table carries `companyId` and created/updated audit columns
- **no hard deletes** of transactional data — status columns only
- request form data is JSON against the schema declared in `RequestType`, so a
  new request type needs no migration

## 11. API

See [`api-spec.md`](./api-spec.md) for conventions, and the generated OpenAPI at
`/api/docs` on each service for the live contract. The spec requires OpenAPI
**generated from code**, never hand-maintained alongside it.

---

## 12. Non-functional

| Code | Area | Requirement |
|---|---|---|
| **NFR-01** | Security | Token checked on every request; secrets in env/vault; input validation everywhere; OWASP Top 10 checklist before UAT. |
| **NFR-02** | Performance | Work-queue and approval-inbox screens respond within 2 s at 100,000 requests; scope resolution must not break that. |
| **NFR-03** | Correctness | Number issuing and status changes are transactional — no duplicate numbers, no half-applied states, under concurrency. |
| **NFR-04** | Auditability | Audit log and request timeline are append-only, retained per policy (2 years initially) and searchable throughout. |
| **NFR-05** | Usability | Submit, work-queue, and approval screens work on mobile — most approvers decide from a phone. |
| **NFR-06** | Language | Thai-first UI, structured so another language can be added later (no translation needed yet). |
| **NFR-07** | Environments | Separate dev / UAT / production from sprint one, with CI running tests on every merge. |

---

## 13. Sprint order

Dependency-ordered — RBAC and scope must exist before anything that calls them.

| Sprint | Delivers | Demo at the end |
|---|---|---|
| **S1** — identity foundation | AUTH-01…07 · ROLE-01…06 · SCOPE-01…06 · SUP-04 · project skeleton, CI, environments | Log in with a corporate account, switch company, see a menu built from permissions; admins set roles and scope from a screen; every permission change is traceable. |
| **S2** — approval engine | APV-01…07 · SUP-03 · matrix admin screen | Two companies with different ceilings; a test case runs the full ladder; delegation works; history is complete. |
| **S3** — Platform Request | REQ-01…11 · SUP-01, SUP-02 · bottleneck report | Discount and lead-handover requests run end to end on UAT with real sales users — the phase-1 target. |

**Parallel blockers outside the dev team:** confirmed T1/T2 per company (S2/S3
go-live) · Keycloak realm/client rights (before S1) · someone owning org-chart
data entry (before S3 UAT).

---

## 14. Definition of Done

- every requirement has at least one automated test named for its code, green in CI
- permission tests include negative cases: **every** endpoint exercised with a
  user lacking the permission *and* a user on the wrong company
- OpenAPI generated from code and matching reality; short admin-screen guide
- UAT script passed with at least three real users (sales, manager, admin):
  1. sales submits a discount request with an attachment → team lead is notified → approves from a phone
  2. an incomplete request is returned with reasons → fixed and resubmitted → the SLA clock correctly excludes the returned period
  3. an amount above T2 runs all three steps → the figure is edited after step 1 → the approval voids and re-routes
  4. the CFO goes on leave and delegates → work reaches the delegate → history shows the delegation
  5. a company-A user tries a company-B request by URL → not found
- NFR-02 performance results attached to the sprint report

---

## 15. Open questions

See [`open-questions.md`](./open-questions.md).

---

*Scope was split out of the Connect the Dot project proposal (August 2026) so
foundation work could start before the business modules. All SLA figures,
amounts, and seed roles are proposals to start development against and must be
confirmed with the process owners before go-live (D-09).*
