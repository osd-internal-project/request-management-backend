# Data model

CTD spec §10, as implemented in `libs/prisma/schema.prisma`. That file is the
source of truth; this is the map and the reasoning.

## Rules that hold everywhere

1. **`companyId` on every transactional table** (D-11). Multi-company is not a
   later migration.
2. **No hard deletes of transactional data.** Status columns and soft-delete
   timestamps only — a cancelled request stays findable with its reason.
3. **Form data is JSON** validated against the JSON Schema declared in
   `RequestType`, so adding the 3rd..30th request type needs no migration
   (REQ-01).
4. **Append-only means no write path**, not just no habit: `AuditLog` and
   `RequestEvent` have no update or delete method on their repositories and no
   route that reaches one.
5. **Audit columns** `createdAt/By`, `updatedAt/By` on transactional tables.

---

## Identity & Org

| Model | Purpose |
|---|---|
| `Company` | code, name, `docPrefix` (feeds the request number), base currency |
| `User` | mirror of the Keycloak user; **owns** `orgUnitId` and `supervisorUserId` because LDAP authenticates only (D-07/D-08). Null org unit = the "รอจัดสังกัด" queue |
| `UserCompany` | multi-company membership with one primary (AUTH-05) |
| `OrgUnit` | the org chart: company / department / team, with a manager |
| `OrgClosure` | ancestor–descendant closure of `OrgUnit`, with depth |
| `Role`, `Permission`, `RolePermission` | RBAC. `Permission` mirrors the code-declared catalog for referential integrity |
| `UserRole` | role binding **per company** (ROLE-04), tagged `KEYCLOAK_MAPPING` or `MANUAL` |
| `KeycloakRoleMapping` | Keycloak claim role → system role, per company (ROLE-03) |
| `ScopeRule` | (role, resource) → scope level (SCOPE-01) |
| `SensitiveFieldRule` | (resource, field) → the permission that unmasks it (SCOPE-04) |

### Why `OrgClosure` exists

Scope `team` and `department` mean "everyone below me, all levels". Resolving
that by walking `parentId` on every list query is a recursive lookup per
request; §6.2 calls for a closure table instead, so the query becomes an
`IN (…)` against an indexed column. That is the difference between meeting
NFR-02 (2 s at 100k requests) and not.

The closure is a **full rebuild per company** inside the same transaction as
any org edit. Incremental patching would have to handle re-parenting subtrees
correctly — the kind of code that is subtly wrong for months before anyone
notices a manager seeing the wrong team. Org edits are rare and admin-driven,
so the rebuild is cheap in exchange for being obviously correct.

The `source` column on `UserRole` is what makes ROLE-03 revocation work: mapped
grants are replaced wholesale on every login, while an admin's manual grant
survives.

---

## Request

| Model | Purpose |
|---|---|
| `RequestType` | configuration: receiving unit, `formSchema`, `requiredDocs`, `returnReasonCodes`, `approvalPolicy`, SLA, active flag |
| `RequestTypeCompany` | which companies have a type switched on |
| `Request` | the request. `requestNo` null until submit; `typeSnapshot` freezes the config it was submitted under |
| `RequestAttachment` | soft-deletable; the row survives for the trail |
| `RequestReturnReason` | standard codes, so "why do requests bounce" is reportable (REQ-04) |
| `RequestEvent` | append-only timeline, `@@unique([requestId, seq])` |
| `DocNumberConfig` | number pattern per company and type |
| `DocNumberCounter` | the sequence, `@@unique([companyId, typeCode, yearMonth])` |

### Two fields worth understanding

**`requesterOrgUnitId` is snapshotted at submit.** Scope filters on it, so if it
pointed at the live user record, moving someone between teams would
retroactively change who can see their old requests. History should not rewrite
itself.

**`typeSnapshot`** holds the `RequestType` config as it stood at submit. An
admin editing a request type must not change the rules a request already in
flight is being judged by (REQ-01).

`DocNumberCounter`'s unique key is what makes REQ-02's concurrency test pass:
the counter is incremented under a row lock inside the submit transaction, so
50 simultaneous submits produce 50 distinct numbers.

---

## Approval

| Model | Purpose |
|---|---|
| `ApprovalMatrix` | ceilings and chains per (company, subject type), versioned with an effective date. Published versions are immutable (APV-01, D-18) |
| `ApprovalCase` | one thing awaiting approval. `subjectType`/`subjectId` keep it generic — APV-07 raises cases with no request behind them |
| `ApprovalStep` | the resolved chain, frozen at submit. `decidedByUserId` + `delegationId` record approval-on-behalf |
| `Delegation` | temporary authority transfer with a window (APV-03) |

`ApprovalCase.snapshotHash` is how APV-05 works: a decision is bound to the data
it was made against, so a material edit afterwards voids the approval instead of
silently carrying it forward.

`ApprovalStep` keeps both `approverUserId` (who should decide) and
`decidedByUserId` (who did) so the history names both people in a delegation,
never just the delegate.

---

## Support

| Model | Purpose |
|---|---|
| `SlaConfig` | hours per type per company, business-hours flag, warning lead time (D-09) |
| `SlaClock` | `startedAt`, `pausedAt`, `accumulatedMs`, `dueAt`, state |
| `HolidayCalendar` | one per company this sprint; no shifts (§09) |
| `Notification`, `NotificationDeliveryLog` | in-app + email, every send logged (SUP-03) |
| `AuditLog` | one append-only log for everything (SUP-04) |
| `IdempotencyKey` | replay protection for state-changing POSTs (NFR-03) |

`SlaClock` accumulates elapsed time rather than storing a single deadline
because the clock **pauses** while a request sits returned with its requester
(SUP-01). Time the request was nobody's to act on should not count against
anyone in the bottleneck report.

`NotificationDeliveryLog` exists specifically to settle "I never got notified" —
that is the acceptance criterion, not a nice-to-have.

---

## Migrations

| Migration | Contents |
|---|---|
| `20260824064211_create_table` | the original placeholder `users` table |
| `20260824120000_ctd_foundation` | everything above — 30 tables, 11 enums, zero destructive operations |

The foundation migration only **adds**: it extends `users` with org and profile
columns and creates the rest. It was applied against an empty `users` table, so
the non-null `displayName` and the unique `username` constraint carried no risk.
Re-running it elsewhere against a populated `users` table would need a default
or a backfill first.

Seed with `npm run prisma:seed` — two companies, the six §5.2 roles with their
permissions and scope rules, the mockup org tree, the sensitive-field rules,
and an approval matrix whose **ceilings are placeholders** pending open
question A.
