# CTD Foundation Sprint — requirement index

Connect the Dot · Requirement Specification **v1.5** (25 Aug 2026).
v1.5 adds §5.4 (the seed permission matrix per role) and screen **A4**.

**แหล่งที่มา:** `docs/source/CTD Foundation Sprint_files/saved_resource.html` —
เนื้อหาจริงของ artifact ไฟล์ `docs/source/CTD Foundation Sprint.html` คือ
**เปลือก** (artifact shell) ที่มีแต่ `<iframe>` ชี้ไปยังไฟล์ข้างบน อ่านเปลือก
จะได้แต่ CSS กับ script ไม่ได้เนื้อหา — แปลงเป็น text แล้วได้ 6 บรรทัด และ
`grep "หน้าที่"` ได้ 0

> **อย่าอ่านต้นฉบับด้วยตาเปล่า — ใช้คำสั่ง**
>
>     yarn spec:extract   # เปลือก → docs/source/spec.txt (fail ถ้าได้ < 500 บรรทัด)
>     yarn spec:check     # เทียบหัวข้อ · รหัสข้อกำหนด · §10/§11 · เนื้อหาหน้าจอ §16
>
> สคริปต์นี้มีเพราะการ "ตรวจเอกสารแล้ว" สามรอบติดกันรายงานว่าครบ ทั้งที่ §5.4
> และหน้า A4 หายไปทั้งหัวข้อ · คำบรรยายตรวจสอบไม่ได้ output ตรวจสอบได้
> **ขอ output ของ `yarn spec:check` แทนคำว่า "ตรวจแล้ว"**

ไฟล์นี้คือดัชนีหลักใน repo ครอบคลุม **ทั้งข้อกำหนด (requirement code) และ
หน้าจอ (§16)** — การตรวจความครบถ้วนด้วยการไล่เฉพาะรหัส `AUTH-*`/`REQ-*` มองไม่
เห็น §16 เพราะ mockup ไม่มีรหัส

**Delivery status legend:** ✅ implemented *and verified against running code* ·
🟡 scaffolded (route + permission exist, handler pending) · ⬜ not started

> **S3 core delivered 26 Aug 2026** — a request now runs submit → number →
> chain → approve → close entirely in the database. Verified by querying
> `requests`, `approval_cases`, `approval_steps`, `sla_clocks` and
> `request_events`, not by a screen rendering. Still open in S3: REQ-06,
> REQ-09, REQ-10, SUP-02, and attachment upload (needs the storage backend of
> open question G).
>
> **S2 delivered 25 Aug 2026** — the Approval Engine is implemented and
> verified against a running system, driven through APV-07. Two items remain
> partial and are marked 🟡 rather than ✅: SUP-03's email half cannot be
> verified without SMTP, and APV-06 has no export yet.
>
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
| ทีมผู้รับคำขอ (Receiver) | the destination team, e.g. Pricing for discount requests | see their team's queue, return with a reason, **complete work**, read sensitive fields of the types their team receives |
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

### §5.4 Seed permissions per role, and how to change them

The permission catalog is declared in code (`GET /admin/permissions`). This
table is the **seed** that must ship with the system; admins add and remove
from the screen without a deploy.

`✓*` means *granted, but a positional check still applies on top* — a team lead
holds `request.return`, yet may only return a request that is actually waiting
on them.

| Permission | พนักงาน | หัวหน้าทีม | ทีมผู้รับ | ผู้จัดการฝ่าย | ผู้บริหาร | Admin | Auditor |
|---|---|---|---|---|---|---|---|
| `request.create` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `request.read` (+scope) | ✓ own | ✓ team | ✓ own queue | ✓ department | ✓ company | ✓ company | ✓ all |
| `request.cancel.own` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `request.cancel.any` | — | — | — | ✓ | ✓ | — | — |
| `request.return` | — | ✓* | ✓* | ✓* | ✓* | — | — |
| `request.complete` | — | — | ✓* | — | — | — | — |
| `request.sensitive.read` | — (own entries only) | ✓* | ✓ types their team receives | ✓* | ✓ | — | ✓ |
| `approval.decide` | — | ✓* | — | ✓* | ✓* | — | — |
| `approval.history.read` | — | — | — | — | ✓ | — | ✓ |
| `report.request.read` | — | ✓ team | ✓ team | ✓ department | ✓ company | — | ✓ |
| `user.read` | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `admin.*` (org · role · request-type · approval-matrix · sla) | — | — | — | — | — | ✓ | — |
| `audit.read` | — | — | — | — | — | ✓ | ✓ |
| `integration.*` | service accounts only (AUTH-06) — **never bound to a person's role** | | | | | | |

#### Two separate layers of change

| Goal | Where · who | Effective when |
|---|---|---|
| Add or remove a **person** from a role | **Keycloak** — the IT team holding the realm. Mapping applies per ROLE-03. In an emergency an admin may bind or unbind by hand (ROLE-02) | Via Keycloak: within one access-token lifetime (≤15 min). By hand: immediately. Both are audited |
| Add or remove a **permission inside a role** | **Admin › Roles** screen (A4) — tick from the catalog and save (ROLE-02); may differ per company (ROLE-04) | Immediately on the next API call — the backend checks live. The frontend menu follows within one token lifetime |
| Change the **visibility level** (own → team → department → company) | **Admin › Scope Rules** — the (role, resource) pair (SCOPE-01) | Immediately, no deploy |
| Add a **new permission to the catalog** | **Code only** — declared alongside its endpoint, then deployed. Admins cannot invent one, which is what prevents orphan permissions nothing actually enforces | Next release |

#### Guardrails the system must enforce

1. **Separation of duties** — a role holding `admin.*` may not also hold
   `approval.decide` or `request.sensitive.read`. The system refuses the grant;
   an admin cannot tick it for themselves.
2. **A role with holders cannot be deleted**, only deactivated.
3. **Every role / permission / scope change is audited** with before → after
   (ROLE-05).
