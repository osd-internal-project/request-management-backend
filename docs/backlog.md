# Remaining work — audited against the code, 25 Aug 2026

Derived from `docs/ctd-foundation-spec.md` by checking each requirement against
what the repository actually contains, not against what the status column
claimed. Every 🟡 below means the route and its permission are declared and
appear in the OpenAPI, but the handler throws `501` naming its requirement.

**S1 is done.** AUTH-01…07, ROLE-01…06, SCOPE-01…06, SUP-04 — implemented and
verified against a running system.

Everything else on this page is open.

---

## What is already built that this work stands on

Worth knowing before estimating anything: the schema and the two most
error-prone rule sets already exist. The 501s overstate how much is missing.

| Asset | Where | Covers |
|---|---|---|
| Request state machine | `services/core-service/src/requests/request-state-machine.ts` | §7.1 transitions, when the number is issued, when the SLA clock runs, what stays editable |
| Approval chain rules | `services/core-service/src/approvals/approval-chain.ts` | §8.1 — `selectTier`, `resolveChain`, `assertStepOneResolvable`, including "nobody approves their own request" |
| All 17 tables | `libs/prisma/schema.prisma` | Request, RequestType, RequestEvent, RequestAttachment, ApprovalMatrix/Case/Step, Delegation, SlaConfig, SlaClock, HolidayCalendar, Notification, DocNumberConfig/Counter, IdempotencyKey |
| Scope filter | `libs/share/src/policy/scope.ts` | SCOPE-02 — every list must go through `buildScopeWhere` |
| Masking | `libs/share/src/policy/sensitive-field.interceptor.ts` | SCOPE-04/05 — declare `@SensitiveResource(...)` on a handler, do not filter by hand |
| Audit | `services/user-service/src/audit/` | SUP-04 — append-only |
| Idempotency | `libs/share/src/http/idempotency.interceptor.ts` | NFR-03 — every state-changing POST |

**Two items have no code at all**, despite their tables existing:

- **REQ-02 document numbering** — `DocNumberConfig` and `DocNumberCounter` are
  empty tables and nothing issues a number. Nothing can be submitted until this
  exists.
- **SUP-01 SLA clock** — `SlaConfig`, `SlaClock`, `HolidayCalendar` likewise.

---

## S2 — Approval Engine — **DELIVERED 25 Aug 2026**

Verified end to end against a running system, driven through APV-07. What
remains: **APV-06 has no export**, and **SUP-03's email half is unverified**
because there is still no SMTP (open question B). Everything else below is
implemented and tested.

Approval is a **separate central service** (D-31) and is callable with no
Platform Request behind it (APV-07). That means S2 can be built and verified
before S3 exists — raise cases through `POST /integrations/approval-cases` and
decide them from the inbox.

| Code | What it demands | Build on | Notes |
|---|---|---|---|
| **APV-01** | Matrix of ceilings and approvers per (company, subject type, amount band + currency), versioned with effective dates. **Published versions immutable.** | `ApprovalMatrix` table | Immutability is what lets an in-flight case keep the matrix it started under. No update path — editing means publishing version N+1. |
| **APV-02** | Chain computed by the system at submit. The requester cannot choose approvers. Nobody approves their own request. | `approval-chain.ts` — **already written and tested** | The work is persistence and transactions, not the rules. |
| **APV-03** | Temporary delegation with a date window. **Pending** work re-routes, not only new work. History names both people. **No sub-delegation.** | `Delegation`, `ApprovalStep.decidedByUserId` + `delegationId` | The schema already carries both names — the delegate's must never appear alone. |
| **APV-04** | Batch approval for cases sharing a reference, per-case results and logs. | — | Each case its own transaction: one failure must not roll back the rest. |
| **APV-05** | A decision is bound to a data snapshot; a material edit voids it and forces a new route. | `ApprovalCase.snapshotHash`, `snapshotVersion` | Without this an approver's decision silently attaches to numbers they never saw. |
| **APV-06** | Authority-usage report, exportable, permission-restricted. | `approval.history.read` | |
| **APV-07** | Any module raises a case with no request behind it; result published as an event. | `ApprovalCase.requestId` nullable, `callbackEvent`; endpoint already `@ServiceAccountOnly()` | Also the test harness for the whole sprint. |
| **SUP-03** | In-app + email for awaiting approval, returned, decided, nearing due, overdue. Every send logged. | `Notification`, `NotificationDeliveryLog` | **Blocked in part** — see open question B. |

