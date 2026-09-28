# Administrator guide

For whoever runs this system day to day. Written against the screens as they
exist, not as they were planned — where something cannot be done from a screen,
that is said plainly rather than left to be discovered.

## The one rule that explains most of the screens

**Who is in a role is decided in Keycloak. What a role may do is decided here.**

That split (D-07, ROLE-03) is the source of most confusion:

- Removing someone from a role in this system and not in Keycloak **does not
  stick** — mapped grants are rewritten wholesale at their next login.
- Changing a role's permissions here takes effect on the **next API call**. The
  menu they see follows within one access-token lifetime (15 min).

---

## First-day setup, in order

Each step depends on the one before it.

### 1. Companies and the org chart — `ผังทีมและสิทธิ์ › ผังทีม`

Build the tree before anything else. It is the source of truth for "who is
whose supervisor", which drives data scope, **approval step 1**, and escalation
(D-08).

> Until a requester has a supervisor, submitting fails with
> `ORG_SUPERVISOR_MISSING`. That is deliberate — the alternative is a request
> nobody is responsible for — but it means nobody can submit until the tree is
> populated.

New people appear under **`รอจัดสังกัด`** after their first login. They cannot
submit anything until you place them.

### 2. Keycloak mappings — `ผังทีมและสิทธิ์ › Keycloak Mapping`

Map each realm role (`crm-team-lead`, `crm-pricing`, …) to a system role, per
company. Until a mapping exists, people log in successfully and hold **no
roles**, which looks like a broken login and is not.

Saving here changes nothing for anyone already signed in.

### 3. Roles and permissions — `ผังทีมและสิทธิ์ › Role และ Permission`

Seven roles ship seeded (§5.4). Tick permissions from the catalog and save.

Two rules the system enforces and will not let you talk it out of:

- A role with holders **cannot be deleted**, only deactivated (ROLE-02).
- A role holding any `admin.*` permission **cannot also hold**
  `approval.decide` or `request.sensitive.read` (§5.4 guardrail 1). Configuring
  the system and acting under it are separate jobs. The screen greys those
  boxes; the API refuses the save with 422 either way.

**`+ ผูกมือ`** binds someone by hand for an emergency. It shows as `ผูกมือ` and
is the only kind you can withdraw here — `จาก Keycloak` grants are withdrawn in
Keycloak.

### 4. Data scope — `ผังทีมและสิทธิ์ › Scope Rules`

Each (role, data type) pair gets `own` · `team` · `department` · `company` ·
`all`. Takes effect immediately.

> **Saving replaces the whole table.** A rule you delete from the screen is
> gone. A role with no row sees only its own records — safe, but it looks like
> a broken screen when it is a deliberate floor.

### 5. Approval authority — `ตารางอำนาจอนุมัติ`

Ceilings and chains per company and work type (D-18). A published version is
**immutable** (APV-01); changing authority means publishing a new version.

The standard route (§8.1): team lead on every request → CFO above T1 → CEO
above T2. **Nobody approves their own request.**

The seeded T1/T2 figures are placeholders pending open question A — confirm
them with Finance before go-live (D-09).

### 6. Request types — `ประเภทคำขอ`

A request type is configuration: form fields, required documents, SLA,
receiving team, which companies have it switched on (REQ-01). Adding the third
type needs no deploy — verified by creating **NDA** entirely through the screens
and submitting `OSD-NDA-202608-0001` with no code change.

New types start **inactive**. Turn one on once its form and documents are
settled.

> Saving affects **new requests only**. Anything already in the ladder keeps
> the configuration it was raised under (`typeSnapshot`), which is why there is
> no "apply to existing" button anywhere.

Mark a field **ฟิลด์อ่อนไหว** to hide it from anyone without
`request.sensitive.read`. The field is *removed from the API response*, not
hidden with styling — it cannot be read from the page source (SCOPE-04).

**คำขอย่อยที่ต้องสร้าง** lists the child types a receiver raises under a
request of this type. Each entry is either **บังคับ** or optional:

- The receiver sees the list as a banner on the request, with a สร้าง button
  per entry that opens the new-request form with the parent and type filled in.
- `complete` answers `409 REQ_SUB_REQUEST_MISSING` while a required entry has
  no child. A cancelled child does not count. The existing rule still applies:
  every child must be closed first (`REQ_CHILDREN_OPEN`).
