# API specification

CTD spec §11. The live contract is the OpenAPI generated at `/api/docs` on each
service — this file holds the conventions that generated document cannot
express, and the endpoint map with delivery status.

**Status:** ✅ implemented and verified against a running service.

> Every row read 🟡 (*"route declared, handler returns `501`"*) until 28 Aug
> 2026. All thirteen unimplemented handlers were closed, and `grep` now finds
> no `NOT_IMPLEMENTED` thrown anywhere — `common/not-implemented.ts` is dead
> code. The markers were left behind and made this page claim the entire
> Request Service was unbuilt.
>
> This file is hand-maintained, so it can drift again. The generated OpenAPI
> (`yarn openapi` → `docs/openapi/*.json`) is the contract; `yarn spec:check`
> reports differences against the specification.

---

## Conventions (§11.1)

**Base URL** `/api/v1` in the spec; currently `/api` — see the note at the end.
REST + JSON, UTF-8.

**Authentication** `Authorization: Bearer <access_token>` on every endpoint, no
exceptions beyond the handful marked `@Public()` (health, login redirect,
callback).

**Active company** `X-Company-Id` selects the company a request works in. The
caller must belong to it, else `403 COMPANY_FORBIDDEN`. Omitted means their
primary company. Roles and scope are resolved **for that company** (ROLE-04).

**Pagination** `page` (from 1), `page_size` (default 20, max 100). Every list
returns the same envelope:

```json
{ "data": [], "page": 1, "page_size": 20, "total": 137 }
```

**Sort / filter** `sort=field` or `sort=-field` for descending; filters are
query params named after the field. Sortable columns are whitelisted per
endpoint — an unlisted one is ignored, not passed through.

**Errors** one shape everywhere:

```json
{
  "code": "REQ_DOC_MISSING",
  "message": "เอกสารบังคับยังไม่ครบ",
  "details": [{ "field": "attachments", "reason": "ต้องแนบใบเสนอราคาฉบับร่าง" }]
}
```

Clients branch on `code`; `message` is Thai and may be reworded.

**Time** ISO 8601 UTC (`2026-08-24T07:30:00Z`).
**Money** decimal string plus a separate currency: `{"amount":"150000.00","currency":"THB"}`.

**Idempotency** every state-changing POST accepts `Idempotency-Key`. Replaying
a key returns the original response; replaying it with a *different* body is
`409 IDEMPOTENCY_KEY_REUSED` — that is a client bug, not a retry.

### HTTP status codes

| Status | Used when |
|---|---|
| 200 / 201 | success / created (201 returns the full resource with its `id`) |
| 400 | malformed request (unparseable, wrong type) |
| 401 | missing or expired token |
| 403 | authenticated but not permitted (permission or wrong company) |
| 404 | not found **or outside data scope** — 404 rather than 403 so existence is not disclosed (SCOPE-02) |
| 409 | conflicts with current state (illegal transition, stale version) |
| 422 | well-formed but fails a business rule (missing required field or document) |
| 501 | route exists, sprint has not delivered it yet |

---

## Group A — Auth & Identity  (`user-service`)

| Endpoint | Permission | Notes | Status |
|---|---|---|---|
| `POST /auth/authorize` | public | PKCE leg 1 — returns `authorize_url`, `state`, `code_verifier` | ✅ |
| `POST /auth/callback` | public | PKCE leg 2 — code + verifier → tokens; provisions the profile (AUTH-04) and logs the login (AUTH-07) | ✅ |
| `POST /auth/refresh` | public | refresh token → new token set | ✅ |
| `POST /auth/logout` | public | revokes the session, returns `end_session_url` for single logout (AUTH-03) | ✅ |
| `GET /auth/me` | any signed-in user | identity + companies + active company + roles + permissions + scope + visible sensitive fields. Called once after login (ROLE-06) | ✅ |
| `POST /auth/switch-company` | any signed-in user | `{"company_id"}` — re-resolves roles and scope for the new company (AUTH-05) | ✅ |
| `GET /users?q=&org_unit_id=` | `user.read` | people picker; filtered by scope and active company | ✅ |
| `GET /admin/org-units` | `admin.org.manage` | | ✅ |
| `POST /admin/org-units` | `admin.org.manage` | `{name, parent_id, manager_user_id}`; rebuilds `OrgClosure` in the same transaction | ✅ |
| `PATCH /admin/org-units/{id}` | `admin.org.manage` | re-parenting rebuilds the closure; cycles rejected with `ORG_UNIT_CYCLE` | ✅ |
| `PATCH /admin/users/{id}/org` | `admin.org.manage` | `{org_unit_id, supervisor_user_id, companies, primary_company_id}` | ✅ |
| `GET /admin/users/unassigned` | `admin.org.manage` | the "รอจัดสังกัด" queue | ✅ |