4. **Removing a role must not strand work** — if the person removed is the
   current approver of a live case, the system moves it to the next holder of
   that role, or to their supervisor per the org chart, and notifies.

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
| **REQ-01** | Request types are configuration: receiving team, form schema, required documents, approval route, SLA, enabled companies — editable without deploy. A running request keeps the config it was submitted under. | ✅ types are configuration; form comes from `formSchema` |
| **REQ-02** | Number issued at submit, `{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}`, sequence resets monthly, unique under concurrency. | ✅ `OSD-DSC-202608-0042`; 20 concurrent submits → 20 unique numbers, no gaps |
| **REQ-03** | Required fields and documents block submit, naming what is missing. | ✅ blocks submit naming the field/document; nothing reserved on failure |
| **REQ-04** | Returns pick from a standard reason list (plus free text) so bounce causes are reportable. | ✅ reason must come from the type's list; clock pauses |
| **REQ-05** | Cancel by the requester or someone above them, with a reason. Never deleted. | ✅ cancelled with a reason, row retained |
| **REQ-06** | Requests can reference an originating entity (`ref_type`/`ref_id`) and prefill from it. | 🟡 |
| **REQ-07** | Append-only timeline of every status change: time, actor, before → after. | ✅ append-only `request_events`, verified across a full cycle |
| **REQ-08** | One screen for "my requests" and "awaiting my approval" across all types, with filters and due badges. | ✅ `view=mine|involved` through `buildScopeWhere` |
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

> ### Declared amendment — the ladder has no amounts (31 ส.ค. 2569)
>
> **สิ่งที่เปลี่ยน:** ตารางอำนาจอนุมัติเลิกใช้เพดานวงเงิน สายอนุมัติเป็นรายการ *ชั้น*
> แต่ละชั้นเลือกได้สองแบบ — `supervisor` ไต่ผังทีมของผู้ยื่นขึ้นไปกี่ชั้นก็ระบุได้
> (1 = หัวหน้าหน่วยงานที่สังกัด) หรือ `org` ระบุหน่วยงานที่มีสิทธิ์อนุมัติ และเลือก
> ผู้อนุมัติในหน่วยงานนั้นได้หลายคน ไม่เลือก = หัวหน้าของหน่วยงานนั้น
>
> **เหตุผลสามข้อ:**
>
> 1. **T1/T2 ไม่เคยได้รับการยืนยัน** — เป็น open question A ตั้งแต่ 24 ส.ค. 2569
>    ทุกสภาพแวดล้อมรันด้วยตัวเลขสมมติที่ไม่มีใครตกลง
> 2. **ตำแหน่งผู้อนุมัติถูกตรึงไว้สามค่า** (`team_lead`/`cfo`/`ceo`) ซึ่งไม่ตรงกับ
>    วิธีอนุมัติจริงของแต่ละฝ่าย ที่ส่งไปหาหัวหน้าหน่วยงานที่ระบุ หรือหาคนที่ระบุชื่อ
> 3. **หนึ่งชั้นมีผู้อนุมัติได้หลายคน** ซึ่งรูปแบบเดิมไม่มีที่เก็บเลย
>
> **สิ่งที่ไม่เปลี่ยน:** APV-02 (ไม่มีใครอนุมัติคำขอตัวเอง · ผู้ยื่นเลือกผู้อนุมัติเองไม่ได้),
> APV-03, APV-05 และการที่เวอร์ชันที่ประกาศแล้วแก้ทับไม่ได้
>
> **เวอร์ชันที่ประกาศก่อนวันนั้นไม่ถูกแตะ** — ยังเก็บ `tiers` และยัง route ด้วยกฎเดิม
> ทั้งชุด เพราะเคสที่วิ่งอยู่ถูกตัดสินด้วยกฎนั้น (§7) `ApprovalMatrix.levels` จึงเป็น
> คอลัมน์ใหม่ ไม่ใช่การเขียนทับ `tiers`
>
> รายละเอียดกฎอยู่ที่ `matrix-rules.ts` · การ resolve อยู่ที่ `access.service.ts`

| Code | Requirement | Status |
|---|---|---|
| **APV-01** | Central matrix of ceilings and approvers per (company, subject type, amount band + currency), versioned with effective dates. Published versions are immutable. | ✅ versioned + immutable; malformed ladders refused at publish |
| **APV-02** | The chain is computed by the system at submit; the requester cannot choose approvers; nobody approves their own request (team lead escalates to their own supervisor, a named office is skipped). | ✅ verified live on all three tiers, incl. self-approval skip |
| **APV-03** | Temporary delegation with a date window; pending and new work routes to the delegate; history names both people; no sub-delegation. | ✅ pending work re-routes; history names both; no sub-delegation |
| **APV-04** | Batch approval for cases sharing a reference, with per-case results and logs. | ✅ per-case results — one failure does not roll back the rest |
| **APV-05** | A decision is bound to a data snapshot; a material edit voids the approval and forces a new route. | ✅ `snapshotHash` binding; voided on a material edit |
| **APV-06** | Authority-usage report, exportable, restricted by permission. | 🟡 history endpoint delivered; export not yet |
| **APV-07** | Any module may raise an approval case with no Platform Request behind it; the result is published as an event. | ✅ raises a case with no request behind it (service account only) |

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
| **SUP-01** | SLA clock per request type (configurable). Starts at submit, pauses on return, resumes on resubmit. One holiday calendar per company. | ✅ starts at submit, pauses on return, **resumes** on resubmit (deadline pushed by the pause) |
| **SUP-02** | Overdue escalation to the owner plus one level up, recorded. | 🟡 |
| **SUP-03** | In-app + email (corporate SMTP) for: awaiting approval, returned, decision made, nearing due, overdue. Every send logged. | 🟡 in-app delivered and logged; **email unverified — no SMTP (open question B)** |
| **SUP-04** | One append-only audit log for permissions, request status, approvals, sensitive reads, and admin configuration; searchable by actor, event type, period. No update or delete API exists. | ✅ |

---

## 10. Data model

See [`data-model.md`](./data-model.md). Rules that hold throughout:

- every transactional table carries `companyId` and created/updated audit columns
- **no hard deletes** of transactional data — status columns only
- request form data is JSON against the schema declared in `RequestType`, so a
  new request type needs no migration

## 11. API

The full contract. Every endpoint below is from the source document; anything
this codebase adds beyond it must be justified in the PR that adds it.

**Deliverable alongside the code:** OpenAPI 3.1 **generated from the code**
(never hand-written beside it) covering every endpoint here, plus a
Postman/Bruno collection for QA.

### 11.1 Conventions shared by every endpoint

| | |
|---|---|
| Base URL | `/api/v1` — REST + JSON (UTF-8) |
| Auth | `Authorization: Bearer <access_token>` (Keycloak JWT) on **every** endpoint, no exceptions — see the amendment below |
| Company | `X-Company-Id` on every request; the backend verifies membership or answers `403 COMPANY_FORBIDDEN` |
| Pagination | `page` (from 1), `page_size` (default 20, max 100) |
| Sort / filter | `sort=field` or `sort=-field`; filters are query params named after the field |
| Time | ISO 8601 UTC — `2026-08-24T07:30:00Z` |
| Money | decimal **string** plus a separate currency field: `{"amount":"150000.00","currency":"THB"}` |
| Idempotency | every state-changing POST accepts `Idempotency-Key`; replaying a key returns the original result and creates nothing new (NFR-03) |