- A type on the list may be raised from its parent even by someone outside its
  eligible groups.
- A type that another type lists cannot be deleted (`REQ_TYPE_IN_USE`).
- The list is part of `typeSnapshot`, so editing it affects new requests only.
  Requests submitted before the list existed have none.

This is an addition to the source specification, not part of §16 A2.

**ขั้นตอน (step flow)** splits the work of one type into steps inside
`in_progress`, for example ตรวจเอกสาร → ติดตั้ง → ทดสอบ. Each step can have:

- its own form, answered before the step is left
- its own sub-request checklist (counted only for children raised in that step)
- an exit approval, whose ladder is published first for `request:<CODE>:step:<STEP>`
- an assignee rule: keep the current person, hand it to the requester, or name someone

Forward exits are tried in order and the first whose condition holds wins, so
the last forward exit of a branching step has no condition. Backward exits
send the work back without checking the form. A step with no forward exit is
where `ทำเสร็จแล้ว` happens, followed by the usual after-work check.

Flows are versioned like approval ladders: publishing writes version N+1 and a
request keeps the version it was submitted under. A type with no published
flow behaves exactly as before.

### 7. SLA — `sla-configs`

Hours per type per company, with a warning lead time (D-09). The clock measures
**the team's working time only**:

- it starts at the first assignment (receive or assign), not at submit
- it pauses on hold, on return to the requester, while waiting on a step's exit
  approval, and after `complete` while the result is being checked
- a send-back after the check resumes it, so rework is counted
- it stops when the result is accepted or refused; met/breached is judged from
  the working time actually used against the budget

Approval time has its own budget: each ladder level can set `slaHours`, which
becomes the step's deadline.

Escalation climbs in tiers, `escalatePercents` on the SLA config (default 100
and 150). Each tier notifies the holder, the approver it waits on, and the
requester, plus one more head above the holder. An approval step past its
deadline reminds its candidates, and half a budget later tells their heads.

---

## Reading the audit log — `Audit Log`

Every identity and status change is here, written **inside the same transaction
as the change** — a change cannot commit without its audit row.

Filter by actor, event type, resource type, or time range. The filters live in
the URL, so a filtered view is a link you can send to someone.

Role, permission, and scope changes record **before → after** (ROLE-05).

> There is no edit and no delete, on the screen or in the API. The log is
> append-only (SUP-04) and CI fails the build if a mutating route ever appears.

---

## Things that cannot be done from a screen

Said here so nobody spends an afternoon looking:

| Want to | Where |
|---|---|
| Add or remove a **person** from a role | Keycloak (or `+ ผูกมือ` for an emergency) |
| Add a **new permission** to the catalog | Code only — it ships with the endpoint it protects, so a permission nothing enforces cannot exist |
| Delete a role | Not possible. Deactivate it |
| Edit or delete an audit entry | Not possible, by design |
| Change a published approval matrix version | Not possible. Publish a new version |
| Download an attachment | Not yet — attachments are metadata only until object storage is connected (open question G) |
| Send a real email | Not yet — SMTP settings are open question B |

---

## When something looks broken

| Symptom | Cause | Fix |
|---|---|---|
| Every page says `ไม่สามารถตรวจสอบสิทธิ์ได้` | `/internal/policy/resolve` timed out | Check user-service is up. It is slow on a cold start (see NFR-02 in [`security-checklist.md`](./security-checklist.md)) |
| Login works, no menu | The user has no roles | Add a Keycloak mapping, or bind by hand |
| `ORG_SUPERVISOR_MISSING` on submit | The requester has no supervisor | Place them in the org chart |
| A permission change had no effect | The menu lags the token | Their next API call is already correct; the menu follows within 15 min |
| A role edit was refused with 422 | §5.4 guardrail 1 | Split configuration and approval authority into separate roles |
| Someone you removed still holds a role | The grant came from Keycloak | Remove it there |

---

## Commands

```
yarn prisma:seed        # companies, the seven roles, scope rules, the mockup org tree
yarn keycloak:provision # realm roles and mappings
yarn admin:grant        # grant admin to one account, for bootstrapping
yarn spec:check         # differences between the source specification and this repo
yarn openapi            # regenerate docs/openapi/*.json from the running routes
```