### `GET /auth/me` response

```json
{
  "user": {
    "id": "u_1024", "username": "somchai.k", "display_name": "สมชาย ก.",
    "email": "somchai.k@company.co.th",
    "org_unit_id": "ou_55", "supervisor_user_id": "u_87",
    "pending_org_assignment": false
  },
  "companies": [
    { "id": "c_osd", "name": "OSD", "doc_prefix": "OSD", "is_primary": true }
  ],
  "active_company_id": "c_osd",
  "roles": ["employee", "sales"],
  "permissions": ["request.create", "request.read", "request.cancel.own"],
  "scopes": { "request": "own", "approval_case": "own" },
  "sensitive_fields_visible": []
}
```

`pending_org_assignment` is an addition to §11.2: a user provisioned on first
login has no company or role yet, and the UI needs to distinguish "no
permissions" from "waiting for an admin".

---

## Group B — Roles, scope, permission configuration  (`user-service`)

| Endpoint | Permission | Notes | Status |
|---|---|---|---|
| `GET /admin/permissions` | `admin.role.manage` | the catalog, read-only — declared in code | ✅ |
| `GET/POST /admin/roles`, `PATCH /admin/roles/{id}` | `admin.role.manage` | a role with holders may only be deactivated (ROLE-02); no delete endpoint exists | ✅ |
| `POST /admin/users/{id}/roles` | `admin.role.manage` | `{role_id, company_id}`; audited | ✅ |
| `DELETE /admin/users/{id}/roles/{roleId}` | `admin.role.manage` | audited | ✅ |
| `GET/PUT /admin/keycloak-role-mappings` | `admin.role.manage` | Keycloak role → system role, per company; re-evaluated every login (ROLE-03) | ✅ |
| `GET/PUT /admin/scope-rules` | `admin.role.manage` | `{role_id, resource, scope}` — effective immediately, no deploy (SCOPE-01) | ✅ |
| `GET/PUT /admin/sensitive-field-rules` | `admin.role.manage` | `{resource, fields[], visible_to_permission}` (SCOPE-04) | ✅ |
| `GET /internal/policy/resolve` | any signed-in user | how `core-service` resolves a caller without reading identity tables | ✅ |
| `GET /admin/org-units/:id/members` | `admin.org.manage` | A3 member panel: system roles (with id), effective scope, supervisor, cached Keycloak roles | ✅ |
| `GET /admin/keycloak/roles` \| `/groups` \| `/users?q=` | `admin.identity.manage` | realm data for the A3 pickers | ✅ |
| `GET /admin/keycloak/users/:username/identity` | `admin.identity.manage` | that member's realm roles and groups | ✅ |
| `POST/DELETE /admin/keycloak/users/:username/roles/:role` | `admin.identity.manage` | grant / revoke a realm role. Refuses `realm-management` roles and `realm-admin` — see `KEYCLOAK_ROLE_FORBIDDEN` | ✅ |
| `PUT/DELETE /admin/keycloak/users/:username/groups/:groupId` | `admin.identity.manage` | group membership | ✅ |

---

## Group C — Request Service  (`core-service`, S3)

| Endpoint | Permission | Requirement | Status |
|---|---|---|---|
| `GET /request-types` | `request.create` | REQ-01 | ✅ |

> **Group D approval endpoints are delivered.** `GET /approvals/inbox` (includes
> work covered under a delegation), `GET /approvals/{caseId}` (margin masked
> unless the caller holds `request.sensitive.read`), `POST
> /approvals/{caseId}/decide` (rejection requires a reason),
> `POST /approvals/batch-decide` (per-case results),
> `GET/POST/DELETE /approvals/delegations`, `GET /approvals/history`,
> `GET/POST /admin/approval-matrix` (publish-only; no update path), and
> `POST /integrations/approval-cases` (service account only).
| `POST /requests` | `request.create` | draft; no number yet | ✅ |
| `PATCH /requests/{id}` | `request.create` | draft/returned only, else `409 REQ_STATE_INVALID` | ✅ |
| `POST /requests/{id}/attachments` | `request.create` | REQ-03 | ✅ |
| `DELETE /requests/{id}/attachments/{attachmentId}` | `request.create` | draft/returned only | ✅ |
| `POST /requests/{id}/submit` | `request.create` | issues the number, starts the clock, creates the approval case. Missing docs → `422 REQ_DOC_MISSING`; no supervisor → `422 ORG_SUPERVISOR_MISSING` | ✅ |
| `GET /requests?view=mine\|involved` | `request.read` | REQ-08 | ✅ |
| `GET /requests/{id}` | `request.read` | masked per SCOPE-04; out of scope → 404 | ✅ |
| `GET /requests/{id}/events` | `request.read` | REQ-07 | ✅ |
| `POST /requests/{id}/return` | `request.return` | needs ≥1 reason code (REQ-04); pauses the clock | ✅ |
| `POST /requests/{id}/resubmit` | `request.create` | same number, clock resumes | ✅ |
| `POST /requests/{id}/cancel` | `request.cancel.own` / `.any` | reason required (REQ-05) | ✅ |
| `POST /requests/{id}/hold` | `request.hold` | §7.1 amendment; in_progress only; reason required; pauses the clock | ✅ |
| `POST /requests/{id}/resume` | `request.hold` | on_hold only; clock resumes owing the same remaining hours | ✅ |
| `POST /requests/{id}/complete` | `request.complete` | | ✅ |
| `GET /reports/request-bottleneck` | `report.request.read` | REQ-09 | ✅ |
| `GET /bi/menu` | `report.dashboard.read` | CD-92: BI menu — dashboards as short-lived signed Metabase embed URLs; `settings_url` only for `admin.bi.manage` | ✅ |
| `POST /integrations/requests` | `integration.request.create` | service accounts; `"source":"system"` (REQ-10) | ✅ |
| `GET/POST /admin/request-types`, `PATCH /admin/request-types/{code}` | `admin.request-type.manage` | edits apply to new requests only | ✅ |