> **AMENDMENT, 8 ก.ย. 2569 — the bearer is not always a JWT (AUTH-06).**
>
> The `/external/*` group also accepts an API key beginning `rfk_`, so that an
> integration holds one credential that does not expire and **can be revoked** —
> which a very long-lived Keycloak token cannot be without rotating the client
> secret for every integration at once.
>
> It does not weaken the row above. core-service exchanges the key for a
> client-credentials token and forwards *that*, so user-service is still the only
> service that verifies a bearer (§03) and the permissions are the same set
> either way. The key answers *may this caller in*; the token answers *what may
> they do*.
>
> Implementation: `services/core-service/src/principal/api-key.service.ts`,
> issued by `yarn apikey:issue`. Guide: `docs/EXTERNAL_API.md`.

Every list response uses one envelope:

```json
{ "data": [ ... ], "page": 1, "page_size": 20, "total": 137 }
```

Every error uses one shape:

```json
{ "code": "REQ_DOC_MISSING", "message": "เอกสารบังคับยังไม่ครบ",
  "details": [ { "field": "attachments", "reason": "ต้องแนบใบเสนอราคาฉบับร่าง" } ] }
```

| Status | Used when |
|---|---|
| 200 / 201 | success / created (201 returns the full resource with its `id`) |
| 400 | malformed request (unparseable, wrong type) |
| 401 | missing or expired token |
| 403 | authenticated but not permitted (permission, or wrong company) |
| 404 | not found **or outside the caller's data scope** — 404 rather than 403 so existence is not disclosed (SCOPE-02) |
| 409 | conflicts with current state (transition off the state machine, stale version) |
| 422 | well-formed but fails a business rule (missing required field or document) |

### 11.2 Group A — Auth & Identity

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /auth/me` | any signed-in user | identity + every company they belong to + active company + roles + permissions + scope per resource. The frontend calls this once after login (ROLE-06) |
| `POST /auth/switch-company` | any signed-in user | `{"company_id"}` — returns the same payload as `/auth/me` for the new company (AUTH-05) |
| `POST /auth/logout` | any signed-in user | revokes the app session **and** calls Keycloak end-session (AUTH-03) |
| `GET /users?q=&org_unit_id=` | `user.read` | user search, filtered by scope and active company |
| `GET`/`POST /admin/org-units`, `PATCH /admin/org-units/{id}` | `admin.org.manage` | `{"name","parent_id","manager_user_id"}` — every write recomputes `org_closure` immediately (AUTH-04) |
| `PATCH /admin/users/{id}/org` | `admin.org.manage` | `{"org_unit_id","supervisor_user_id","companies":[...]}` |
| `GET /admin/users/unassigned` | `admin.org.manage` | signed in once but not yet placed — the "รอจัดสังกัด" queue |

`GET /auth/me` response:

```json
{ "user": { "id": "u_1024", "username": "somchai.k", "display_name": "สมชาย ก.",
    "email": "somchai.k@company.co.th",
    "org_unit": { "id": "ou_55", "name": "ทีมขาย Getter 1" },
    "supervisor": { "id": "u_87", "display_name": "สมหญิง จ." } },
  "companies": [ { "id": "c_osd", "name": "OSD", "doc_prefix": "OSD", "is_primary": true } ],
  "active_company_id": "c_osd",
  "roles": [ "employee", "sales" ],
  "permissions": [ "request.create", "request.read", "request.cancel.own", "notification.read" ],
  "scopes": { "request": "own", "approval_case": "own" },
  "sensitive_fields_visible": [] }
```

### 11.3 Group B — Roles · Scope · permission configuration (admin)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /admin/permissions` | `admin.role.manage` | the whole catalog, read-only — it is declared in code |
| `GET`/`POST /admin/roles`, `PATCH /admin/roles/{id}` | `admin.role.manage` | `{"name","description","permissions":[...],"active":true}` · **no delete**, only deactivate (ROLE-02); a role that still has holders accepts only `PATCH active:false` |
| `POST /admin/users/{id}/roles`, `DELETE /admin/users/{id}/roles/{roleId}` | `admin.role.manage` | `{"role_id","company_id"}` — audited every time (ROLE-05) |
| `GET`/`PUT /admin/keycloak-role-mappings` | `admin.role.manage` | `{"keycloak_role":"crm-sales","role_id":"r_sales","company_id":"c_osd"}` — re-evaluated on every login/refresh (ROLE-03) |
| `GET`/`PUT /admin/scope-rules` | `admin.role.manage` | `{"role_id","resource":"request","scope":"team"}` — effective immediately, no deploy (SCOPE-01) |
| `GET`/`PUT /admin/sensitive-field-rules` | `admin.role.manage` | `{"resource":"request:DSC","fields":["discount_pct","margin_pct"],"visible_to_permission":"request.sensitive.read"}` (SCOPE-04) |

### 11.4 Group C — Request Service

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /request-types` | `request.create` | types this user may raise in the active company, **with form schema, required documents and SLA** — the frontend renders the form from this (REQ-01) |
| `POST /requests` | `request.create` | `{"type_code","form_data":{...},"ref_type","ref_id"}` — a draft. No number yet, freely editable |
| `PATCH /requests/{id}` | draft owner | `form_data` editable **only** in `draft` and `returned`; anything else is `409 REQ_STATE_INVALID` |
| `POST /requests/{id}/attachments`, `DELETE /requests/{id}/attachments/{attachment_id}` | draft owner | multipart upload, type/size limited by config; deletable only in draft/returned |
| `POST /requests/{id}/submit` | draft owner | **the point the number is issued**, the SLA clock starts and the approval case opens. Required fields/documents are checked first, else `422` listing what is missing (REQ-02, REQ-03). No supervisor in the org chart → `422 ORG_SUPERVISOR_MISSING` |
| `GET /requests?view=mine\|involved` | `request.read` | scoped list; filters `status`, `type_code`, `due_before`, `overdue=true` (REQ-08) |
| `GET /requests/{id}` | `request.read` + scope | full detail + approval chain state + sensitive fields masked by permission; outside scope → 404 |
| `GET /requests/{id}/events` | `request.read` + scope | the append-only timeline (REQ-07) |
| `POST /requests/{id}/return` | current receiver/approver | `{"reason_codes":["DOC_INCOMPLETE"],"note"}` — at least one code required (REQ-04) · **the SLA clock stops** |
| `POST /requests/{id}/resubmit` | owner | from `returned` · **same number, the clock resumes** |
| `POST /requests/{id}/cancel` | owner (`request.cancel.own`) or `request.cancel.any` | `{"reason"}` required; allowed in any state before `completed` (REQ-05) |
| `POST /requests/{id}/complete` | the receiving team's owner | `in_progress` → `completed` with an outcome summary |
| `GET /reports/request-bottleneck` | `report.request.read` | mean/max time per step by type, approver and period — **excluding time the clock was stopped** (REQ-09) |
| `POST /integrations/requests` | service account, `integration.request.create` | create + submit in one call; the response carries `"source":"system"` (REQ-10, AUTH-06) |

Submitting a discount request:

```
POST /requests
{ "type_code": "DSC", "ref_type": "deal", "ref_id": "d_501",
  "form_data": { "customer_name": "บจก. ตัวอย่าง",
    "deal_value": {"amount":"800000.00","currency":"THB"},
    "discount_pct": 12.5, "est_margin_pct": 18.0,
    "reason": "ลูกค้าเทียบราคาคู่แข่ง" } }
