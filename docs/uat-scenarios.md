# UAT scenarios (§14)

Five scenarios covering the flow end to end. Each step names **what to check in
the database**, not just what the screen shows — the Definition of Done treats a
rendered page as unproven until a row backs it.

**Status: written, not yet run with business users.** Every role now has an
account, so nothing blocks a run. What is recorded below under "already proven"
was verified during development with `uatadmin`.

---

## Accounts

Provisioned by `UAT_SEED_ALLOW=1 UAT_DEFAULT_PASSWORD=… yarn uat:users`, which
creates them in Keycloak, places them in the mockup A3 org tree, and wires the
supervisor chain that approval step 1 resolves against. Re-runnable.

| Role | Purpose | Account |
|---|---|---|
| Sales employee | submit a discount request | ✅ `uat.somchai` (GETTER1) |
| Team lead | approval step 1 | ✅ `uat.somying` (GETTER1, heads it) |
| Department manager | department-level scope | ✅ `uat.wichai` (SALES) |
| Receiver (Pricing) | return, complete | ✅ `uat.pricing` (PRICING) |
| CFO | approve above T1 | ✅ `uat.cfo` (FIN) |
| CEO | approve above T2 | ✅ `uat.ceo` (ROOT) |
| Admin | configuration | ✅ `uatadmin` |
| Auditor | read the audit log | ✅ `uat.auditor` (ROOT) |

`uat.somchai` → `uat.somying` → `uat.wichai` → `uat.cfo` → `uat.ceo` is the
supervisor chain, so a discount request above the T2 ceiling routes to three
different people rather than resolving the same executive twice.

One further account, `uatadmin`, can be widened to every screen and every row
with `UAT_SEED_ALLOW=1 yarn uat:seed`. That grants the `uat_superadmin` role,
which breaks the §5.4 separation-of-duties guardrail on purpose — see open
question L. Use it to walk the UI, never to judge whether a permission works.

---

## UAT-1 — Submit a discount request and approve it (REQ-01…03, APV-02, AUTH-01)

The core path. If only one scenario is run, run this one.

1. Sales employee signs in with SSO.
   → `audit_logs` has `auth.login.succeeded` for them.
2. Submit a discount request under T1, with an attachment.
   → `requests.request_no` matches `OSD-DSC-YYYYMM-NNNN`
   → `requests.status = 'submitted'`, `sla_clocks.state = 'running'`
   → one `request_attachments` row
3. The submit screen showed the chain **before** submitting.
   → the chain shown matches the `approval_steps` rows created
4. Team lead approves.
   → `approval_steps.decision = 'approved'` with `decided_at`
   → `requests.status = 'approved'`
5. Timeline shows every step with who and when.
   → `request_events` ordered by `seq`, no gaps

**Already proven in development:** steps 1–3 and 5. `OSD-DSC-202608-0023` was
raised, numbered, chained and timelined. Step 4 needs a second account, since
nobody approves their own request.

## UAT-2 — Amount crosses a ceiling, the chain grows (APV-01, APV-02, D-18)

Proves authority is data, not code.

1. Submit **below** T1 → chain is one step (team lead).
2. Submit **above** T1 → chain is team lead → CFO.
3. Submit **above** T2 → chain is team lead → CFO → CEO.
   → `approval_cases.matrix_version` is the same version in all three
   → `approval_steps` count is 1 / 2 / 3
4. Publish a new matrix version with different ceilings; the three requests
   already in flight keep their original chain.
   → their `matrix_version` is unchanged (APV-01 immutability)

**Blocked:** needs CFO and CEO accounts.

## UAT-3 — Return and resubmit; the SLA clock pauses (REQ-04, SUP-01)

The scenario that catches SLA counting time nobody could act on.

1. Receiver returns the request with a standard reason.
   → `requests.status = 'returned'`
   → `sla_clocks.state = 'paused'`, `paused_at` set
   → a `request_return_reasons` row with the code
2. Leave it returned for a measurable interval.
   → `accumulated_ms` does **not** grow while paused
3. Requester edits and resubmits.
   → `status = 'submitted'`, clock `running` again
   → `accumulated_ms` resumes from where it stopped, not from zero
4. Receiver completes.
   → `requests.status = 'completed'`, `sla_clocks.state = 'met'`

**Blocked:** needs a Receiver account. `request.complete` is held only by the
`receiver` role (§5.4) — a gap found during this pass, when that role was
missing from the seed entirely and nobody could complete anything.

## UAT-4 — Sensitive fields and scope (SCOPE-01…04)

The scenario an auditor cares about most.

1. Sales employee opens their own request → sees `margin`.
2. A peer in the same team opens it → `margin` shows as `••••••`.
   → confirm in the **network response**, not the page: the field is absent
     from the JSON, not hidden with styling
3. The same peer opens a request from **another company** → 404 or
   `COMPANY_FORBIDDEN`, never a row.
4. Reading a sensitive field is itself recorded.
   → `audit_logs` has `scope.sensitive_field.read`

**Already proven in development:** step 2 — `มาร์จิ้นโดยประมาณ (%) ••••••`, with
the field verified absent from the payload. Steps 1, 3, 4 need a second account
in a second company.

## UAT-5 — Administration without a deploy (REQ-01, ROLE-02, ROLE-05, SUP-04)

Proves the system is configuration-driven, which is the whole premise.

1. Admin creates a **new request type** from the screen, sets its form,
   documents and SLA, and activates it.
   → a `request_types` row, no migration, no restart
2. Someone submits under the new type successfully.
   → `request_no` carries the new type code
3. Admin adds a permission to a role and saves.
   → the holder's **next API call** already behaves differently
   → `audit_logs` `role.updated` carries `before` and `after`
4. Admin tries to give the `admin` role `approval.decide`.
   → **refused with 422**, message naming §5.4
   → refused for a direct API call too, not only the screen
5. Admin tries to delete a role that has holders.
   → no delete exists — only deactivate (ROLE-02)
6. Auditor filters the audit log by actor and time range.
   → every step above appears; nothing can be edited or removed

**Already proven in development:** steps 1, 2 (type **NDA** created entirely
through the API, `OSD-NDA-202608-0001` submitted, no code changed), 3, 4 (422
confirmed on both forbidden combinations, and a normal edit still returns 200),
and 5 (no delete route exists). Step 6 needs an Auditor account.

---

## Recording a run

For each scenario record: date, who ran it, accounts used, pass/fail per step,
and the row that proves it. Attach the NFR-02 performance figures to the same
report (§14), which requires the load-test set:

```
yarn loadtest:seed     # inserts 100,000 tagged requests
yarn loadtest:clean    # removes every one of them afterwards
```

> Those scripts exist but **have not been run**. NFR-02 is therefore unmeasured
> at 100,000 rows. What is known: `/internal/policy/resolve` takes 1.5–6 s at
> 26 rows, having been cut from 17.3 s by fixing an N+1, and it sits in front of
> every page — so it is the first thing to measure, and the likeliest failure.