### Group C2 — External API  (`core-service`, 3 ก.ย. 2569)

For an outside system — a chatbot, an RPA job — to drive the whole flow, not
just raise a request. Every route is `@ServiceAccountOnly` +
`integration.request.create`, **and** carries `X-Acting-User: <email>`: the
principal is swapped to that person before any handler runs, so visibility,
`assertMayAct`, the SLA clock and the audit trail all apply to the human. The
older `POST /integrations/requests` acts as the robot instead and is left
untouched.

**The full guide, with a worked `curl` walkthrough, is
[`docs/EXTERNAL_API.md`](../../docs/EXTERNAL_API.md)** at the repository root.

| Endpoint | Permission | Requirement | Status |
|---|---|---|---|
| `GET /external/request-types` | `integration.request.create` | types the acting user may raise; `?q=`, `?department=` | ✅ |
| `GET /external/request-types/{code}/form` | `integration.request.create` | `form_schema`, `receiver_form_schema`, return reasons, receiver candidates | ✅ |
| `POST /external/requests` | `integration.request.create` | creates **and submits**; `parent_request_id` spawns a child. Send `Idempotency-Key` | ✅ |
| `GET /external/requests` | `integration.request.create` | `view=involved\|created\|incoming\|approver` | ✅ |
| `GET /external/requests/{ref}` | `integration.request.create` | `{ref}` is a uuid **or** a document number | ✅ |
| `GET /external/requests/{ref}/actions` | `integration.request.create` | what this person may do now, and the fields each needs — from the state machine, not a fixed list | ✅ |
| `POST /external/requests/{ref}/actions/{action}` | `integration.request.create` | dispatches to the same service method the web app calls | ✅ |
| `GET /external/requests/{ref}/tree` | `integration.request.create` | parent and descendants | ✅ |

---

## Group D — Approval Service  (`core-service`, S2)

| Endpoint | Permission | Requirement | Status |
|---|---|---|---|
| `GET /approvals/inbox` | `approval.decide` | includes delegated work, ordered by due | ✅ |
| `GET /approvals/{caseId}` | `approval.decide` | subject, snapshot, full chain (SCOPE-06) | ✅ |
| `POST /approvals/{caseId}/decide` | `approval.decide` | `{decision, note, snapshot_version}`; stale → `409 APV_VERSION_STALE`; wrong step → `409 APV_NOT_YOUR_TURN` | ✅ |
| `POST /approvals/batch-decide` | `approval.decide` | same reference, same pending approver; logged per case (APV-04) | ✅ |
| `GET/POST /approvals/delegations`, `DELETE /approvals/delegations/{id}` | `approval.delegate` | overlap → `409 DELEGATION_OVERLAP`; sub-delegation → `422 APV_NO_SUBDELEGATION` | ✅ |
| `GET/POST /admin/approval-matrix` | `admin.approval-matrix.manage` | POST publishes a **new version**; published versions are immutable (APV-01) | ✅ |
| `GET /approvals/history` | `approval.history.read` | CSV export (APV-06) | ✅ |
| `POST /integrations/approval-cases` | `integration.approval.create` | raise a case with no request record (APV-07) | ✅ |

### Chain calculation at submit

Read the matrix version effective on the submission date for
(company, subject type) → pick the first tier whose ceiling the amount does not
exceed → resolve each position to a person (`team_lead` from the org chart;
`cfo`/`ceo` from role holders in the active company) → drop any step the
requester would fill, shifting the rest up (APV-02) → freeze the result as
`ApprovalStep` rows with the matrix version used. Later matrix edits do not
reroute a case already in flight.