→ 201 { "id": "rq_9001", "status": "draft", ... }

POST /requests/rq_9001/attachments      (ใบเสนอราคาฉบับร่าง)
POST /requests/rq_9001/submit
→ 200 { "id": "rq_9001", "request_no": "OSD-DSC-202608-0042",
        "status": "pending_approval", "due_at": "2026-08-25T10:00:00Z",
        "approval": { "case_id": "ac_331", "chain": [
          { "step": 1, "approver_role": "team_lead",
            "approver": {"id":"u_87","display_name":"สมหญิง จ."}, "status": "pending" },
          { "step": 2, "approver_role": "cfo", "status": "waiting" } ] } }
```

Documents missing:

```json
→ 422 { "code": "REQ_DOC_MISSING", "message": "เอกสารบังคับยังไม่ครบ",
        "details": [ { "field": "attachments", "reason": "ใบเสนอราคาฉบับร่าง" } ] }
```

**Request types (admin)** — `GET`/`POST /admin/request-types`,
`PATCH /admin/request-types/{code}`, permission `admin.request-type.manage`.
A whole type is created and edited from the screen (REQ-01):

```json
{ "code": "DSC", "name": "ขอส่วนลด", "receiver_org_unit_id": "...",
  "form_schema": { /* JSON Schema */ },
  "required_docs": [ { "code": "...", "name": "..." } ],
  "return_reason_codes": [ ... ],
  "sla": { "hours": 24, "business_hours": true },
  "approval_policy": { "mode": "standard_chain", "amount_field": "deal_value" },
  "companies": ["c_osd"], "active": true }
```

Edits apply to **new requests only** — a request already submitted keeps the
configuration it was submitted under.

### 11.5 Group D — Approval Service

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /approvals/inbox` | `approval.decide` | "รออนุมัติของฉัน" across every type, **including delegated work**, ordered by `due_at`, badged near/over deadline (REQ-08) |
| `GET /approvals/{caseId}` | in the chain + scope | subject, the snapshot as submitted, every rung with its outcome (SCOPE-06) |
| `POST /approvals/{caseId}/decide` | current approver (or their delegate) | `{"decision":"approve\|reject\|return","note","snapshot_version"}` · reject/return require `note` · stale `snapshot_version` → `409 APV_VERSION_STALE` (APV-05) · not your rung → `409 APV_NOT_YOUR_TURN` |
| `POST /approvals/batch-decide` | `approval.decide` | `{"case_ids":[...],"decision":"approve","note"}` — only cases on the **same reference** waiting on the **same person**; each is recorded separately (APV-04) |
| `GET`/`POST /approvals/delegations`, `DELETE /approvals/delegations/{id}` | `approval.decide` | `{"delegate_user_id","from","to","note"}` · overlapping an existing window → `409` · sub-delegation → `422 APV_NO_SUBDELEGATION` (APV-03) |
| `GET /admin/approval-matrix?company_id=`, `POST /admin/approval-matrix` | `admin.approval-matrix.manage` | publishes a whole new version per (company, subject type). Old versions stay readable; **editing in place is forbidden** (APV-01) |
| `GET /approvals/history` | `approval.history.read` (auditor/executive) | authority-usage report: filter by approver, period, type, amount, including approvals made on someone's behalf · CSV export (APV-06) |
| `POST /integrations/approval-cases` | service, `integration.approval.create` | another module raises an approval without a Platform Request: `{"subject_type","subject_id","company_id","amount","currency","payload","callback_event"}` — the outcome is published to `callback_event` (APV-07) |

Matrix body:

```json
{ "company_id": "c_osd", "subject_type": "request:DSC", "currency": "THB",
  "tiers": [ { "upto": "100000.00",  "chain": ["team_lead"] },
             { "upto": "1000000.00", "chain": ["team_lead","cfo"] },
             { "upto": null,         "chain": ["team_lead","cfo","ceo"] } ],
  "effective_from": "2026-09-01" }
```

**How the chain is computed, server-side, at submit:** read the matrix version
in force on the submission date for (company, subject_type) → take the first
tier where `amount ≤ upto` → resolve each position to a person: `team_lead` is
the requester's supervisor from the org chart, `cfo`/`ceo` are the holders of
that role in the active company → **drop any rung that is the requester
themselves, promoting the rest** (APV-02) → persist as fixed `approval_step`
rows together with the matrix version used, so a later matrix change cannot
touch a case already running.

### 11.6 Group E — SLA · Notification (minimum)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET`/`PUT /admin/sla-configs` | `admin.sla.manage` | `{"request_type_code","company_id","hours":24,"business_hours":true,"warn_before_hours":4}` (SUP-01, D-09) |
| `GET /admin/holiday-calendars`, `PUT /admin/holiday-calendars/{companyId}` | `admin.sla.manage` | holidays and working hours per company (one set per company this sprint) |
| `GET /notifications?unread=true` | any signed-in user | own in-app notifications · `POST /notifications/{id}/read`, `POST /notifications/read-all` |
| `GET`/`PUT /notifications/preferences` | any signed-in user | email on/off per event — **in-app cannot be turned off** |