**Screens:** `/admin/approval-matrix` and `/approvals` are both placeholders.
§8 requires the decision view to show requester, amount, reason, attachments
and margin-if-permitted **above** the buttons, and rejection always to demand a
reason. NFR-05: most approvers decide from a phone.

---

## S3 — Platform Request — **core delivered 26 Aug 2026**

Working end to end against the database: REQ-01, REQ-02, REQ-03, REQ-04,
REQ-05, REQ-07, REQ-08 and SUP-01. Screen §16 หน้าที่ 2 is the landing page and
shows real numbers, chain position and SLA badges.

**Still open:** REQ-06 (`ref_type`/`ref_id` beyond storage), REQ-09 (bottleneck
report), REQ-10 (integration submit), SUP-02 (overdue escalation), attachment
upload (open question G), and screens หน้าที่ 3, หน้าที่ 4, A2.

| Code | What it demands | Build on | Notes |
|---|---|---|---|
| **REQ-01** | Request types are configuration: receiving team, form schema, required documents. Adding the 3rd..30th type needs no migration. | `RequestType.formSchema` | Six 501s — the largest single item. |
| **REQ-02** | Number issued at submit, `{PREFIX}-{TYPE}-{YYYYMM}-{SEQ}`, sequence resets monthly. | `DocNumberConfig`, `DocNumberCounter` | **No code exists.** Must be transactional under concurrency — no duplicate numbers (NFR-03). Blocks every submit. |
| **REQ-03** | Required fields and documents block submit, naming what is missing. | `state-machine.ts` | `REQ_DOC_MISSING`, 422. |
| **REQ-04** | Returns pick from a standard reason list plus free text, so bounce causes are countable. | `RequestEvent` | The list is the point — free text alone cannot be reported on. |
| **REQ-05** | Cancel by requester or someone above them, with a reason. **Never deleted.** | soft-delete convention | |
| **REQ-06** | Requests reference an originating entity (`ref_type`/`ref_id`). | `Request` | |
| **REQ-07** | Append-only timeline of every status change: time, actor, before → after. | `RequestEvent` | |
| **REQ-08** | One screen for "my requests" and "awaiting my approval" across all types. | `buildScopeWhere` | NFR-02: 2 s at 100,000 requests. |
| **REQ-09** | Bottleneck report — real time per step by type, approver, period. | `RequestEvent`, `ApprovalStep` | |
| **REQ-10** | API for systems to raise requests via a service account; marked as system-sourced. | already `@ServiceAccountOnly()` | REQ-10's provenance is why AUTH-06 is enforced in both directions. |
| **REQ-11** | Both pilot types running end to end on UAT with real sales users. | — | ⬜ The phase-1 target. Everything above is in service of this. |
| **SUP-01** | SLA clock per type. Starts at submit, pauses on return, resumes on resubmit. One holiday calendar per company. | `SlaConfig`, `SlaClock`, `HolidayCalendar`; `CLOCK` in `state-machine.ts` | **No code exists.** |
| **SUP-02** | Overdue escalation to the owner plus one level up, recorded. | `OrgClosure` | |

**Screens:** `/requests`, `/requests/new`, `/requests/[id]`,
`/admin/request-types`, `/reports/bottleneck` — all placeholders.

---

## Blockers not solvable by writing code

| # | Blocker | Owner | What it stops |
|---|---|---|---|
| **A** | Real T1/T2 approval ceilings unconfirmed | Finance / CFO | S2 and S3 **go-live**. Development proceeds on placeholders — nothing in the seed should be mistaken for a signed-off number. |
| **B** | No SMTP host, port, or sending account | Infra | SUP-03's email half. In-app notification is fully testable; email ships behind an interface with a logging transport and stays unverified. |
| **E** | No test accounts per role and company | PO / IT | UAT of the full ladder — verifying CFO and CEO tiers needs people holding those roles. |

Open questions A, B, D, E and F…K are tracked in `docs/open-questions.md`.

---

## Suggested order

1. **S2 Approval Engine** — buildable and verifiable now via APV-07, with no
   dependency on S3.
2. **REQ-02 numbering + REQ-01 type configuration** — the two things every
   submit depends on.
3. **The request lifecycle** — REQ-03…08, on top of a working approval engine.
4. **SUP-01/02, then REQ-09** — the clock, escalation, and the report that
   reads from both.
5. **REQ-11** — the pilot types end to end on UAT, which is the actual goal.