Implemented as pure functions in
`services/core-service/src/approvals/approval-chain.ts`, unit-tested against the
§8.1 worked examples.

---

## Group E — SLA & Notification  (`core-service`)

| Endpoint | Permission | Requirement | Status |
|---|---|---|---|
| `GET/PUT /admin/sla-configs` | `admin.sla.manage` | SUP-01, D-09 | ✅ |
| `GET /admin/holiday-calendars`, `PUT /admin/holiday-calendars/{companyId}` | `admin.sla.manage` | one calendar per company this sprint | ✅ |
| `GET /notifications?unread=true` | `notification.read` | | ✅ |
| `POST /notifications/{id}/read`, `POST /notifications/read-all` | `notification.read` | | ✅ |
| `GET/PUT /notifications/preferences` | any signed-in user | email is optional per event; in-app cannot be disabled | ✅ |

---

## Group F — Audit Log  (`user-service`)

| Endpoint | Permission | Notes | Status |
|---|---|---|---|
| `GET /audit-logs` | `audit.read` | filters: `actor_id`, `event_type`, `resource_type`, `resource_id`, `from`, `to` | ✅ |

**Read-only by construction.** There is no POST, PATCH, or DELETE for audit
rows anywhere in the service. The DoD check greps the generated OpenAPI for a
mutating `/audit-logs` route; finding one means the append-only guarantee has
been lost.

---

## Internal events (§11.8)

Consumed by notification now, by other modules later. Every consumer must be
idempotent — events may be redelivered. Ordering is guaranteed only within a
single request.

| Event | Fired when |
|---|---|
| `request.submitted` | `{request_id, request_no, type_code, company_id, requester_id}` |
| `request.returned` / `request.resubmitted` | includes `reason_codes` |
| `request.cancelled` / `request.completed` | |
| `approval.step.pending` | a new approver's turn — triggers "awaiting your approval" |
| `approval.completed` / `approval.rejected` / `approval.voided` | outcome, or voided by a material edit (APV-05) |
| `sla.warning` / `sla.breached` | `sla.breached` triggers escalation (SUP-02) |

---

## Business error codes (§11.9)

| Code | HTTP | Meaning |
|---|---|---|
| `COMPANY_FORBIDDEN` | 403 | caller does not belong to the company in `X-Company-Id` |
| `REQ_FIELD_MISSING` | 422 | required form fields missing (listed in `details`) |
| `REQ_DOC_MISSING` | 422 | required attachments missing |
| `REQ_STATE_INVALID` | 409 | action does not match the current status |
| `REQ_TYPE_INACTIVE` | 422 | request type disabled for this company |
| `ORG_SUPERVISOR_MISSING` | 422 | requester has no supervisor — contact an admin |
| `APV_NOT_YOUR_TURN` | 409 | not the current step, or already decided |
| `APV_VERSION_STALE` | 409 | snapshot out of date — reload before deciding |
| `APV_MATRIX_NOT_FOUND` | 422 | no effective matrix for (company, subject type) |
| `APV_NO_SUBDELEGATION` | 422 | a delegate cannot delegate onward |
| `DELEGATION_OVERLAP` | 409 | delegation window overlaps an existing one |

Extensions beyond §11.9, needed by the admin surface:

| Code | HTTP | Meaning |
|---|---|---|
| `ROLE_IN_USE` | 409 | a role with holders may be deactivated, not deleted |
| `ORG_UNIT_CYCLE` | 422 | re-parenting would put a unit under its own descendant |
| `IDEMPOTENCY_KEY_REUSED` | 409 | same key replayed with a different body |
| `APV_MATRIX_NOT_FOUND` | 422 | no published, effective ladder for this company and subject type |
| `APV_NOT_YOUR_TURN` | 409 | you are not the current approver, and hold no delegation from them |
| `APV_NO_SUBDELEGATION` | 422 | a delegate may not delegate onward (APV-03) |
| `KEYCLOAK_ADMIN_UNAVAILABLE` | 503 | the Admin API is unreachable, or the service account lacks its `realm-management` roles. A distinct code so the UI can say "not configured" — Keycloak data enriches screen A3, it is never a dependency |
| `KEYCLOAK_ROLE_FORBIDDEN` | 403 | refusing to grant a role that would confer control of Keycloak itself |

---

## Deviations from §11 as written

1. **Base path is `/api`, not `/api/v1`.** Inherited from the existing service
   bootstrap. Adding the version segment is a one-line change in each
   `main.ts`; decide before any external consumer integrates.
2. **`pending_org_assignment`** added to `GET /auth/me` — see Group A.
3. **Three extra error codes** for the admin surface, listed above.

Any endpoint added beyond this document must record its reason in the PR.