### 11.7 Group F — Audit Log

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /audit-logs` | `audit.read` (auditor) | filters `actor_id`, `event_type`, `resource_type`, `resource_id`, `from`, `to` · **read-only — there is no update or delete endpoint** (SUP-04) |

### 11.8 Internal events (for Notification and future modules)

| Event | Raised when · main payload |
|---|---|
| `request.submitted` | `{request_id, request_no, type_code, company_id, requester_id}` |
| `request.returned` / `request.resubmitted` | includes `reason_codes` |
| `request.cancelled` / `request.completed` | cancelled / closed |
| `approval.step.pending` | a new approver's turn · `{case_id, step, approver_id}` — **this is what triggers "you have work waiting"** |
| `approval.completed` / `approval.rejected` / `approval.voided` | outcome, or voided because the data changed (APV-05) |
| `sla.warning` / `sla.breached` | near / past deadline — `sla.breached` triggers escalation (SUP-02) |

Every consumer must be idempotent (events may be delivered more than once).
Ordering is guaranteed only within a single request. The notification service is
the first consumer; the event → message/channel mapping is configuration.

### 11.9 Business error codes

| Code | HTTP | Meaning |
|---|---|---|
| `COMPANY_FORBIDDEN` | 403 | caller does not belong to the company in `X-Company-Id` |
| `REQ_FIELD_MISSING` | 422 | required form-schema fields absent (listed in `details`) |
| `REQ_DOC_MISSING` | 422 | required attachments absent |
| `REQ_STATE_INVALID` | 409 | action does not match the current state |
| `REQ_TYPE_INACTIVE` | 422 | the request type is disabled in this company |
| `ORG_SUPERVISOR_MISSING` | 422 | the requester has no supervisor in the org chart |
| `APV_NOT_YOUR_TURN` | 409 | not the caller's rung, or already decided |
| `APV_VERSION_STALE` | 409 | `snapshot_version` no longer matches — reload before deciding |
| `APV_MATRIX_NOT_FOUND` | 422 | no effective matrix for (company, subject type) |
| `APV_NO_SUBDELEGATION` | 422 | a delegate may not delegate onward |
| `DELEGATION_OVERLAP` | 409 | the window overlaps an existing delegation |

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

---

## 16. Mockup หน้าจอแต่ละ Process

ภาพหน้าจอ **9 หน้า** ครอบคลุม flow ผู้ใช้ (หน้าที่ 1–5) และงานตั้งค่าของผู้ดูแล
(A1–A4) — **A3 กับ A4 เป็นสองแท็บของหน้าเดียวกัน** (`ผังทีมและสิทธิ์`)
ข้อมูลในภาพ (ชื่อคน เลขคำขอ วงเงิน) เป็นข้อมูลสมมติชุดเดียวกันทุกหน้า
เพื่อให้ไล่ตาม flow ได้

> **นี่คือหัวข้อที่ v1.3 เพิ่มเข้ามา** และเป็นหัวข้อที่หายไปจากไฟล์นี้ตั้งแต่การ
> extract ครั้งแรก ทำให้หน้าจอทั้งหมดถูกสร้างจากการเดา ก่อนเขียนหน้าจอใด ๆ
> ต้องอ่านหัวข้อนี้ก่อน

### เมนูซ้าย (ทุกหน้า)

```
งานค้างของฉัน
ยื่นคำขอใหม่
รออนุมัติของฉัน        (n)     ← badge จำนวนงานค้าง
รายงานคอขวด
ผู้ดูแลระบบ                     ← เฉพาะผู้มีสิทธิ์ admin.*
  ตารางอำนาจอนุมัติ
  ประเภทคำขอ
  ผังทีมและสิทธิ์
  Audit Log
```

Header: `บริษัท: OSD` + ตัวสลับบริษัท · กระดิ่งแจ้งเตือนพร้อมจำนวน ·
ชื่อผู้ใช้ + ทีม (เช่น `สมชาย ก.` / `ทีมขาย Getter 1`)

### หน้าที่ 1 — เข้าสู่ระบบ (SSO) · AUTH-01, AUTH-04

ปุ่มเดียว SSO ผ่าน Keycloak (LDAP ยืนยันตัวตน) **ไม่มีฟอร์มรหัสผ่านในระบบ** ·
ล็อกอินครั้งแรกระบบสร้างโปรไฟล์อัตโนมัติแล้วเข้าคิวรอจัดสังกัด

**ฝั่งซ้าย — แนะนำระบบ**

- โลโก้ + ชื่อ `Connect the Dot`
- headline สามบรรทัด:
  `คำขอข้ามทีมทุกใบ` / `มีเจ้าของ มีกำหนดเวลา` / `ตรวจย้อนได้เสมอ`
- คำโปรย: *"แพลตฟอร์มคำขอและการอนุมัติกลางของกลุ่มบริษัท เลิกไล่งานในอีเมลและแชท"*
- สามข้อ (มี icon นำหน้าแต่ละข้อ):
  - `เลขอ้างอิงทุกคำขอ ออกทันทีที่ยื่น`
  - `เส้นทางอนุมัติอัตโนมัติตามวงเงิน`
  - `นาฬิกา SLA เดินเอง เร่งงานเองเมื่อเกินกำหนด`
- ท้ายคอลัมน์: `Foundation Sprint · v1.2`

**ฝั่งขวา — กล่องเข้าสู่ระบบ**

- หัวข้อ `เข้าสู่ระบบ` · คำอธิบาย
  *"ใช้บัญชีองค์กรของคุณ ไม่ต้องสมัครหรือตั้งรหัสผ่านใหม่"*
- ปุ่มเดียว: `เข้าสู่ระบบด้วยบัญชีองค์กร (SSO)`
- ใต้ปุ่ม: *"ระบบจะพาไปยืนยันตัวตนผ่าน Keycloak ด้วยรหัสผ่านองค์กร (LDAP) —
  ระบบนี้ไม่เก็บและไม่เห็นรหัสผ่านของคุณ"*
- กล่องท้ายสุด (AUTH-04): *"เข้าระบบครั้งแรกแล้วยังไม่เห็นเมนู?
  บัญชีของคุณกำลังรอผู้ดูแลจัดสังกัดทีม ติดต่อผู้ดูแลระบบที่
  it-support@company.co.th"*

### หน้าที่ 2 — งานค้างของฉัน · REQ-08

**หน้าแรกหลังล็อกอิน** แท็บ `คำขอของฉัน · n` / `รออนุมัติของฉัน · n` ข้ามทุก
ประเภทคำขอ · รายการกรองตาม data scope ที่ backend

- ปุ่ม `ยื่นคำขอใหม่` มุมขวาบน
- ฟิลเตอร์: ค้นหา `เลขที่ / ลูกค้า / ดีล` · `สถานะ: ทั้งหมด` ·
  `ประเภท: ทั้งหมด` · checkbox `เฉพาะเกินกำหนด`
- ตาราง: `เลขที่คำขอ | ประเภท · อ้างอิง | สถานะ | ขั้นปัจจุบัน | ครบกำหนด`

ตัวอย่างแถวจาก mockup:

```
OSD-DSC-202608-0042   ขอส่วนลด 12.5%              รออนุมัติ   ขั้น 2/2 · CFO           เกิน 3 ชม.
                      ดีล D-501 · บจก. ตัวอย่าง
OSD-DSC-202608-0038   ขอส่วนลด 8%                  ตีกลับ      รอฉันแก้ไข · ขาดใบเสนอราคา  นาฬิกาหยุด
                      ดีล D-497 · บมจ. สยามเน็ต
OSD-LEAD-202608-0104  ส่งต่อโอกาสการขาย           …
```

ป้าย SLA มีสามสถานะ: **เกินกำหนด** (`เกิน 3 ชม.`), **ใกล้ครบ** (`เหลือ 5 ชม.`),
และ **นาฬิกาหยุด** เมื่อคำขอถูกตีกลับ

### หน้าที่ 3 — ยื่นคำขอ (ขอส่วนลด) · REQ-01, REQ-02, REQ-03, APV-02

ฟอร์มมาจาก **form schema ของประเภทคำขอ** ไม่ใช่โค้ด · ยื่นไม่ได้ถ้าฟิลด์/เอกสาร
บังคับไม่ครบ · **แสดงเส้นทางอนุมัติที่คำนวณจากวงเงินก่อนกดยื่น** · เลขคำขอออก
ตอนกดยื่น

- แถบสถานะบนสุด: `สถานะ: ร่าง — เลขคำขอจะออกเมื่อกดยื่น`
- ฟิลด์: `ประเภทคำขอ *` · `อ้างอิงดีล *` · `มูลค่าดีล (THB) *` ·
  `% ส่วนลดที่ขอ *` · `margin โดยประมาณ` (ฟิลด์อ่อนไหว) · `เหตุผล *`
- เอกสารแนบบังคับตามประเภท — แถวไฟล์แสดง `quote-D501-v2.pdf · 1.2 MB` + `ลบ`
  และพื้นที่ `ลากไฟล์มาวาง หรือกดเพื่อแนบเอกสารเพิ่มเติม`
- ท้ายฟอร์ม: `บันทึกร่างอัตโนมัติล่าสุด 10:42 น.` · ปุ่ม `บันทึกร่าง` และ `ยื่นคำขอ`
- `margin โดยประมาณ (%) *` มีป้ายกำกับ **`เห็นเฉพาะสายอนุมัติ`** ติดอยู่กับฟิลด์
- `ลูกค้า` เติมอัตโนมัติ: `บจก. ตัวอย่าง (ดึงจากดีลอัตโนมัติ)` (REQ-06)

**แผงขวา `เส้นทางอนุมัติที่จะใช้`** — คำนวณก่อนกดยื่น พร้อมเหตุผลรายชั้น:

```
คำนวณอัตโนมัติจากวงเงิน 800,000 บาท (เกินเพดานระดับ 1)
— ผู้ยื่นเลือกผู้อนุมัติเองไม่ได้

  1  หัวหน้าทีม — สมหญิง จ.    ตรวจสิทธิ์การยื่นและความสมเหตุสมผล
  2  CFO — วรัญญา ส.           วงเงินเกิน 100,000 บาท

CEO ไม่อยู่ในเส้นทาง — วงเงินไม่เกินเพดานระดับ 2 (1,000,000 บาท)
```

**แผงขวา `กำหนดเวลา (SLA)`**: `24 ชั่วโมงทำการ` ·
*"นาฬิกาเริ่มเดินเมื่อยื่น หยุดเมื่อถูกตีกลับให้แก้ · เกินกำหนดระบบเร่งงานถึง
ผู้บังคับบัญชาอัตโนมัติ"*

### หน้าที่ 4 — รายละเอียดคำขอ + ไทม์ไลน์ · REQ-07, SCOPE-04, SUP-02

ไทม์ไลน์ **append-only** ทุกการเปลี่ยนสถานะ รวมการเร่งงานอัตโนมัติ ·
**margin ถูกปกปิดจากผู้ไม่มีสิทธิ์** (แสดงเป็น `••••••`) · stepper เส้นทาง
อนุมัติพร้อมเหตุผลที่ได้เส้นทางนี้

- หัวเรื่อง `OSD-DSC-202608-0042 · ขอส่วนลด 12.5%` + `รออนุมัติ · ขั้น 2/2`
  + ป้าย `เกินกำหนด 3 ชม.`
- ปุ่ม `ยกเลิกคำขอ`
- กล่อง **ข้อมูลคำขอ**: `ผู้ยื่น` (ชื่อ · ทีม) · `ยื่นเมื่อ` · `อ้างอิง` ·
  `มูลค่าดีล` · `% ส่วนลดที่ขอ` · `margin โดยประมาณ` · `เหตุผล` ·
  `เอกสารแนบ (n)` พร้อมชื่อไฟล์และขนาด
- กล่อง **ไทม์ไลน์ (บันทึกทุกการเปลี่ยนสถานะ)** — ทุกแถวมี ผู้กระทำ · เวลา ·
  ผลที่เกิด รวมรายการที่ **ระบบ** เป็นผู้กระทำ:

```
หัวหน้าทีมอนุมัติ (ขั้น 1/2)  — สมหญิง จ. · 23 ส.ค. 16:40 น.
                                "ข้อมูลครบ เห็นควรส่งต่อ"
เข้าคิว CFO (ขั้น 2/2)        — ระบบ · 23 ส.ค. 16:40 น.
                                แจ้งเตือนส่งแล้ว (in-app + อีเมล)
ยื่นคำขอ · ออกเลข OSD-DSC-202608-0042
                              — สมชาย ก. · 23 ส.ค. 14:05 น. · นาฬิกา SLA เริ่มเดิน
เกินกำหนด — เร่งงานอัตโนมัติ  — ระบบ · วันนี้ 11:05 น.
                                แจ้ง CFO และผู้บังคับบัญชา 1 ระดับ
```

- กล่อง **เส้นทางอนุมัติ** (stepper) แต่ละขั้นแสดงชื่อ ตำแหน่ง และผล:
  `ขั้น 1 · หัวหน้าทีม / สมหญิง จ. / อนุมัติแล้ว · 23 ส.ค. 16:40` ·
  `ขั้น 2 · CFO / วรัญญา ส. / รอพิจารณา · เกินกำหนด 3 ชม.`
- ใต้ stepper สองบรรทัดที่ต้องมี:
  *"เส้นทางคำนวณจากวงเงิน 800,000 บาท (เกิน T1, ไม่เกิน T2) · ตารางอำนาจเวอร์ชัน 2"*
  และ *"แก้ไขสาระสำคัญหลังอนุมัติจะทำให้การอนุมัติเป็นโมฆะและต้องเริ่มเส้นทางใหม่"*

### หน้าที่ 5 — อนุมัติ (มุมมอง CFO) · REQ-04, APV-03, APV-04, APV-05

**คิวเรียงตามความเร่ง** · อนุมัติเป็นชุดของดีลเดียวกัน · **ตีกลับต้องเลือกเหตุผล
มาตรฐาน ปฏิเสธบังคับใส่ความเห็น** · แบนเนอร์รับมอบอำนาจ · การตัดสินผูกกับ
snapshot version

เค้าโครงเป็น **two-pane** ไม่ใช่ list + modal:

- **แบนเนอร์รับมอบอำนาจ** (เมื่อกำลังรับมอบอำนาจ):
  *"คุณกำลังรับมอบอำนาจแทน สมปอง ว. (CFO บริษัท B) ช่วง 21–28 ส.ค. 2569 —
  ทุกการอนุมัติจะบันทึกว่า 'อนุมัติแทน'"*
- **ซ้าย — คิว**: `คิวรออนุมัติ · n รายการ` + ปุ่ม `อนุมัติเป็นชุด` + checkbox
  เลือกหลายรายการ แต่ละแถว: เลขที่ + ป้ายความเร่ง, บรรทัดสรุป
  (`ขอส่วนลด 12.5% · ดีล D-501 · 800,000 THB`), และ
  `ยื่นโดย สมชาย ก. · ขั้น 2/2` พร้อมหมายเหตุ `ดีลเดียวกับ 0045` เมื่ออ้างดีลเดียวกัน
- **ขวา — รายละเอียด**: `มูลค่าดีล` · `% ส่วนลด` ·
  `margin หลังส่วนลด` พร้อมเกณฑ์ (`18.0% (เกณฑ์ขั้นต่ำ 15%)`) ·
  `ขั้น 1 หัวหน้าทีมอนุมัติแล้ว` · `เหตุผลผู้ยื่น: …` ·
  ลิงก์ `เปิดดูคำขอฉบับเต็มและเอกสารแนบ (2)`
- **ประกาศ snapshot** เหนือปุ่มตัดสิน:
  *"การตัดสินผูกกับข้อมูลเวอร์ชันนี้ (snapshot v1) — ถ้าผู้ยื่นแก้ข้อมูลระหว่างนี้
  ระบบจะให้โหลดใหม่ก่อนตัดสิน"* (APV-05)
- **แบบฟอร์มตัดสิน**:
  - `ความเห็นประกอบการตัดสิน (บังคับเมื่อปฏิเสธหรือตีกลับ)` — placeholder
    `พิมพ์ความเห็น…`
  - `กรณีตีกลับ — เลือกสิ่งที่ต้องแก้ (อย่างน้อย 1 ข้อ)`:
    `เอกสารไม่ครบ` · `ตัวเลข margin ไม่ถูกต้อง` · `เหตุผลไม่เพียงพอ` ·
    `อื่น ๆ (ระบุ)` (REQ-04)
  - ปุ่มสามปุ่ม: `ปฏิเสธ` · `ตีกลับให้แก้` · `อนุมัติ`
- หัวคิวแสดงผู้ใช้ปัจจุบัน `วรัญญา ส. · CFO` และเมนู `รออนุมัติของฉัน 3`
  มีตัวเลขค้างอยู่บนเมนู

### A1 — ตารางอำนาจอนุมัติ (ผู้ดูแล) · APV-01, APV-02

เส้นทางมาตรฐาน หัวหน้าทีม → CFO (เกิน T1) → CEO (เกิน T2) · **แยกชุดต่อบริษัท
ตาม D-18** · **แก้เป็นเวอร์ชันใหม่ ห้ามแก้ทับ** · ตัวเลขวงเงินเป็นค่าสมมติ
รอฝ่ายการเงินยืนยัน

- แท็บบริษัท: `บริษัท OSD` / `บริษัท B` / `บริษัท C`
- ตัวเลือก `ประเภทงาน: ขอส่วนลด (request:DSC)`
- ปุ่ม `สร้างเวอร์ชันใหม่`
- หัวเวอร์ชัน: `เวอร์ชัน 2 (ปัจจุบัน)` · `มีผลตั้งแต่ 1 มิ.ย. 2569` ·
  `สกุลเงิน THB · สร้างโดย admin` พร้อมข้อความ
  **"เวอร์ชันที่ประกาศแล้วแก้ทับไม่ได้ — ต้องสร้างเวอร์ชันใหม่"**
- ตาราง `ระดับ | ช่วงวงเงิน (THB) | ลำดับชั้นผู้อนุมัติ | ความหมาย`

```
T0   ≤ 100,000              1 · หัวหน้าทีมของผู้ยื่น            ตรวจสิทธิ์การยื่น จบในทีม
T1   100,001 – 1,000,000    1 · หัวหน้าทีม → 2 · CFO            เกินเพดานระดับ 1 — เพิ่ม CFO
T2   > 1,000,000            1 · หัวหน้าทีม → 2 · CFO → 3 · CEO  เกินเพดานระดับ 2
```

### A2 — ประเภทคำขอ (ผู้ดูแล) · REQ-01

ประเภทคำขอเป็น **ข้อมูลตั้งค่า ไม่ใช่โค้ด**: ฟิลด์ฟอร์ม เอกสารบังคับ เหตุผล
ตีกลับ SLA และเส้นทางอนุมัติ แก้จากหน้าจอ · **มีผลเฉพาะคำขอใหม่**

- ซ้าย: รายการประเภททั้งหมดพร้อมสถานะ `เปิดใช้` / `ยังไม่เปิด`

```
ขอส่วนลด              เปิดใช้      DSC  · Sales → Pricing    · SLA 24 ชม.ทำการ
ส่งต่อโอกาสการขาย      เปิดใช้      LEAD · CRM → Sales        · SLA 4 ชม.ทำการ
ขอจัดทำ NDA           ยังไม่เปิด   NDA  · ทุกทีม → Legal      · รอ sprint ถัดไป
ขอ Solution ฯ         ยังไม่เปิด   SOL  · Sales → Pre-Sales   · รอ sprint ถัดไป
```

- ขวา: `แก้ไข: ขอส่วนลด (DSC)` + ปุ่ม `ปิดใช้งาน` / `บันทึก`
  - `ชื่อประเภท` · `ทีมผู้รับ` · `SLA (ชั่วโมงทำการ)`
  - **ฟิลด์ฟอร์ม (form schema)** แต่ละฟิลด์ระบุชนิดและเงื่อนไข:
    `มูลค่าดีล` (จำนวนเงิน + สกุลเงิน, บังคับ) ·
    `% ส่วนลดที่ขอ` (ตัวเลข 0–100, บังคับ) ·
    `margin โดยประมาณ` (ตัวเลข · **ฟิลด์อ่อนไหว** · จำกัดสิทธิ์) ·
    `เหตุผล` (ข้อความยาว, บังคับ) + ปุ่ม `เพิ่มฟิลด์`

### A3 — ผังทีมและสิทธิ์ (ผู้ดูแล) · AUTH-04, ROLE-03, SCOPE-01

LDAP ใช้ล็อกอินเท่านั้น — **ผังทีม/หัวหน้าดูแลในระบบ** · คิว `รอจัดสังกัด`
สำหรับผู้ล็อกอินครั้งแรก · **role หลักมาจาก Keycloak, scope ปรับในระบบ**

> **A3 และ A4 เป็นแท็บของหน้าเดียวกัน** หัวหน้า `ผังทีมและสิทธิ์` ·
> `บริษัท: OSD` มุมขวาบน · แท็บ `ผังทีม` · `Role และ Permission` ·
> `Scope Rules` · `Keycloak Mapping`

หัวเรื่อง `ผังทีมและสิทธิ์ — ดูแลในระบบ (LDAP ใช้ล็อกอินเท่านั้น)`

- ซ้าย `โครงสร้างทีม` + ปุ่ม `เพิ่มทีม` — ต้นไม้ `บริษัท OSD` › `ฝ่ายขาย`
  (`ผอ. ประเสริฐ ท.`) › `ทีมขาย Getter 1` (`หัวหน้า: สมหญิง จ. · 6 คน`) ·
  `ทีมขาย Keeper 1` · `ทีม Pricing 4 คน` · `ฝ่ายการเงิน` (`CFO วรัญญา ส.`)
  - ใต้ต้นไม้: *"ผังนี้คือแหล่งความจริงของ 'หัวหน้าของผู้ยื่น' ที่ใช้ใน Data
    Scope, เส้นทางอนุมัติชั้นที่ 1 และการเร่งงาน"*
- `รอจัดสังกัด · 2 คน` — *"ล็อกอินครั้งแรกแล้วแต่ยังยื่นคำขอไม่ได้จนกว่าจะมี
  หัวหน้า"* · แต่ละแถวมีอักษรย่อ, `ชื่อ · username`,
  `ล็อกอินครั้งแรก … · role จาก Keycloak: …` และปุ่ม `จัดสังกัด`
- ขวา: ทีมที่เลือก + `หัวหน้าทีม: …` + ปุ่ม `เปลี่ยนหัวหน้าทีม` · สมาชิกแต่ละคน
  แสดงตำแหน่ง, role code, `scope: …` และ `หัวหน้า:` / `รายงานตรงต่อ:`
- ท้ายหน้า: *"role หลักมาจาก Keycloak (แก้ที่ Keycloak) · ผู้ดูแลปรับ scope และ
  ผูก role เพิ่มในระบบได้ — ทุกการแก้ไขลง Audit Log"*

### A4 — Role และ Permission (ผู้ดูแล · หน้าจอในแอป ไม่ใช่ Keycloak) · ROLE-02, ROLE-03, ROLE-05, §5.4

สมาชิก role จัดการที่ Keycloak (mapping `crm-*`) — **หน้านี้กำหนดว่า role ทำ
อะไรได้**: ติ๊ก permission จาก catalog, ผูก/ถอนมือกรณีเร่งด่วนพร้อมป้ายแหล่งที่มา,
ปิดใช้งาน role · role ที่มีผู้ใช้ลบไม่ได้ · `admin.*` ถูกล็อกตาม guardrail
แยกหน้าที่ (§5.4) · ทุกการแก้ลง Audit Log

- **ซ้าย** `Role ทั้งหมด · 7` + ปุ่ม `สร้าง role` แต่ละแถว:
  - `พนักงาน` — `ทุกคน · อัตโนมัติ`
  - `หัวหน้าทีม` `เปิดใช้` — `14 คน · map จาก Keycloak: crm-team-lead`
  - `ทีมผู้รับคำขอ (Pricing)` `เปิดใช้` — `4 คน · crm-pricing`
  - `ผู้จัดการฝ่าย` `เปิดใช้` — `3 คน · crm-dept-manager`
  - `ผู้บริหาร (CFO/CEO)` `เปิดใช้` — `2 คน · crm-executive`
  - `ทีมขายชั่วคราว Q3` `ปิดใช้งาน` — `0 คน · ปิดเมื่อ 15 ส.ค. 2569`
- **กลาง** `แก้ไข role: หัวหน้าทีม` + ป้าย `บริษัท OSD` +
  `ลบไม่ได้ — มีผู้ใช้ 14 คน` + ปุ่ม `ปิดใช้งาน` · `บันทึก`
  - แบนเนอร์: *"สมาชิก role จัดการที่ Keycloak (map: `crm-team-lead`) — หน้านี้
    กำหนดเฉพาะว่า role ทำอะไรได้ · แก้แล้วมีผลทันทีกับ API call ถัดไป"*
  - `REQUEST` — `request.create ยื่นคำขอ` · `request.return ตีกลับ` ·
    `request.cancel.own ยกเลิกของตน` · `request.cancel.any ยกเลิกแทน` ·
    `request.complete ปิดงาน` · `request.sensitive.read เห็น margin`
  - `APPROVAL · REPORT` — `approval.decide อนุมัติ` ·
    `approval.history.read ประวัติอำนาจ` · `report.request.read รายงานทีม` ·
    `user.read ค้นผู้ใช้`
  - `ADMIN · AUDIT` — **`admin.* — ขัด guardrail แยกหน้าที่`** (ล็อก) ·
    `audit.read อ่าน audit log`
- **ขวา** `ผู้ใช้ใน role นี้ · 14` + ปุ่ม `+ ผูกมือ` · แต่ละแถวมีป้ายแหล่งที่มา
  `จาก Keycloak` หรือ `ผูกมือ` (แถวที่ผูกมือมีปุ่ม `ถอน`) · `ดูทั้งหมด 14 คน`
- **ขวาล่าง** `การเปลี่ยนแปลงล่าสุด` —
  `เพิ่ม report.request.read — admin · 20 ส.ค.` ·
  `ผูกมือ กมล ต. (รักษาการถึง 31 ส.ค.) — admin · 18 ส.ค.` ·
  *"ทุกรายการอยู่ใน Audit Log"*
